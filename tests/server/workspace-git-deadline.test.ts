import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fsGate = vi.hoisted(() => ({
  blockedName: null as string | null,
  inspectedPaths: [] as string[],
  markBlockedInspection: null as (() => void) | null,
  beforeInspection: null as ((path: string) => void) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      fsGate.inspectedPaths.push(path);
      fsGate.beforeInspection?.(path);
      if (path.split(/[\\/]/u).at(-1) === fsGate.blockedName) {
        fsGate.markBlockedInspection?.();
        return await new Promise<never>(() => undefined);
      }
      return await actual.lstat(...args);
    },
  };
});

import { discoverWorkspaceGitRepositories } from "../../src/server/workspace-git";
import type { RuntimeSecureFileBroker } from "../../src/server/secure-files";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  fsGate.blockedName = null;
  fsGate.inspectedPaths = [];
  fsGate.markBlockedInspection = null;
  fsGate.beforeInspection = null;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace Git traversal deadline", () => {
  it("does not spend the discovery deadline inspecting directories beyond its traversal budget", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-workspace-budget-")));
    roots.push(root);
    mkdirSync(join(root, "a-included"));
    mkdirSync(join(root, "z-blocked"));
    fsGate.blockedName = "z-blocked";

    const snapshot = await discoverWorkspaceGitRepositories(root, {
      maxDirectories: 2,
      deadlineAt: Date.now() + 500,
    });

    expect(snapshot.scannedDirectories).toBe(2);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.skippedDirectories).toBe(1);
    expect(fsGate.inspectedPaths).toEqual([join(root, "a-included")]);
  });

  it("spends entry inspection work on directories instead of ordinary files", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-workspace-file-probes-")));
    roots.push(root);
    const nested = join(root, "sources");
    mkdirSync(nested);
    for (let index = 0; index < 128; index += 1) {
      writeFileSync(join(root, `file-${index}.txt`), "workspace file\n");
      writeFileSync(join(nested, `source-${index}.ts`), "export {};\n");
    }

    const snapshot = await discoverWorkspaceGitRepositories(root, {
      deadlineAt: Date.now() + 5_000,
    });

    expect(snapshot.scannedDirectories).toBe(2);
    expect(snapshot.partial).toBe(false);
    expect(fsGate.inspectedPaths).toEqual([nested]);
  });

  it("rechecks a directory that becomes a symlink after enumeration", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-workspace-directory-swap-")));
    const outside = mkdtempSync(join(tmpdir(), "inertia-workspace-directory-outside-"));
    roots.push(root, outside);
    const nested = join(root, "sources");
    mkdirSync(nested);
    mkdirSync(join(outside, ".git"));
    fsGate.beforeInspection = (path) => {
      if (path !== nested) return;
      fsGate.beforeInspection = null;
      rmSync(nested, { recursive: true });
      symlinkSync(outside, nested, process.platform === "win32" ? "junction" : "dir");
    };

    const snapshot = await discoverWorkspaceGitRepositories(root);

    expect(snapshot.scannedDirectories).toBe(1);
    expect(snapshot.skippedDirectories).toBe(1);
    expect(snapshot.repositories).toEqual([]);
    expect(fsGate.inspectedPaths).toEqual([nested]);
  });

  it("rejects at the aggregate deadline when one entry inspection stalls", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const root = mkdtempSync(join(tmpdir(), "inertia-workspace-entry-deadline-"));
    roots.push(root);
    mkdirSync(join(root, "blocked"));
    fsGate.blockedName = "blocked";
    let markBlockedInspection!: () => void;
    const blockedInspection = new Promise<void>((resolve) => {
      markBlockedInspection = resolve;
    });
    fsGate.markBlockedInspection = markBlockedInspection;

    const discovery = expect(discoverWorkspaceGitRepositories(root, {
      deadlineAt: Date.now() + 40,
    })).rejects.toThrow("Workspace repository discovery took too long.");
    await blockedInspection;
    await vi.advanceTimersByTimeAsync(40);
    await discovery;
    expect(fsGate.inspectedPaths.some(
      (path) => path.split(/[\\/]/u).at(-1) === fsGate.blockedName,
    )).toBe(true);
  });

  it("aborts a stalled secure-root authorization at the aggregate deadline", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const root = mkdtempSync(join(tmpdir(), "inertia-workspace-auth-deadline-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    let observedSignal: AbortSignal | undefined;
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve;
    });
    const secureFiles: RuntimeSecureFileBroker = {
      authorizeRoot: vi.fn(async (_path: string, signal?: AbortSignal) => {
        observedSignal = signal;
        markAuthorizationStarted();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          }, { once: true });
        });
      }),
      verifyRoot: vi.fn(),
      read: vi.fn(async () => {
        throw new Error("unused");
      }),
      replace: vi.fn(async () => {
        throw new Error("unused");
      }),
    };

    const discovery = expect(discoverWorkspaceGitRepositories(root, {
      deadlineAt: Date.now() + 40,
      secureFiles,
    })).rejects.toThrow("Workspace repository discovery took too long.");
    await authorizationStarted;
    await vi.advanceTimersByTimeAsync(40);
    await discovery;
    expect(observedSignal?.aborted).toBe(true);
    expect(secureFiles.verifyRoot).not.toHaveBeenCalled();
  });
});

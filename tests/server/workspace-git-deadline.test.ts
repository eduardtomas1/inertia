import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fsGate = vi.hoisted(() => ({
  blockedPath: null as string | null,
  inspectedPaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      fsGate.inspectedPaths.push(path);
      if (path === fsGate.blockedPath) {
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
  fsGate.blockedPath = null;
  fsGate.inspectedPaths = [];
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace Git traversal deadline", () => {
  it("rejects at the aggregate deadline when one entry inspection stalls", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-workspace-entry-deadline-"));
    roots.push(root);
    mkdirSync(join(root, "blocked"));
    fsGate.blockedPath = join(realpathSync(root), "blocked");

    await expect(discoverWorkspaceGitRepositories(root, {
      deadlineAt: Date.now() + 40,
    })).rejects.toThrow("Workspace repository discovery took too long.");
    expect(fsGate.inspectedPaths).toContain(fsGate.blockedPath);
  });

  it("aborts a stalled secure-root authorization at the aggregate deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-workspace-auth-deadline-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    let observedSignal: AbortSignal | undefined;
    const secureFiles: RuntimeSecureFileBroker = {
      authorizeRoot: vi.fn(async (_path: string, signal?: AbortSignal) => {
        observedSignal = signal;
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

    await expect(discoverWorkspaceGitRepositories(root, {
      deadlineAt: Date.now() + 40,
      secureFiles,
    })).rejects.toThrow("Workspace repository discovery took too long.");
    expect(observedSignal?.aborted).toBe(true);
    expect(secureFiles.verifyRoot).not.toHaveBeenCalled();
  });
});

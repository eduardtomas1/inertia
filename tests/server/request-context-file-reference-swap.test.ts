import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const swap = vi.hoisted(() => ({
  target: null as string | null,
  replacement: "",
  growAfterInspection: null as { path: string; bytes: number } | null,
  growAfterOpen: null as { path: string; bytes: number } | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const swapAfterInspection = (path: unknown): void => {
    if (swap.target === null || String(path) !== swap.target) return;
    const target = swap.target;
    swap.target = null;
    actual.rmSync(target);
    actual.symlinkSync(swap.replacement, target);
  };
  const grow = (growth: { path: string; bytes: number } | null): void => {
    if (growth) actual.appendFileSync(growth.path, "x".repeat(growth.bytes));
  };
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    const result = actual.statSync(...args);
    swapAfterInspection(args[0]);
    return result;
  }) as typeof actual.statSync;
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    const result = actual.lstatSync(...args);
    swapAfterInspection(args[0]);
    if (swap.growAfterInspection && String(args[0]) === swap.growAfterInspection.path) {
      grow(swap.growAfterInspection);
      swap.growAfterInspection = null;
    }
    return result;
  }) as typeof actual.lstatSync;
  const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
    const result = actual.fstatSync(...args);
    grow(swap.growAfterOpen);
    swap.growAfterOpen = null;
    return result;
  }) as typeof actual.fstatSync;
  const replaced = { ...actual, statSync, lstatSync, fstatSync };
  return { ...replaced, default: replaced };
});

import { assembleTurnRequest } from "../../src/server/runtime/turns/request-context";

const directories: string[] = [];

async function workspaceWithSource(content: string): Promise<{ cwd: string; source: string }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-file-reference-swap-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const source = join(cwd, "source.ts");
  await writeFile(source, content);
  return { cwd, source: realpathSync(source) };
}

function referenceSource(cwd: string) {
  return assembleTurnRequest({
    cwd,
    visibleContent: "Review the file.",
    context: { fileReferences: [{ path: "source.ts" }] },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  swap.target = null;
  swap.growAfterInspection = null;
  swap.growAfterOpen = null;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("composer file reference reads", () => {
  it.runIf(process.platform !== "win32")(
    "does not read a file outside the workspace swapped in after inspection",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-file-reference-swap-"));
      directories.push(directory);
      const cwd = join(directory, "workspace");
      await mkdir(cwd);
      const outside = join(directory, "outside.txt");
      await writeFile(outside, "outside workspace content");
      await writeFile(join(cwd, "source.ts"), "inside workspace content");
      swap.target = realpathSync(join(cwd, "source.ts"));
      swap.replacement = realpathSync(outside);

      let prompt = "";
      try {
        prompt = assembleTurnRequest({
          cwd,
          visibleContent: "Review the file.",
          context: { fileReferences: [{ path: "source.ts" }] },
        }).executionPrompt;
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(swap.target).toBeNull();
      expect(prompt).not.toContain("outside workspace content");
    },
  );

  it("still reads an ordinary workspace file reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-file-reference-swap-"));
    directories.push(directory);
    const cwd = join(directory, "workspace");
    await mkdir(cwd);
    await writeFile(join(cwd, "source.ts"), "alpha-line\nbravo-line\ncharlie-line");

    const result = assembleTurnRequest({
      cwd,
      visibleContent: "Review the file.",
      context: { fileReferences: [{ path: "source.ts", lineStart: 2, lineEnd: 3 }] },
    });
    expect(result.executionPrompt).toContain("bravo-line");
    expect(result.executionPrompt).toContain("charlie-line");
    expect(result.executionPrompt).not.toContain("alpha-line");
  });

  it("sizes the read buffer to a small file instead of the 4 MiB source limit", async () => {
    const { cwd } = await workspaceWithSource("tiny-file-content");
    const alloc = vi.spyOn(Buffer, "alloc");

    expect(referenceSource(cwd).executionPrompt).toContain("tiny-file-content");
    expect(Math.max(0, ...alloc.mock.calls.map(([size]) => size))).toBeLessThan(64 * 1024);
  });

  it("rejects a file that grows after its descriptor is opened", async () => {
    const { cwd, source } = await workspaceWithSource("original-content");
    swap.growAfterOpen = { path: source, bytes: 32 };

    expect(() => referenceSource(cwd)).toThrow("changed while it was being read");
  });

  it("rejects a file that grows past the source limit after inspection", async () => {
    const { cwd, source } = await workspaceWithSource("original-content");
    swap.growAfterInspection = { path: source, bytes: 4 * 1024 * 1024 };

    expect(() => referenceSource(cwd)).toThrow("too large to inspect safely");
  });

  it("rejects a file above the source limit", async () => {
    const { cwd } = await workspaceWithSource("x".repeat(4 * 1024 * 1024 + 1));

    expect(() => referenceSource(cwd)).toThrow("too large to inspect safely");
  });
});

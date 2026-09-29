// @inertia-test-suite portable
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type AncestorSwapTrigger =
  | "after-containment"
  | "before-final-inspection"
  | "before-final-inspection-restore-after-open"
  | "before-open";

const swap = vi.hoisted(() => ({
  target: null as string | null,
  replacement: "",
  growAfterInspection: null as { path: string; bytes: number } | null,
  growAfterOpen: null as { path: string; bytes: number } | null,
  ancestor: null as null | {
    trigger: AncestorSwapTrigger;
    file: string;
    directory: string;
    moved: string;
    outside: string;
    swapped: boolean;
  },
  reads: [] as string[],
  noFollow: null as number | null,
}));

vi.mock("../../src/node/platform-file-open-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/node/platform-file-open-flags")>();
  return {
    ...actual,
    get FILE_OPEN_NO_FOLLOW() {
      return swap.noFollow ?? actual.FILE_OPEN_NO_FOLLOW;
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const swapAfterInspection = (path: unknown): void => {
    if (swap.target === null || String(path) !== swap.target) return;
    const target = swap.target;
    swap.target = null;
    actual.rmSync(target);
    actual.symlinkSync(swap.replacement, target);
  };
  const replaceAncestor = (trigger: AncestorSwapTrigger, path: unknown): void => {
    const ancestor = swap.ancestor;
    if (!ancestor || ancestor.swapped || !ancestor.trigger.startsWith(trigger) || String(path) !== ancestor.file) return;
    ancestor.swapped = true;
    actual.renameSync(ancestor.directory, ancestor.moved);
    actual.symlinkSync(ancestor.outside, ancestor.directory, "junction");
  };
  const restoreAncestor = (path: unknown): void => {
    const ancestor = swap.ancestor;
    if (
      !ancestor?.swapped
      || ancestor.trigger !== "before-final-inspection-restore-after-open"
      || String(path) !== ancestor.file
    ) return;
    swap.ancestor = null;
    actual.unlinkSync(ancestor.directory);
    actual.renameSync(ancestor.moved, ancestor.directory);
  };
  const grow = (growth: { path: string; bytes: number } | null): void => {
    if (growth) actual.appendFileSync(growth.path, "x".repeat(growth.bytes));
  };
  const realpathSync = Object.assign(((...args: Parameters<typeof actual.realpathSync>) => {
    const result = actual.realpathSync(...args);
    replaceAncestor("after-containment", args[0]);
    return result;
  }) as typeof actual.realpathSync, { native: actual.realpathSync.native });
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    const result = actual.statSync(...args);
    swapAfterInspection(args[0]);
    return result;
  }) as typeof actual.statSync;
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    replaceAncestor("before-final-inspection", args[0]);
    const result = actual.lstatSync(...args);
    swapAfterInspection(args[0]);
    if (swap.growAfterInspection && String(args[0]) === swap.growAfterInspection.path) {
      grow(swap.growAfterInspection);
      swap.growAfterInspection = null;
    }
    return result;
  }) as typeof actual.lstatSync;
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    replaceAncestor("before-open", args[0]);
    const descriptor = actual.openSync(...args);
    restoreAncestor(args[0]);
    return descriptor;
  }) as typeof actual.openSync;
  const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
    const result = actual.fstatSync(...args);
    grow(swap.growAfterOpen);
    swap.growAfterOpen = null;
    return result;
  }) as typeof actual.fstatSync;
  const readSync = ((...args: Parameters<typeof actual.readSync>) => {
    const bytesRead = actual.readSync(...args);
    const [, buffer, offset] = args as unknown as [number, Buffer, number];
    swap.reads.push(buffer.subarray(offset, offset + bytesRead).toString("utf8"));
    return bytesRead;
  }) as typeof actual.readSync;
  const replaced = { ...actual, realpathSync, statSync, lstatSync, openSync, fstatSync, readSync };
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

function referenceSource(cwd: string, path = "source.ts") {
  return assembleTurnRequest({
    cwd,
    visibleContent: "Review the file.",
    context: { fileReferences: [{ path }] },
  });
}

async function workspaceWithNestedSource(trigger: AncestorSwapTrigger): Promise<string> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "inertia-file-reference-ancestor-")));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  const nested = join(cwd, "nested");
  const outside = join(directory, "outside");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  await writeFile(join(nested, "source.ts"), "inside workspace content");
  await writeFile(join(outside, "source.ts"), "outside workspace content");
  swap.ancestor = {
    trigger,
    file: join(nested, "source.ts"),
    directory: nested,
    moved: join(cwd, "nested-moved"),
    outside,
    swapped: false,
  };
  return cwd;
}

afterEach(async () => {
  vi.restoreAllMocks();
  swap.target = null;
  swap.growAfterInspection = null;
  swap.growAfterOpen = null;
  swap.ancestor = null;
  swap.reads = [];
  swap.noFollow = null;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe.each([
  ["with the platform no-follow flag", null],
  ["without O_NOFOLLOW, as on Windows", 0],
] as const)("composer file reference reads %s", (_label, noFollow) => {
  const useFlags = () => { swap.noFollow = noFollow; };

  it.runIf(process.platform !== "win32")(
    "does not read a file outside the workspace swapped in after inspection",
    async () => {
      useFlags();
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
        prompt = referenceSource(cwd).executionPrompt;
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(swap.target).toBeNull();
      expect(prompt).not.toContain("outside workspace content");
      expect(swap.reads.join("")).not.toContain("outside workspace content");
    },
  );

  it.each([
    "after-containment",
    "before-final-inspection",
    "before-final-inspection-restore-after-open",
    "before-open",
  ] as const)(
    "refuses a reference whose ancestor directory becomes a link outside the workspace %s",
    async (trigger) => {
      useFlags();
      const cwd = await workspaceWithNestedSource(trigger);

      expect(() => referenceSource(cwd, join("nested", "source.ts"))).toThrow();
      expect(swap.ancestor === null || swap.ancestor.swapped).toBe(true);
      expect(swap.reads.join("")).not.toContain("outside workspace content");
    },
  );

  it("still reads an ordinary nested workspace file reference", async () => {
    useFlags();
    const cwd = await workspaceWithNestedSource("before-open");
    swap.ancestor = null;

    const result = referenceSource(cwd, join("nested", "source.ts"));
    expect(result.executionPrompt).toContain("inside workspace content");
  });

  it("still reads an ordinary workspace file reference", async () => {
    useFlags();
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
    useFlags();
    const { cwd } = await workspaceWithSource("tiny-file-content");
    const alloc = vi.spyOn(Buffer, "alloc");

    expect(referenceSource(cwd).executionPrompt).toContain("tiny-file-content");
    expect(Math.max(0, ...alloc.mock.calls.map(([size]) => size))).toBeLessThan(64 * 1024);
  });

  it("rejects a file that grows after its descriptor is opened", async () => {
    useFlags();
    const { cwd, source } = await workspaceWithSource("original-content");
    swap.growAfterOpen = { path: source, bytes: 32 };

    expect(() => referenceSource(cwd)).toThrow("changed while it was being read");
  });

  it("rejects a file that grows past the source limit after inspection", async () => {
    useFlags();
    const { cwd, source } = await workspaceWithSource("original-content");
    swap.growAfterInspection = { path: source, bytes: 4 * 1024 * 1024 };

    expect(() => referenceSource(cwd)).toThrow("too large to inspect safely");
  });

  it("rejects a file above the source limit", async () => {
    useFlags();
    const { cwd } = await workspaceWithSource("x".repeat(4 * 1024 * 1024 + 1));

    expect(() => referenceSource(cwd)).toThrow("too large to inspect safely");
  });
});

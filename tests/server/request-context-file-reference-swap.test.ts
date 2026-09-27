import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const swap = vi.hoisted(() => ({ target: null as string | null, replacement: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const swapAfterInspection = (path: unknown): void => {
    if (swap.target === null || String(path) !== swap.target) return;
    const target = swap.target;
    swap.target = null;
    actual.rmSync(target);
    actual.symlinkSync(swap.replacement, target);
  };
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    const result = actual.statSync(...args);
    swapAfterInspection(args[0]);
    return result;
  }) as typeof actual.statSync;
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    const result = actual.lstatSync(...args);
    swapAfterInspection(args[0]);
    return result;
  }) as typeof actual.lstatSync;
  const replaced = { ...actual, statSync, lstatSync };
  return { ...replaced, default: replaced };
});

import { assembleTurnRequest } from "../../src/server/runtime/turns/request-context";

const directories: string[] = [];

afterEach(async () => {
  swap.target = null;
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
});

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  removeFixtureDirectory,
  removePortableFixture,
} from "./portable-provider-fixture";

function lockedError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked, unlink '${path}'`), {
    code,
    syscall: "unlink",
    path,
  });
}

function scriptedRemoval(failures: readonly NodeJS.ErrnoException[]) {
  const attempts: string[] = [];
  const waits: number[] = [];
  return {
    attempts,
    waits,
    dependencies: {
      remove: (root: string) => {
        const failure = failures[attempts.length];
        attempts.push(root);
        if (failure) throw failure;
      },
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
    },
  };
}

describe("portable fixture removal", () => {
  it("retries a locked executable until the directory is removed", async () => {
    const locked = lockedError("EBUSY", "C:\\fixture\\node.exe");
    const removal = scriptedRemoval([locked, locked, locked]);

    await removeFixtureDirectory("C:\\fixture", removal.dependencies);

    expect(removal.attempts).toEqual(Array(4).fill("C:\\fixture"));
    expect(removal.waits).toEqual([50, 150, 350]);
  });

  it("fails with the locked path and the exhausted retry budget when the lock never clears", async () => {
    const locked = lockedError("EBUSY", "C:\\fixture\\node.exe");
    const removal = scriptedRemoval(Array(10).fill(locked));

    const failure = await removeFixtureDirectory("C:\\fixture", removal.dependencies)
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Fixture directory C:\\fixture could not be removed after 6 attempts over 2800 ms: "
        + "EBUSY: resource busy or locked, unlink 'C:\\fixture\\node.exe'",
    );
    expect((failure as Error).cause).toBe(locked);
    expect(removal.attempts).toHaveLength(6);
    expect(removal.waits).toEqual([50, 150, 350, 750, 1_500]);
  });

  it("does not retry an error that waiting cannot clear", async () => {
    const denied = lockedError("EACCES", "C:\\fixture\\node.exe");
    const removal = scriptedRemoval([denied]);

    await expect(removeFixtureDirectory("C:\\fixture", removal.dependencies)).rejects.toBe(denied);
    expect(removal.attempts).toHaveLength(1);
    expect(removal.waits).toEqual([]);
  });

  it("removes a real fixture tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia fixture removal "));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "node.exe"), "");

    await removePortableFixture(root);

    expect(existsSync(root)).toBe(false);
  });
});

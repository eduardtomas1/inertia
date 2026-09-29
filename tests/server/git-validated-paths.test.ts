import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validatedPaths } from "../../src/server/git/paths";

const roots: string[] = [];

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("validated repository paths", () => {
  it("rejects a missing file below a symbolic-link directory that leaves the repository", async () => {
    const root = directory("inertia-validated-root-");
    const outside = directory("inertia-validated-outside-");
    mkdirSync(join(outside, "nested"));
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(validatedPaths(root, ["linked/nested/missing.txt"]))
      .rejects.toThrow(/outside the repository|symbolic link/iu);
  });

  it("accepts a missing file below a real repository directory", async () => {
    const root = directory("inertia-validated-root-");
    mkdirSync(join(root, "nested"));

    await expect(validatedPaths(root, ["nested/deeper/missing.txt"]))
      .resolves.toEqual(["nested/deeper/missing.txt"]);
  });

  it("accepts a missing file below an internal symbolic-link directory", async () => {
    const root = directory("inertia-validated-root-");
    mkdirSync(join(root, "real", "nested"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");

    await expect(validatedPaths(root, ["alias/nested/missing.txt"]))
      .resolves.toEqual(["alias/nested/missing.txt"]);
  });
});

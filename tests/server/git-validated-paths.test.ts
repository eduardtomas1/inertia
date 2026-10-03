import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { revParseValues, validatedPaths } from "../../src/server/git/paths";

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

describe("batched rev-parse values", () => {
  const queries = [
    ["--absolute-git-dir"],
    ["--path-format=absolute", "--git-path", "hooks"],
    ["--path-format=absolute", "--git-path", "index"],
    ["--path-format=absolute", "--git-path", "refs/heads/main"],
  ];

  function repository(name: string): string {
    const root = join(directory("inertia-rev-parse-"), name);
    mkdirSync(root);
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
    return root;
  }

  function direct(root: string): string[] {
    return queries.map((query) => execFileSync("git", ["rev-parse", ...query], {
      cwd: root,
      encoding: "utf8",
    }).replace(/\n$/u, ""));
  }

  it("returns the direct answers from one batched query", async () => {
    const root = repository("repository");
    await expect(revParseValues(root, queries, { failureMessage: "failed" }))
      .resolves.toEqual(direct(root));
  });

  it.skipIf(process.platform === "win32")(
    "falls back to the direct answers when a path contains a newline",
    async () => {
      const root = repository("repository\nline");
      const expected = direct(root);
      expect(expected.every((value) => value.includes("\n"))).toBe(true);
      await expect(revParseValues(root, queries, { failureMessage: "failed" }))
        .resolves.toEqual(expected);
    },
  );
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getUnifiedDiff, revertDiffSelection } from "../../src/server/git";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("selected diff reversal", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-diff-review-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "core.autocrlf", "false");
    git(root, "config", "user.name", "Inertia Test");
    git(root, "config", "user.email", "test@inertia.local");
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\n");
    git(root, "add", "example.txt");
    git(root, "commit", "-m", "base");
    return root;
  }

  it("reverses only selected changed lines and rejects stale selections", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nBETA\ngamma\ndelta\n");
    const diff = await getUnifiedDiff(root);
    const structured = parseUnifiedDiff(diff.text);
    const file = structured.files[0];
    const hunk = file.hunks[0];
    const delta = hunk.lines.find((line) => line.kind === "addition" && line.content === "delta");
    expect(delta).toBeDefined();

    await revertDiffSelection(root, {
      fingerprint: structured.fingerprint,
      filePath: file.path,
      hunkId: hunk.id,
      lineIds: [delta!.id],
    });

    expect(readFileSync(join(root, "example.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("alpha\nBETA\ngamma\n");
    await expect(revertDiffSelection(root, {
      fingerprint: structured.fingerprint,
      filePath: file.path,
      hunkId: hunk.id,
      lineIds: [delta!.id],
    })).rejects.toThrow(/moved since this selection was made/i);
  });
});

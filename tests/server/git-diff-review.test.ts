import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  commitChanges,
  getUnifiedDiff,
  inspectDiffSelection,
  revertDiffSelection,
  undoDiffSelection,
  type GitDiffSelection,
} from "../../src/server/git";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("safe selected diff reversal", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  function repository(content = "alpha\nbeta\ngamma\n"): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-diff-review-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "core.autocrlf", "false");
    git(root, "config", "user.name", "Inertia Test");
    git(root, "config", "user.email", "test@inertia.local");
    writeFileSync(join(root, "example.txt"), content);
    git(root, "add", "example.txt");
    git(root, "commit", "-m", "base");
    return root;
  }

  async function selectionFor(
    root: string,
    predicate: (line: ReturnType<typeof parseUnifiedDiff>["files"][number]["hunks"][number]["lines"][number]) => boolean,
  ): Promise<GitDiffSelection> {
    const diff = await getUnifiedDiff(root);
    expect(diff.truncated).toBe(false);
    const structured = parseUnifiedDiff(diff.text);
    const file = structured.files[0]!;
    const hunk = file.hunks[0]!;
    const selected = hunk.lines.filter(predicate);
    expect(selected.length).toBeGreaterThan(0);
    return {
      fingerprint: structured.fingerprint,
      filePath: file.path,
      hunkId: hunk.id,
      lineIds: selected.map(({ id }) => id),
    };
  }

  async function apply(root: string, selection: GitDiffSelection) {
    const plan = await inspectDiffSelection(root, selection);
    return {
      plan,
      result: await revertDiffSelection(root, { ...selection, expected: plan.validation }),
    };
  }

  it("removes a staged-only selection from both the index and working tree", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nBETA\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");

    const { plan } = await apply(root, selection);

    expect(plan.affectedLayers).toEqual(["index", "worktree"]);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(git(root, "show", ":example.txt")).toBe("alpha\nBETA\ngamma\n");
    expect(git(root, "diff", "--cached")).toContain("BETA");
    expect(git(root, "diff", "--cached")).not.toContain("delta");
    expect(git(root, "diff")).toBe("");
  });

  it("reverses an unstaged-only selection without changing the index", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const beforeIndex = git(root, "rev-parse", ":example.txt").trim();
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");

    const { plan } = await apply(root, selection);

    expect(plan.affectedLayers).toEqual(["worktree"]);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
    expect(git(root, "rev-parse", ":example.txt").trim()).toBe(beforeIndex);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("preserves unrelated unstaged work while removing selected staged changes in a mixed file", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nBETA\ngamma\n");
    git(root, "add", "example.txt");
    writeFileSync(join(root, "example.txt"), "alpha\nBETA\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => (
      (line.kind === "deletion" && line.content === "beta")
      || (line.kind === "addition" && line.content === "BETA")
    ));

    const { plan } = await apply(root, selection);

    expect(plan.affectedLayers).toEqual(["index", "worktree"]);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("alpha\nbeta\ngamma\ndelta\n");
    expect(git(root, "show", ":example.txt")).toBe("alpha\nbeta\ngamma\n");
    expect(git(root, "diff", "--cached")).toBe("");
    expect(git(root, "diff")).toContain("delta");
  });

  it("does not leave a staged addition hidden when its text was edited unstaged", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\nDELTA\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "DELTA");

    const { plan } = await apply(root, selection);

    expect(plan.affectedLayers).toEqual(["index", "worktree"]);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
    expect(git(root, "show", ":example.txt")).toBe("alpha\nbeta\ngamma\n");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("preserves CRLF, restores the final newline, keeps executable permissions, and supports Undo", async () => {
    const root = repository("alpha\r\nbeta\r\n");
    chmodSync(join(root, "example.txt"), 0o755);
    git(root, "add", "example.txt");
    git(root, "commit", "-m", "executable");
    writeFileSync(join(root, "example.txt"), "alpha\r\nbeta\r\ndelta");
    git(root, "add", "example.txt");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");

    const { result } = await apply(root, selection);

    expect(readFileSync(join(root, "example.txt"))).toEqual(Buffer.from("alpha\r\nbeta\r\n"));
    expect(lstatSync(join(root, "example.txt")).mode & 0o111).toBe(0o111);
    expect(git(root, "show", ":example.txt")).toBe("alpha\r\nbeta\r\n");

    await undoDiffSelection(root, result.operation.id);
    expect(readFileSync(join(root, "example.txt"))).toEqual(Buffer.from("alpha\r\nbeta\r\ndelta"));
    expect(lstatSync(join(root, "example.txt")).mode & 0o111).toBe(0o111);
    expect(git(root, "show", ":example.txt")).toBe("alpha\r\nbeta\r\ndelta");
  }, 30_000);

  it("rejects stale fingerprints and changes made after inspection", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nBETA\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const plan = await inspectDiffSelection(root, selection);
    writeFileSync(join(root, "example.txt"), "alpha\nBETA\ngamma\ndelta\nconcurrent\n");

    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation })).rejects.toThrow(/complete diff changed|changed after confirmation/i);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toContain("concurrent");
    await expect(inspectDiffSelection(root, { ...selection, fingerprint: "0".repeat(64) })).rejects.toThrow(/complete diff changed/i);
  });

  it("does not Undo over later file or index changes", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const { result } = await apply(root, selection);
    writeFileSync(join(root, "example.txt"), "later\n");

    await expect(undoDiffSelection(root, result.operation.id)).rejects.toThrow(/changed after the reversal/i);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("later\n");
  });

  it("rejects unresolved conflicts honestly", async () => {
    const root = repository();
    git(root, "checkout", "-b", "other");
    writeFileSync(join(root, "example.txt"), "other\n");
    git(root, "commit", "-am", "other");
    git(root, "checkout", "main");
    writeFileSync(join(root, "example.txt"), "main\n");
    git(root, "commit", "-am", "main");
    try { git(root, "merge", "other"); } catch { /* Expected merge conflict. */ }
    const selection = await selectionFor(root, (line) => line.kind === "addition" || line.kind === "deletion");
    await expect(inspectDiffSelection(root, selection)).rejects.toThrow(/resolve.*conflict/i);
  }, 30_000);

  it("rejects renamed files deliberately", async () => {
    const renamed = repository();
    git(renamed, "mv", "example.txt", "renamed.txt");
    writeFileSync(join(renamed, "renamed.txt"), "alpha\nchanged\ngamma\n");
    const renameSelection = await selectionFor(renamed, (line) => line.kind === "addition" || line.kind === "deletion");
    await expect(inspectDiffSelection(renamed, renameSelection)).rejects.toThrow(/renamed and copied/i);
  });

  it("rejects deleted files deliberately", async () => {
    const deleted = repository();
    rmSync(join(deleted, "example.txt"));
    const deleteSelection = await selectionFor(deleted, (line) => line.kind === "deletion");
    await expect(inspectDiffSelection(deleted, deleteSelection)).rejects.toThrow(/deleted files/i);
  });

  it("rejects untracked files deliberately", async () => {
    const untracked = repository();
    writeFileSync(join(untracked, "new.txt"), "new\n");
    const untrackedSelection = await selectionFor(untracked, (line) => line.kind === "addition");
    await expect(inspectDiffSelection(untracked, untrackedSelection)).rejects.toThrow(/new and untracked/i);
  });

  it("rejects type-changed symbolic links deliberately", async () => {
    const linked = repository();
    rmSync(join(linked, "example.txt"));
    symlinkSync("target.txt", join(linked, "example.txt"));
    const linkSelection = await selectionFor(linked, (line) => line.kind === "addition" || line.kind === "deletion");
    await expect(inspectDiffSelection(linked, linkSelection)).rejects.toThrow(/type-changed|symbolic links/i);
  });

  it("stages and commits only explicitly selected paths while preserving other staged work", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "selected base\n");
    writeFileSync(join(root, "other.txt"), "other base\n");
    git(root, "add", "selected.txt", "other.txt");
    git(root, "commit", "-m", "two files");
    writeFileSync(join(root, "selected.txt"), "selected next\n");
    writeFileSync(join(root, "other.txt"), "other next\n");
    git(root, "add", "other.txt");

    await commitChanges(root, "Selected path only", ["selected.txt"]);

    expect(git(root, "show", "HEAD:selected.txt")).toBe("selected next\n");
    expect(git(root, "show", "HEAD:other.txt")).toBe("other base\n");
    expect(git(root, "show", ":other.txt")).toBe("other next\n");
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("other.txt");
  });

  it("rejects an empty commit path selection without staging anything", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "changed\n");

    await expect(commitChanges(root, "Must not stage all", [])).rejects.toThrow(/select at least one path/i);

    expect(git(root, "diff", "--cached")).toBe("");
    expect(git(root, "diff")).toContain("changed");
  });
});

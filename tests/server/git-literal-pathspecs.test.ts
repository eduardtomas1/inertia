import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitChanges,
  compareGitSnapshots,
  getUnifiedDiff,
  inspectDiffSelection,
  revertDiffSelection,
} from "../../src/server/git";
import { restoreReversalIndexEntry } from "../../src/server/git/reversal-index";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const secureFiles = new SecureFileTestBroker();
const roots: string[] = [];
const special = "docs/[a].md";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-literal-pathspecs-"));
  roots.push(root);
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.email", "tests@inertia.invalid");
  git(root, "config", "user.name", "Inertia Tests");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, special), "special one\nspecial two\n");
  writeFileSync(join(root, "docs", "a.md"), "plain one\nplain two\n");
  git(root, "add", "--", "docs");
  git(root, "commit", "-q", "-m", "Initial");
  writeFileSync(join(root, special), "special one\nspecial two\nspecial three\n");
  writeFileSync(join(root, "docs", "a.md"), "plain one\nplain two\nplain three\n");
  return root;
}

function changedPaths(patch: string): string[] {
  return parseUnifiedDiff(patch).files.map((file) => file.path);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("literal Git pathspecs", { timeout: 30_000 }, () => {
  it("limits a selected working-tree diff to the literal path", async () => {
    const root = repository();

    const diff = await getUnifiedDiff(root, { paths: [special] });

    expect(changedPaths(diff.text)).toEqual([special]);
  });

  it("limits a historical comparison to the literal path", async () => {
    const root = repository();
    const conversation = randomUUID();
    const before = `refs/inertia/checkpoints/${conversation}/${randomUUID()}`;
    const after = `refs/inertia/checkpoints/${conversation}/${randomUUID()}`;
    git(root, "update-ref", before, "HEAD");
    git(root, "add", "--", "docs");
    git(root, "commit", "-q", "-m", "Change docs");
    git(root, "update-ref", after, "HEAD");

    const comparison = await compareGitSnapshots(root, before, after, {
      paths: [special],
    });

    expect(comparison.files.map((file) => file.path)).toEqual([special]);
    expect(changedPaths(comparison.patch)).toEqual([special]);
  });

  it("commits only the literal selected path", async () => {
    const root = repository();

    await commitChanges(root, "Commit special path", [special]);

    expect(git(root, "show", `HEAD:${special}`))
      .toBe("special one\nspecial two\nspecial three");
    expect(git(root, "show", "HEAD:docs/a.md")).toBe("plain one\nplain two");
    expect(git(root, "status", "--porcelain")).toBe("M docs/a.md");
  });

  it("reverses a selected line in a path containing glob metacharacters", async () => {
    const root = repository();
    const diff = await getUnifiedDiff(root, {}, undefined, secureFiles);
    const structured = parseUnifiedDiff(diff.text);
    const file = structured.files.find((candidate) => candidate.path === special)!;
    const hunk = file.hunks[0]!;
    const selection = {
      fingerprint: structured.fingerprint,
      filePath: special,
      hunkId: hunk.id,
      lineIds: hunk.lines
        .filter((line) => line.kind === "addition")
        .map((line) => line.id),
    };

    const plan = await inspectDiffSelection(root, selection, secureFiles);
    await revertDiffSelection(
      root,
      { ...selection, expected: plan.validation },
      secureFiles,
    );

    expect(readFileSync(join(root, special), "utf8"))
      .toBe("special one\nspecial two\n");
    expect(readFileSync(join(root, "docs", "a.md"), "utf8"))
      .toBe("plain one\nplain two\nplain three\n");
  });

  it("restores only the literal index entry after a failed reversal", async () => {
    const root = repository();
    const committed = git(root, "rev-parse", `:${special}`);
    git(root, "add", "--", "docs");
    const staged = git(root, "rev-parse", `:${special}`);
    const plainStaged = git(root, "rev-parse", ":docs/a.md");

    await restoreReversalIndexEntry(
      root,
      special,
      { mode: "100644", oid: staged },
      { mode: "100644", oid: committed },
      async () => undefined,
    );

    expect(git(root, "rev-parse", `:${special}`)).toBe(committed);
    expect(git(root, "rev-parse", ":docs/a.md")).toBe(plainStaged);
  });
});

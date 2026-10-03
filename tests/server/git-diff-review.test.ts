import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupReversalOperations as cleanupReversalOperationsWithBroker,
  getUnifiedDiff,
  inspectDiffSelection as inspectDiffSelectionWithBroker,
  revertDiffSelection as revertDiffSelectionWithBroker,
  undoDiffSelection as undoDiffSelectionWithBroker,
  type GitDiffSelection,
  type ReversalTestHooks,
} from "../../src/server/git";
import { REVERSAL_MAX_ACTIVE_BACKUPS, REVERSAL_REGISTRY_REF } from "../../src/server/reversal-registry";
import { writeAtomic } from "../../src/server/git/reversal-files";
import { restoreReversalIndexEntry } from "../../src/server/git/reversal-index";
import {
  SecureFileError,
  type RuntimeSecureFileBroker,
} from "../../src/server/secure-files";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const secureFiles = new SecureFileTestBroker();

function unavailableAfterReplace(
  commit: boolean,
): RuntimeSecureFileBroker {
  return {
    authorizeRoot: (root, signal) =>
      secureFiles.authorizeRoot(root, signal),
    verifyRoot: (root, signal) =>
      secureFiles.verifyRoot(root, signal),
    read: (root, path, maxBytes, signal) =>
      secureFiles.read(root, path, maxBytes, signal),
    replace: async (...args) => {
      if (commit) await secureFiles.replace(...args);
      throw new SecureFileError(
        "unavailable",
        "The secure file helper stopped before replying.",
      );
    },
  };
}

function inspectDiffSelection(
  root: string,
  selection: GitDiffSelection,
) {
  return inspectDiffSelectionWithBroker(root, selection, secureFiles);
}

function revertDiffSelection(
  root: string,
  selection: GitDiffSelection,
  testHooks?: ReversalTestHooks,
) {
  return revertDiffSelectionWithBroker(
    root,
    selection,
    secureFiles,
    testHooks,
  );
}

function undoDiffSelection(root: string, operationId: string) {
  return undoDiffSelectionWithBroker(root, operationId, secureFiles);
}

function cleanupReversalOperations(root: string) {
  return cleanupReversalOperationsWithBroker(root, secureFiles);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function hashBlob(cwd: string, content: string): string {
  return execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, encoding: "utf8", input: content }).trim();
}

interface TestRegistryOperation {
  operationId: string;
  status: string;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
  expiredAt: string | null;
  expiresAt: string;
  checkout: { fingerprint: string };
  backupReferences: Array<{ ref: string; oid: string }>;
}

interface TestRegistry {
  formatVersion: number;
  repositoryIdentity: string;
  operations: TestRegistryOperation[];
}

function readRegistry(cwd: string): TestRegistry {
  return JSON.parse(git(cwd, "cat-file", "blob", REVERSAL_REGISTRY_REF)) as TestRegistry;
}

function writeRegistry(cwd: string, registry: unknown): string {
  const oid = hashBlob(cwd, JSON.stringify(registry));
  git(cwd, "update-ref", REVERSAL_REGISTRY_REF, oid);
  return oid;
}

function reversalBackupRefs(cwd: string): string[] {
  return git(cwd, "for-each-ref", "--format=%(refname)", "refs/inertia/reversal-backups")
    .split("\n")
    .filter(Boolean);
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
    const diff = await getUnifiedDiff(root, {}, undefined, secureFiles);
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

  it("does not reopen an untracked preview through a swapped parent link", async () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "inertia-diff-outside-"));
    roots.push(outside);
    const nested = join(root, "nested");
    const originalNested = join(root, "nested-original");
    mkdirSync(nested);
    writeFileSync(join(nested, "untracked.txt"), "inside\n");
    writeFileSync(join(outside, "untracked.txt"), "OUTSIDE_SENTINEL\n");
    let swapped = false;

    const diff = await getUnifiedDiff(
      root,
      {},
      {
        afterUntrackedValidated: (path) => {
          if (swapped || path !== "nested/untracked.txt") return;
          swapped = true;
          renameSync(nested, originalNested);
          symlinkSync(
            outside,
            nested,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      },
      secureFiles,
    );

    expect(swapped).toBe(true);
    expect(diff.text).toContain(
      "Unable to preview untracked file nested/untracked.txt.",
    );
    expect(diff.truncated).toBe(true);
    expect(diff.text).not.toContain("OUTSIDE_SENTINEL");
  });

  it("marks an oversized untracked preview incomplete before review reconciliation", async () => {
    const root = repository();
    writeFileSync(join(root, "large.txt"), "x".repeat(2_048));

    const diff = await getUnifiedDiff(
      root,
      { maxBytes: 1_024 },
      undefined,
      secureFiles,
    );

    expect(diff).toMatchObject({
      filesIncluded: 1,
      totalFiles: 1,
      truncated: true,
    });
    expect(diff.text).toContain("Unable to preview untracked file large.txt.");
  });

  it("pins the repository root while previewing untracked content", async () => {
    const root = repository();
    const movedRoot = `${root}-moved`;
    const outside = mkdtempSync(join(tmpdir(), "inertia-diff-root-outside-"));
    roots.push(movedRoot, outside);
    writeFileSync(join(root, "untracked.txt"), "inside\n");
    writeFileSync(join(outside, "untracked.txt"), "OUTSIDE_SENTINEL\n");
    let swapped = false;

    const diff = await getUnifiedDiff(
      root,
      {},
      {
        afterUntrackedValidated: (path) => {
          if (swapped || path !== "untracked.txt") return;
          swapped = true;
          renameSync(root, movedRoot);
          symlinkSync(
            outside,
            root,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      },
      secureFiles,
    );

    expect(swapped).toBe(true);
    expect(diff.text).toContain(
      "Unable to preview untracked file untracked.txt.",
    );
    expect(diff.truncated).toBe(true);
    expect(diff.text).not.toContain("OUTSIDE_SENTINEL");
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

  it("preserves a UTF-8 BOM through a staged selected reversal and Undo", async () => {
    const original = Buffer.from("\uFEFFalpha\nbeta\n");
    const edited = Buffer.from("\uFEFFalpha\nbeta\ndelta\n");
    const root = repository(original.toString("utf8"));
    writeFileSync(join(root, "example.txt"), edited);
    git(root, "add", "example.txt");
    const originalIndex = git(root, "rev-parse", ":example.txt");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");

    const { plan, result } = await apply(root, selection);

    expect(plan.affectedLayers).toEqual(["index", "worktree"]);
    expect(readFileSync(join(root, "example.txt"))).toEqual(original);
    expect(Buffer.from(git(root, "show", ":example.txt"))).toEqual(original);
    expect(git(root, "status", "--porcelain")).toBe("");

    await undoDiffSelection(root, result.operation.id);
    expect(readFileSync(join(root, "example.txt"))).toEqual(edited);
    expect(git(root, "rev-parse", ":example.txt")).toBe(originalIndex);
    expect(Buffer.from(git(root, "show", ":example.txt"))).toEqual(edited);
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
    if (process.platform !== "win32") chmodSync(join(root, "example.txt"), 0o755);
    git(root, "update-index", "--chmod=+x", "example.txt");
    git(root, "commit", "-m", "executable");
    const executableBits = lstatSync(join(root, "example.txt")).mode & 0o111;
    expect(git(root, "ls-files", "--stage", "example.txt")).toMatch(/^100755 /u);
    writeFileSync(join(root, "example.txt"), "alpha\r\nbeta\r\ndelta");
    git(root, "add", "example.txt");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");

    const { result } = await apply(root, selection);

    expect(readFileSync(join(root, "example.txt"))).toEqual(Buffer.from("alpha\r\nbeta\r\n"));
    if (process.platform !== "win32") expect(lstatSync(join(root, "example.txt")).mode & 0o111).toBe(executableBits);
    expect(git(root, "ls-files", "--stage", "example.txt")).toMatch(/^100755 /u);
    expect(git(root, "show", ":example.txt")).toBe("alpha\r\nbeta\r\n");

    await undoDiffSelection(root, result.operation.id);
    expect(readFileSync(join(root, "example.txt"))).toEqual(Buffer.from("alpha\r\nbeta\r\ndelta"));
    if (process.platform !== "win32") expect(lstatSync(join(root, "example.txt")).mode & 0o111).toBe(executableBits);
    expect(git(root, "ls-files", "--stage", "example.txt")).toMatch(/^100755 /u);
    expect(git(root, "show", ":example.txt")).toBe("alpha\r\nbeta\r\ndelta");
  }, 30_000);

  it("persists an independent operation registry and deletes only its backup refs after Undo", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const { result } = await apply(root, selection);

    const applied = readRegistry(root);
    const record = applied.operations.find(({ operationId }) => operationId === result.operation.id)!;
    expect(record).toMatchObject({
      operationId: result.operation.id,
      status: "applied",
      undoneAt: null,
    });
    expect(record.appliedAt).toEqual(expect.any(String));
    expect(record.backupReferences).toHaveLength(4);
    expect(reversalBackupRefs(root)).toHaveLength(4);

    await undoDiffSelection(root, result.operation.id);

    const undone = readRegistry(root).operations.find(({ operationId }) => operationId === result.operation.id)!;
    expect(undone.status).toBe("undone");
    expect(undone.undoneAt).toEqual(expect.any(String));
    expect(reversalBackupRefs(root)).toEqual([]);
    expect(git(root, "rev-parse", "--verify", REVERSAL_REGISTRY_REF).trim()).toMatch(/^[0-9a-f]{40,64}$/u);
  }, 30_000);

  it("cleans a complete backup when apply stops before mutation", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const plan = await inspectDiffSelection(root, selection);

    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, {
      afterBackupCreated: () => { throw new Error("injected before mutation"); },
    })).rejects.toThrow(/injected before mutation/i);

    expect(readFileSync(join(root, "example.txt"), "utf8")).toContain("delta");
    expect(reversalBackupRefs(root)).toEqual([]);
    expect(readRegistry(root).operations.at(-1)).toMatchObject({ status: "failed", appliedAt: null });
  });

  it("cleans backup refs when repository state races after backup creation", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const plan = await inspectDiffSelection(root, selection);

    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, {
      afterBackupCreated: () => writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\nconcurrent\n"),
    })).rejects.toThrow(/changed immediately before/i);

    expect(readFileSync(join(root, "example.txt"), "utf8")).toContain("concurrent");
    expect(reversalBackupRefs(root)).toEqual([]);
    expect(readRegistry(root).operations.at(-1)?.status).toBe("failed");
  });

  it("rolls back a partial staged apply and deletes its backup refs on failure", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const plan = await inspectDiffSelection(root, selection);

    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, {
      afterIndexUpdated: () => { throw new Error("injected after index mutation"); },
    })).rejects.toThrow(/injected after index mutation/i);

    expect(readFileSync(join(root, "example.txt"), "utf8")).toContain("delta");
    expect(git(root, "show", ":example.txt")).toContain("delta");
    expect(reversalBackupRefs(root)).toEqual([]);
    expect(readRegistry(root).operations.at(-1)?.status).toBe("failed");
  });

  it("preserves newer staged content when a reversal fails after changing the index", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const plan = await inspectDiffSelection(root, selection);
    const newer = "alpha\nbeta\ngamma\nnew staged work\n";

    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, {
      afterIndexUpdated: () => {
        const oid = hashBlob(root, newer);
        git(root, "update-index", "--cacheinfo", "100644", oid, "example.txt");
        throw new Error("injected after concurrent staging");
      },
    })).rejects.toThrow(/injected after concurrent staging/u);

    expect(git(root, "show", ":example.txt")).toBe(newer);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toContain("delta");
    expect(readRegistry(root).operations.at(-1)?.status).toBe("recovery-required");
    expect(reversalBackupRefs(root).length).toBeGreaterThan(0);
  });

  it("preserves concurrent staging of other files while rolling back its own index entry", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const plan = await inspectDiffSelection(root, selection);

    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, {
      afterIndexUpdated: () => {
        writeFileSync(join(root, "other.txt"), "independent staged work\n");
        git(root, "add", "other.txt");
        throw new Error("injected after other staging");
      },
    })).rejects.toThrow(/injected after other staging/u);

    expect(git(root, "show", ":example.txt")).toContain("delta");
    expect(git(root, "show", ":other.txt")).toBe("independent staged work\n");
    expect(readRegistry(root).operations.at(-1)?.status).toBe("failed");
    expect(() => lstatSync(join(root, ".git", "index.lock"))).toThrow();
  });

  it("preserves a reversal index lock whose ownership marker changed in place", async () => {
    const root = repository();
    const indexBefore = readFileSync(join(root, ".git", "index"));
    const oid = git(root, "rev-parse", ":example.txt").trim();
    const desiredOid = hashBlob(root, "restored content\n");
    const lockPath = join(root, ".git", "index.lock");
    let checks = 0;
    await expect(restoreReversalIndexEntry(
      root, "example.txt", { mode: "100644", oid },
      { mode: "100644", oid: desiredOid }, async () => {
        if (++checks === 2) writeFileSync(lockPath, "foreign lock owner\n");
      },
    )).rejects.toThrow(/reservation|index changed/u);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(indexBefore);
    expect(readFileSync(lockPath, "utf8")).toBe("foreign lock owner\n");
  });

  it("restores a deleted line whose content starts with two dashes", async () => {
    const root = repository("select 1;\n-- keep this comment\nselect 2;\n");
    writeFileSync(join(root, "example.txt"), "select 1;\nselect 2;\n");
    const selection = await selectionFor(root, (line) => line.kind === "deletion" && line.content === "-- keep this comment");

    await apply(root, selection);

    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("select 1;\n-- keep this comment\nselect 2;\n");
  });

  it("restores a deletion at its own position after an added line that starts with two pluses", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\n++ example.txt\nbeta\n");
    const selection = await selectionFor(root, (line) => line.kind === "deletion" && line.content === "gamma");

    await apply(root, selection);

    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("alpha\n++ example.txt\nbeta\ngamma\n");
  });

  it("finds a changed non-ASCII file in the parsed diff", async () => {
    const root = repository();
    writeFileSync(join(root, "café.txt"), "alpha\nbeta\n");
    git(root, "add", "café.txt");
    git(root, "commit", "-m", "unicode");
    writeFileSync(join(root, "café.txt"), "alpha\nbeta\ngamma\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "gamma");

    expect(selection.filePath).toBe("café.txt");
    await apply(root, selection);

    expect(readFileSync(join(root, "café.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  it.skipIf(process.platform === "win32")("inspects a reversal without running a repository filesystem monitor", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "epsilon");
    const hooks = mkdtempSync(join(tmpdir(), "inertia-fsmonitor-hook-"));
    roots.push(hooks);
    const marker = join(hooks, "marker");
    const hook = join(hooks, "fsmonitor");
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(root, "config", "core.fsmonitor", hook);

    const plan = await inspectDiffSelection(root, selection);

    expect(plan.affectedLayers).toEqual(["worktree"]);
    expect(() => readFileSync(marker, "utf8")).toThrow();

    const staged = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const { result } = await apply(root, staged);
    expect(git(root, "-c", "core.fsmonitor=false", "show", ":example.txt")).toBe("alpha\nbeta\ngamma\n");
    await undoDiffSelection(root, result.operation.id);

    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("alpha\nbeta\ngamma\ndelta\nepsilon\n");
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it.skipIf(process.platform === "win32")("recovers a reversal index entry without running a repository filesystem monitor", async () => {
    const root = repository();
    const committed = git(root, "rev-parse", ":example.txt").trim();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    const staged = git(root, "rev-parse", ":example.txt").trim();
    const hooks = mkdtempSync(join(tmpdir(), "inertia-fsmonitor-hook-"));
    roots.push(hooks);
    const marker = join(hooks, "marker");
    const hook = join(hooks, "fsmonitor");
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(root, "config", "core.fsmonitor", hook);

    await restoreReversalIndexEntry(
      root, "example.txt", { mode: "100644", oid: staged },
      { mode: "100644", oid: committed }, async () => undefined,
    );

    expect(() => readFileSync(marker, "utf8")).toThrow();
    expect(git(root, "-c", "core.fsmonitor=false", "rev-parse", ":example.txt").trim()).toBe(committed);
  });

  it("does not reconcile a live reversal during concurrent inspection", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    git(root, "add", "example.txt");
    const selection = await selectionFor(
      root,
      (line) => line.kind === "addition" && line.content === "delta",
    );
    const plan = await inspectDiffSelection(root, selection);
    let signalIndexUpdated!: () => void;
    const indexUpdated = new Promise<void>((resolve) => {
      signalIndexUpdated = resolve;
    });
    let resumeApply!: () => void;
    const applyGate = new Promise<void>((resolve) => {
      resumeApply = resolve;
    });
    const applying = revertDiffSelection(
      root,
      { ...selection, expected: plan.validation },
      {
        afterIndexUpdated: async () => {
          signalIndexUpdated();
          await applyGate;
        },
      },
    );
    await indexUpdated;

    let inspectionSettled = false;
    const inspecting = inspectDiffSelection(root, selection)
      .finally(() => {
        inspectionSettled = true;
      });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(inspectionSettled).toBe(false);

    resumeApply();
    await expect(applying).resolves.toMatchObject({
      operation: { filePath: "example.txt" },
    });
    await expect(inspecting).rejects.toThrow(
      /no longer changed|complete diff changed/iu,
    );
    expect(readFileSync(join(root, "example.txt"), "utf8"))
      .toBe("alpha\nbeta\ngamma\n");
    expect(git(root, "show", ":example.txt"))
      .toBe("alpha\nbeta\ngamma\n");
    expect(readRegistry(root).operations.at(-1)?.status).toBe("applied");
  });

  it("recovers Undo from the persisted registry after module restart", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const { result } = await apply(root, selection);
    const interrupted = readRegistry(root);
    interrupted.operations[0]!.status = "applying";
    interrupted.operations[0]!.appliedAt = null;
    writeRegistry(root, interrupted);
    vi.resetModules();
    const reopened = await import("../../src/server/git");

    await reopened.undoDiffSelection(root, result.operation.id, secureFiles);

    expect(readFileSync(join(root, "example.txt"), "utf8")).toContain("delta");
    expect(readRegistry(root).operations.at(-1)?.status).toBe("undone");
    expect(reversalBackupRefs(root)).toEqual([]);
  });

  it("expires unused successful backups and bounds active retention per repository", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const expiringSelection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    await apply(root, expiringSelection);
    const expiredRegistry = readRegistry(root);
    const template = structuredClone(expiredRegistry.operations[0]!);
    expiredRegistry.operations[0]!.expiresAt = new Date(0).toISOString();
    writeRegistry(root, expiredRegistry);

    await cleanupReversalOperations(root);
    await cleanupReversalOperations(root);

    expect(readRegistry(root).operations[0]).toMatchObject({ status: "expired", expiredAt: expect.any(String) });
    expect(reversalBackupRefs(root)).toEqual([]);

    const seededAt = Date.now() - 60_000;
    const seeded = Array.from({ length: REVERSAL_MAX_ACTIVE_BACKUPS }, (_, index) => {
      const operationId = randomUUID();
      const backupReferences = template.backupReferences.map((reference) => {
        const ref = reference.ref.replace(template.operationId, operationId);
        git(root, "update-ref", ref, reference.oid);
        return { ...reference, ref };
      });
      return {
        ...template,
        operationId,
        backupReferences,
        status: "applied",
        createdAt: new Date(seededAt + index * 1_000).toISOString(),
      };
    });
    const registry = readRegistry(root);
    writeRegistry(root, { ...registry, operations: [...registry.operations, ...seeded] });
    expect(reversalBackupRefs(root)).toHaveLength(REVERSAL_MAX_ACTIVE_BACKUPS * 4);

    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\nretained\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "retained");
    const { result } = await apply(root, selection);

    const bounded = readRegistry(root);
    const evicted = seeded[0]!;
    expect(bounded.operations.filter(({ status }) => status === "applied").map(({ operationId }) => operationId))
      .toEqual([...seeded.slice(1).map(({ operationId }) => operationId), result.operation.id]);
    expect(bounded.operations.find(({ operationId }) => operationId === evicted.operationId))
      .toMatchObject({ status: "expired", expiredAt: expect.any(String) });
    const remainingRefs = reversalBackupRefs(root);
    expect(remainingRefs).toHaveLength(REVERSAL_MAX_ACTIVE_BACKUPS * 4);
    for (const { ref } of evicted.backupReferences) expect(remainingRefs).not.toContain(ref);
  }, 60_000);

  it("never deletes a namespaced ref whose target no longer matches the registry", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    await apply(root, selection);
    const registry = readRegistry(root);
    const changedReference = registry.operations[0]!.backupReferences[0]!;
    const unknownTarget = hashBlob(root, "not the registered backup\n");
    git(root, "update-ref", changedReference.ref, unknownTarget, changedReference.oid);
    registry.operations[0]!.expiresAt = new Date(0).toISOString();
    writeRegistry(root, registry);

    await cleanupReversalOperations(root);

    expect(git(root, "rev-parse", changedReference.ref).trim()).toBe(unknownTarget);
    expect(reversalBackupRefs(root)).toEqual([changedReference.ref]);
    expect(readRegistry(root).operations[0]?.status).toBe("expired");
  });

  it("refuses restore when the durable checkout identity does not match", async () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const { result } = await apply(root, selection);
    const registry = readRegistry(root);
    registry.operations[0]!.checkout.fingerprint = "0".repeat(64);
    writeRegistry(root, registry);

    await expect(undoDiffSelection(root, result.operation.id)).rejects.toThrow(/different repository or checkout identity/i);

    expect(readFileSync(join(root, "example.txt"), "utf8")).not.toContain("delta");
    expect(reversalBackupRefs(root)).toHaveLength(4);
  });

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

    const indexRoot = repository();
    writeFileSync(join(indexRoot, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const indexSelection = await selectionFor(indexRoot, (line) => line.kind === "addition" && line.content === "delta");
    const { result: indexResult } = await apply(indexRoot, indexSelection);
    const laterOid = hashBlob(indexRoot, "index changed later\n");
    git(indexRoot, "update-index", "--cacheinfo", "100644", laterOid, "example.txt");

    await expect(undoDiffSelection(indexRoot, indexResult.operation.id)).rejects.toThrow(/staged state changed/i);
    expect(git(indexRoot, "show", ":example.txt")).toBe("index changed later\n");
  }, 30_000);

  it("preserves unknown registry formats and their refs without rewriting or cleanup", async () => {
    const root = repository();
    const unknown = { formatVersion: 99, future: { keep: true } };
    const unknownRegistryOid = writeRegistry(root, unknown);
    const unknownBackupOid = hashBlob(root, "future backup\n");
    const unknownBackupRef = "refs/inertia/reversal-backups/00000000-0000-4000-8000-000000000000/future";
    git(root, "update-ref", unknownBackupRef, unknownBackupOid);

    await cleanupReversalOperations(root);

    expect(git(root, "rev-parse", REVERSAL_REGISTRY_REF).trim()).toBe(unknownRegistryOid);
    expect(git(root, "rev-parse", unknownBackupRef).trim()).toBe(unknownBackupOid);
    writeFileSync(join(root, "example.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "delta");
    const plan = await inspectDiffSelection(root, selection);
    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation })).rejects.toThrow(/newer or unreadable/i);
    expect(git(root, "rev-parse", REVERSAL_REGISTRY_REF).trim()).toBe(unknownRegistryOid);
    expect(git(root, "rev-parse", unknownBackupRef).trim()).toBe(unknownBackupOid);
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

  it("never follows a swapped parent while writing reversal content", async () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "inertia-reversal-outside-"));
    roots.push(outside);
    const parent = join(root, "src");
    const movedParent = join(root, "src-moved");
    mkdirSync(parent);
    writeFileSync(join(parent, "example.txt"), "inside\n");
    writeFileSync(join(outside, "example.txt"), "outside\n");
    const secureRoot = await secureFiles.authorizeRoot(root);

    await expect(writeAtomic(
      root,
      "src/example.txt",
      Buffer.from("replacement\n"),
      0o600,
      Buffer.from("inside\n"),
      secureFiles,
      secureRoot,
      {
        afterTargetOpened: () => {
          renameSync(parent, movedParent);
          symlinkSync(
            outside,
            parent,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      },
    )).rejects.toThrow(/unsafe|moved|changed|outcome/i);

    expect(readFileSync(join(outside, "example.txt"), "utf8"))
      .toBe("outside\n");
    expect(readFileSync(join(movedParent, "example.txt"), "utf8"))
      .toBe("inside\n");
  });

  it("pins the repository root while writing reversal content", async () => {
    const root = repository();
    const movedRoot = `${root}-moved`;
    const outside = mkdtempSync(
      join(tmpdir(), "inertia-reversal-root-outside-"),
    );
    roots.push(movedRoot, outside);
    writeFileSync(join(outside, "example.txt"), "alpha\nbeta\ngamma\n");
    const expected = readFileSync(join(root, "example.txt"));
    const secureRoot = await secureFiles.authorizeRoot(root);

    await expect(writeAtomic(
      root,
      "example.txt",
      Buffer.from("replacement\n"),
      0o600,
      expected,
      secureFiles,
      secureRoot,
      {
        afterTargetOpened: () => {
          renameSync(root, movedRoot);
          symlinkSync(
            outside,
            root,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      },
    )).rejects.toThrow(/unsafe|changed|outcome/i);

    expect(readFileSync(join(outside, "example.txt"), "utf8"))
      .toBe("alpha\nbeta\ngamma\n");
    expect(readFileSync(join(movedRoot, "example.txt"), "utf8"))
      .toBe(expected.toString("utf8"));
  });

  it("accepts an authoritative committed state after a lost helper reply", async () => {
    const root = repository();
    const broker = unavailableAfterReplace(true);
    const secureRoot = await broker.authorizeRoot(root);
    const expected = readFileSync(join(root, "example.txt"));

    await expect(writeAtomic(
      root,
      "example.txt",
      Buffer.from("replacement\n"),
      0o600,
      expected,
      broker,
      secureRoot,
    )).resolves.toBeUndefined();
    expect(readFileSync(join(root, "example.txt"), "utf8"))
      .toBe("replacement\n");
  });

  it("preserves an unchanged file after a helper fails before commit", async () => {
    const root = repository();
    const broker = unavailableAfterReplace(false);
    const secureRoot = await broker.authorizeRoot(root);
    const expected = readFileSync(join(root, "example.txt"));

    await expect(writeAtomic(
      root,
      "example.txt",
      Buffer.from("replacement\n"),
      0o600,
      expected,
      broker,
      secureRoot,
    )).rejects.toThrow(/stopped before replying/i);
    expect(readFileSync(join(root, "example.txt"), "utf8"))
      .toBe(expected.toString("utf8"));
  });

  it("completes a staged reversal when the committed helper reply is lost", async () => {
    const root = repository();
    writeFileSync(
      join(root, "example.txt"),
      "alpha\nbeta\ngamma\ndelta\n",
    );
    git(root, "add", "example.txt");
    const selection = await selectionFor(
      root,
      (line) => line.kind === "addition" && line.content === "delta",
    );
    const broker = unavailableAfterReplace(true);
    const plan = await inspectDiffSelectionWithBroker(
      root,
      selection,
      broker,
    );

    const result = await revertDiffSelectionWithBroker(
      root,
      { ...selection, expected: plan.validation },
      broker,
    );

    expect(result.operation.affectedLayers).toEqual(["index", "worktree"]);
    expect(readFileSync(join(root, "example.txt"), "utf8"))
      .toBe("alpha\nbeta\ngamma\n");
    expect(git(root, "show", ":example.txt"))
      .toBe("alpha\nbeta\ngamma\n");
    expect(readRegistry(root).operations.at(-1)?.status).toBe("applied");
  });
});

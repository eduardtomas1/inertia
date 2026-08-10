import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureGitCommitReview,
  commitReviewedChanges,
  prepareGitCommitReview,
  renderGitCommitReviewDiff,
} from "../../src/server/git";
import { waitForReferenceLocksToRelease } from "../../src/server/git/commits";
import { runGit } from "../../src/server/git/runner";
import {
  portableNodeExecutable,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const roots: string[] = [];
const descendantPids: number[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function gitPreservingWhitespace(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).replace(/(?:\r\n|\n)$/u, "");
}

function nodeFilterCommand(path: string): string {
  const executable = process.execPath.replaceAll("\\", "/");
  const script = path.replaceAll("\\", "/");
  return `"${executable}" "${script}"`;
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-commit-review-"));
  roots.push(root);
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.email", "tests@inertia.invalid");
  git(root, "config", "user.name", "Inertia Tests");
  writeFileSync(join(root, "selected.txt"), "selected before\n");
  writeFileSync(join(root, "other.txt"), "other before\n");
  git(root, "add", "--", "selected.txt", "other.txt");
  git(root, "commit", "-q", "-m", "Initial");
  return root;
}

function unbornRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-unborn-commit-review-"));
  roots.push(root);
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.email", "tests@inertia.invalid");
  git(root, "config", "user.name", "Inertia Tests");
  return root;
}

function looseObjects(root: string): string[] {
  return readdirSync(join(root, ".git", "objects"), {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function commitObjects(root: string): string[] {
  return git(
    root,
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objecttype) %(objectname)",
  ).split(/\r?\n/u).filter((line) => line.startsWith("commit ")).sort();
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of descendantPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process-tree cleanup under test may already have removed it.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Git commit review receipts", () => {
  it("captures a stable raw tree without adding objects to the real repository", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "selected after\n");
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 255, 1, 254]));
    chmodSync(join(root, "selected.txt"), 0o755);
    const before = looseObjects(root);

    const first = await captureGitCommitReview(root);
    const second = await captureGitCommitReview(root);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.rawTree).toBe(first.rawTree);
    expect(looseObjects(root)).toEqual(before);
    writeFileSync(join(root, "selected.txt"), "selected  after\n");
    expect((await captureGitCommitReview(root)).fingerprint)
      .not.toBe(first.fingerprint);
  });

  it("rejects stale reviewed content before changing HEAD or the real index", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const indexTree = git(root, "write-tree");
    writeFileSync(join(root, "selected.txt"), "changed after review\n");

    await expect(commitReviewedChanges(
      root,
      "Must reject stale review",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/changed after its complete diff was reviewed/iu);

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "write-tree")).toBe(indexTree);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
  });

  it("rejects a selected MM restoration without creating an empty commit", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "staged version\n");
    git(root, "add", "--", "selected.txt");
    writeFileSync(join(root, "selected.txt"), "selected before\n");
    expect(git(root, "status", "--short", "--", "selected.txt"))
      .toBe("MM selected.txt");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const indexTree = git(root, "write-tree");
    const commits = commitObjects(root);

    await expect(commitReviewedChanges(
      root,
      "Must not create an empty commit",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toMatchObject({ code: "nothing-to-commit" });

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "write-tree")).toBe(indexTree);
    expect(commitObjects(root)).toEqual(commits);
    expect(git(root, "status", "--short", "--", "selected.txt"))
      .toBe("MM selected.txt");
  });

  it("rejects an unborn selected restoration without creating an empty commit", async () => {
    const root = unbornRepository();
    writeFileSync(join(root, "selected.txt"), "staged unborn version\n");
    git(root, "add", "--", "selected.txt");
    rmSync(join(root, "selected.txt"));
    expect(git(root, "status", "--short", "--", "selected.txt"))
      .toBe("AD selected.txt");
    const review = await captureGitCommitReview(root);
    const headFile = readFileSync(join(root, ".git", "HEAD"));
    const indexPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const index = readFileSync(indexPath);
    const commits = commitObjects(root);

    await expect(commitReviewedChanges(
      root,
      "Must not create an unborn empty commit",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toMatchObject({ code: "nothing-to-commit" });

    expect(() => git(root, "rev-parse", "--verify", "HEAD")).toThrow();
    expect(readFileSync(join(root, ".git", "HEAD"))).toEqual(headFile);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(commitObjects(root)).toEqual(commits);
    expect(existsSync(`${indexPath}.lock`)).toBe(false);
    expect(existsSync(`${indexPath}.inertia-commit-transaction.json`))
      .toBe(false);
  });

  it("bounds a stalled commit-tree by the original operation deadline", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed deadline source\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const indexPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const index = readFileSync(indexPath);
    const fixture = mkdtempSync(join(tmpdir(), "inertia stalled commit tree-"));
    roots.push(fixture);
    const pidsPath = join(fixture, "pids.txt");
    portableNodeExecutable(fixture, "git");
    writeNodeSubcommand(fixture, "commit-tree", `
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
appendFileSync(${JSON.stringify(pidsPath)}, String(process.pid) + "\\n");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
appendFileSync(${JSON.stringify(pidsPath)}, String(child.pid) + "\\n");
setInterval(() => {}, 1000);
`);
    const deadlineAt = Date.now() + 5_000;

    await expect(commitReviewedChanges(
      root,
      "Must time out stalled commit-tree",
      ["selected.txt"],
      review.fingerprint,
      {
        deadlineAt,
        testHooks: {
          afterFinalReview: async () => {
            const waitMs = deadlineAt - Date.now() - 2_000;
            if (waitMs > 0) await delay(waitMs);
          },
          runCommitTree: async (_cwd, args, options) => await runGit(
            fixture,
            args,
            {
              ...options,
              environment: {
                ...options.environment,
                PATH: fixture,
              },
            },
          ),
        },
      },
    )).rejects.toMatchObject({ code: "timeout" });

    const pids = readFileSync(pidsPath, "utf8")
      .trim().split(/\r?\n/u).map(Number);
    descendantPids.push(...pids);
    await waitFor(
      "the stalled commit-tree process tree to terminate",
      () => pids.every((pid) => !processExists(pid)),
    );
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(existsSync(`${indexPath}.lock`)).toBe(false);
    expect(existsSync(`${indexPath}.inertia-commit-transaction.json`))
      .toBe(false);
  }, 12_000);

  it("commits only reviewed selected paths and preserves unrelated staged work", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "selected reviewed\n");
    writeFileSync(join(root, "other.txt"), "other staged\n");
    git(root, "add", "--", "other.txt");
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit selected path",
      ["selected.txt"],
      review.fingerprint,
    );

    expect(git(root, "show", "HEAD:selected.txt")).toBe("selected reviewed");
    expect(git(root, "show", "HEAD:other.txt")).toBe("other before");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("other.txt");
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("other staged\n");
  });

  it("commits the captured selected tree when source changes after final verification", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed source\n");
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit captured source",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterFinalReview: () => {
            writeFileSync(join(root, "selected.txt"), "later source\n");
          },
        },
      },
    );

    expect(git(root, "show", "HEAD:selected.txt")).toBe("reviewed source");
    expect(readFileSync(join(root, "selected.txt"), "utf8"))
      .toBe("later source\n");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(git(root, "diff", "--name-only")).toBe("selected.txt");
  });

  it("includes a selected rename source in the committed tree", async () => {
    const root = repository();
    git(root, "mv", "selected.txt", "renamed.txt");
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit rename",
      ["renamed.txt"],
      review.fingerprint,
    );

    expect(() => git(root, "show", "HEAD:selected.txt")).toThrow();
    expect(git(root, "show", "HEAD:renamed.txt")).toBe("selected before");
    expect(git(root, "status", "--short")).toBe("");
  });

  it("commits a staged deletion recreated in the worktree as replacement content", async () => {
    const root = repository();
    git(root, "rm", "-q", "--", "selected.txt");
    writeFileSync(join(root, "selected.txt"), "replacement content\n");
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit recreated deletion",
      ["selected.txt"],
      review.fingerprint,
    );

    expect(git(root, "show", "HEAD:selected.txt"))
      .toBe("replacement content");
    expect(git(root, "status", "--short")).toBe("");
  });

  it("retains a recreated rename source in the reviewed commit", async () => {
    const root = repository();
    git(root, "mv", "selected.txt", "renamed.txt");
    writeFileSync(join(root, "selected.txt"), "recreated source\n");
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit rename with recreated source",
      ["renamed.txt"],
      review.fingerprint,
    );

    expect(git(root, "show", "HEAD:renamed.txt")).toBe("selected before");
    expect(git(root, "show", "HEAD:selected.txt")).toBe("recreated source");
    expect(git(root, "status", "--short")).toBe("");
  });

  it("keeps a copy source when committing its reviewed destination", async () => {
    const root = repository();
    writeFileSync(
      join(root, "copied.txt"),
      readFileSync(join(root, "selected.txt")),
    );
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit copied destination",
      ["copied.txt"],
      review.fingerprint,
    );

    expect(git(root, "show", "HEAD:selected.txt")).toBe("selected before");
    expect(git(root, "show", "HEAD:copied.txt")).toBe("selected before");
  });

  it.skipIf(process.platform === "win32")(
    "commits reviewed executable modes and symbolic-link targets",
    async () => {
      const root = repository();
      chmodSync(join(root, "selected.txt"), 0o755);
      symlinkSync("selected.txt", join(root, "selected-link"));
      const review = await captureGitCommitReview(root);

      await commitReviewedChanges(
        root,
        "Commit modes and link",
        ["selected.txt", "selected-link"],
        review.fingerprint,
      );

      expect(git(root, "ls-tree", "HEAD", "selected.txt"))
        .toMatch(/^100755 blob /u);
      expect(git(root, "ls-tree", "HEAD", "selected-link"))
        .toMatch(/^120000 blob /u);
      expect(git(root, "show", "HEAD:selected-link")).toBe("selected.txt");
    },
  );

  it("commits a reviewed embedded-repository gitlink", async () => {
    const root = repository();
    const module = join(root, "module");
    git(root, "init", "-q", "--initial-branch=main", "module");
    git(module, "config", "user.email", "tests@inertia.invalid");
    git(module, "config", "user.name", "Inertia Tests");
    writeFileSync(join(module, "module.txt"), "module source\n");
    git(module, "add", "--", "module.txt");
    git(module, "commit", "-q", "-m", "Module initial");
    const moduleHead = git(module, "rev-parse", "HEAD");
    git(root, "add", "--", "module");
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit gitlink",
      ["module"],
      review.fingerprint,
    );

    expect(git(root, "ls-tree", "HEAD", "module"))
      .toBe(`160000 commit ${moduleHead}\tmodule`);
  });

  it("renders and commits the normal filtered prospective content", async () => {
    const root = repository();
    const filterDirectory = join(root, "filter helpers");
    mkdirSync(filterDirectory);
    const filter = join(filterDirectory, "uppercase filter.cjs");
    writeFileSync(filter, [
      "const chunks = [];",
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('utf8').toUpperCase()));",
      "",
    ].join("\n"));
    git(root, "config", "filter.upper.clean", nodeFilterCommand(filter));
    git(root, "config", "filter.upper.required", "true");
    writeFileSync(join(root, ".gitattributes"), "*.upper filter=upper\n");
    writeFileSync(join(root, "new.upper"), "reviewed lowercase\n");
    const prepared = await prepareGitCommitReview(root);
    let patch: string;
    try {
      patch = await renderGitCommitReviewDiff(root, prepared);
    } finally {
      await prepared.selection.dispose();
    }
    expect(patch).toContain("+REVIEWED LOWERCASE");
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit filtered content",
      [".gitattributes", "new.upper"],
      review.fingerprint,
    );

    expect(git(root, "show", "HEAD:new.upper")).toBe("REVIEWED LOWERCASE");
  });

  it.skipIf(process.platform === "win32")(
    "never invokes a configured fsmonitor from internal temporary indexes",
    async () => {
      const root = repository();
      const hookRoot = mkdtempSync(join(tmpdir(), "inertia-fsmonitor-hook-"));
      roots.push(hookRoot);
      const marker = join(hookRoot, "called");
      const hook = join(hookRoot, "fsmonitor.cjs");
      writeFileSync(hook, [
        "#!/usr/bin/env node",
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n');`,
        "process.stdout.write('2\\0');",
        "",
      ].join("\n"));
      chmodSync(hook, 0o755);
      git(root, "config", "core.fsmonitor", hook);
      writeFileSync(join(root, "selected.txt"), "reviewed monitor source\n");

      const review = await captureGitCommitReview(root);
      await commitReviewedChanges(
        root,
        "Commit without fsmonitor",
        ["selected.txt"],
        review.fingerprint,
      );

      expect(existsSync(marker)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a repository object path whose directory ends in whitespace",
    async () => {
      const parent = mkdtempSync(join(tmpdir(), "inertia-spaced-parent-"));
      roots.push(parent);
      const root = join(parent, "repository ");
      mkdirSync(root);
      git(root, "init", "-q", "--initial-branch=main");
      git(root, "config", "user.email", "tests@inertia.invalid");
      git(root, "config", "user.name", "Inertia Tests");
      writeFileSync(join(root, "selected.txt"), "before\n");
      git(root, "add", "--", "selected.txt");
      git(root, "commit", "-q", "-m", "Initial");
      writeFileSync(join(root, "selected.txt"), "after\n");

      const review = await captureGitCommitReview(root);
      const result = await commitReviewedChanges(
        root,
        "Commit spaced repository",
        ["selected.txt"],
        review.fingerprint,
      );

      expect(result.commit).toBe(git(root, "rev-parse", "HEAD"));
      expect(git(root, "show", "HEAD:selected.txt")).toBe("after");
    },
  );

  it("keeps a large binary review display bounded while binding its blob", async () => {
    const root = repository();
    writeFileSync(join(root, "large.bin"), Buffer.alloc(3 * 1024 * 1024, 0));
    const prepared = await prepareGitCommitReview(root);
    let patch: string;
    try {
      patch = await renderGitCommitReviewDiff(root, prepared);
    } finally {
      await prepared.selection.dispose();
    }
    expect(patch.length).toBeLessThan(16_384);
    expect(patch).toMatch(/Binary files .* differ/iu);
    const review = await captureGitCommitReview(root);

    await commitReviewedChanges(
      root,
      "Commit large binary",
      ["large.bin"],
      review.fingerprint,
    );

    expect(git(root, "cat-file", "-s", "HEAD:large.bin"))
      .toBe(String(3 * 1024 * 1024));
  });

  it("rejects an in-progress merge before mutating HEAD or the index", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed merge source\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const index = git(root, "write-tree");
    writeFileSync(join(root, ".git", "MERGE_HEAD"), `${head}\n`);

    await expect(commitReviewedChanges(
      root,
      "Must reject merge",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/active merge/iu);

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "write-tree")).toBe(index);
  });

  it("rejects an active bisect state before mutating HEAD or the index", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed bisect source\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const index = git(root, "write-tree");
    writeFileSync(join(root, ".git", "BISECT_START"), "refs/heads/main\n");

    await expect(commitReviewedChanges(
      root,
      "Must reject bisect",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/active merge/iu);

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "write-tree")).toBe(index);
  });

  it("rejects an active git-am or rebase state before mutating HEAD or the index", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed apply source\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const index = git(root, "write-tree");
    mkdirSync(join(root, ".git", "rebase-apply"));

    await expect(commitReviewedChanges(
      root,
      "Must reject active apply",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/active rebase|active.*apply/iu);

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "write-tree")).toBe(index);
  });

  it("never removes an index lock owned by another Git operation during recovery", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed recovery source\n");
    const review = await captureGitCommitReview(root);
    const indexPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const lockPath = `${indexPath}.lock`;
    const journalPath = `${indexPath}.inertia-commit-transaction.json`;
    const currentHead = git(root, "rev-parse", "HEAD");
    const headPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "HEAD",
    );
    const currentIndex = readFileSync(indexPath);
    const refPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "refs/heads/main",
    );
    writeFileSync(lockPath, "foreign Git lock\n");
    writeFileSync(journalPath, JSON.stringify({
      expectedHead: "0".repeat(currentHead.length),
      headRef: "refs/heads/main",
      headPath,
      refPath,
      newCommit: currentHead,
      oldIndexHash: "1".repeat(64),
      newIndexHash: createHash("sha256").update(currentIndex).digest("hex"),
      indexPath,
      stagePath: `${indexPath}.inertia-stage-${"a".repeat(32)}`,
      reservationToken: "1".repeat(64),
    }));

    await expect(commitReviewedChanges(
      root,
      "Must preserve foreign lock",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/Git lock owned by another operation/iu);

    expect(readFileSync(lockPath, "utf8")).toBe("foreign Git lock\n");
    expect(readFileSync(journalPath, "utf8")).toContain(currentHead);
    expect(git(root, "rev-parse", "HEAD")).toBe(currentHead);
  });

  it("never infers ownership of a byte-identical index lock after restart", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed identical lock source\n");
    const review = await captureGitCommitReview(root);
    const indexPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const lockPath = `${indexPath}.lock`;
    const journalPath = `${indexPath}.inertia-commit-transaction.json`;
    const currentHead = git(root, "rev-parse", "HEAD");
    const headPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "HEAD",
    );
    const refPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "refs/heads/main",
    );
    const currentIndex = readFileSync(indexPath);
    writeFileSync(lockPath, currentIndex);
    writeFileSync(journalPath, JSON.stringify({
      expectedHead: currentHead,
      headRef: "refs/heads/main",
      headPath,
      refPath,
      newCommit: currentHead,
      oldIndexHash: createHash("sha256").update(currentIndex).digest("hex"),
      newIndexHash: createHash("sha256").update(currentIndex).digest("hex"),
      indexPath,
      stagePath: `${indexPath}.inertia-stage-${"b".repeat(32)}`,
      reservationToken: "2".repeat(64),
    }));

    await expect(commitReviewedChanges(
      root,
      "Must preserve identical foreign lock",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/Git lock owned by another operation/iu);

    expect(readFileSync(lockPath)).toEqual(currentIndex);
    expect(readFileSync(journalPath, "utf8")).toContain(currentHead);
    expect(git(root, "rev-parse", "HEAD")).toBe(currentHead);
  });

  it("leaves a pre-existing Git index lock untouched when commit setup conflicts", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed busy source\n");
    const review = await captureGitCommitReview(root);
    const indexPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const lockPath = `${indexPath}.lock`;
    const journalPath = `${indexPath}.inertia-commit-transaction.json`;
    writeFileSync(lockPath, "foreign Git lock\n");

    await expect(commitReviewedChanges(
      root,
      "Must preserve busy lock",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/index is busy/iu);

    expect(readFileSync(lockPath, "utf8")).toBe("foreign Git lock\n");
    expect(() => readFileSync(journalPath)).toThrow();
  });

  it("does not advance either branch when HEAD switches before transaction locks", async () => {
    const root = repository();
    git(root, "branch", "other");
    writeFileSync(join(root, "selected.txt"), "reviewed branch source\n");
    const review = await captureGitCommitReview(root);
    const mainHead = git(root, "rev-parse", "refs/heads/main");
    const otherHead = git(root, "rev-parse", "refs/heads/other");

    await expect(commitReviewedChanges(
      root,
      "Must reject switched branch",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforeTransactionLock: () => {
            git(root, "checkout", "-q", "other");
          },
        },
      },
    )).rejects.toThrow(/checked-out branch changed/iu);

    expect(git(root, "rev-parse", "refs/heads/main")).toBe(mainHead);
    expect(git(root, "rev-parse", "refs/heads/other")).toBe(otherHead);
    expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/other");
    expect(() => readFileSync(join(root, ".git", "HEAD.lock"))).toThrow();
  });

  it("does not install a branch index when symbolic HEAD switches after ref commit", async () => {
    const root = repository();
    git(root, "branch", "other");
    writeFileSync(join(root, "selected.txt"), "reviewed post-ref source\n");
    const review = await captureGitCommitReview(root);
    const mainHead = git(root, "rev-parse", "refs/heads/main");
    const originalIndex = readFileSync(join(root, ".git", "index"));

    const result = await commitReviewedChanges(
      root,
      "Commit with switched checkout",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterReferenceCommit: () => {
            git(root, "symbolic-ref", "HEAD", "refs/heads/other");
          },
        },
      },
    );

    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(git(root, "rev-parse", "refs/heads/main")).not.toBe(mainHead);
    expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/other");
    expect(readFileSync(join(root, ".git", "index")).equals(originalIndex))
      .toBe(true);
    expect(readFileSync(join(root, ".git", "index.lock")).length)
      .toBeGreaterThan(0);
  });

  it("rechecks signing policy inside the prepared reference transaction", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed policy source\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");

    await expect(commitReviewedChanges(
      root,
      "Must reject changed signing policy",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforeTransactionLock: () => {
            git(root, "config", "commit.gpgSign", "true");
          },
        },
      },
    )).rejects.toThrow(/signing is enabled/iu);

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(() => readFileSync(join(root, ".git", "index.lock"))).toThrow();
  });

  it("aborts an expired synchronous prepared mutation and removes only its owned lock", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed expiry source\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const foreignLock = join(root, ".git", "foreign-operation.lock");
    writeFileSync(foreignLock, "foreign lock\n");
    const deadlineAt = Date.now() + 2_000;

    await expect(commitReviewedChanges(
      root,
      "Must reject expired prepared mutation",
      ["selected.txt"],
      review.fingerprint,
      {
        deadlineAt,
        testHooks: {
          duringPreparedMutation: () => {
            while (Date.now() <= deadlineAt + 5) {
              // Cross the aggregate deadline without yielding to its timer.
            }
          },
        },
      },
    )).rejects.toMatchObject({ code: "timeout" });

    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(() => readFileSync(join(root, ".git", "index.lock"))).toThrow();
    expect(readFileSync(foreignLock, "utf8")).toBe("foreign lock\n");
  });

  it("accepts native locks released at the cleanup-grace boundary", async () => {
    const root = repository();
    const headLock = join(root, ".git", "HEAD.lock");
    const refLock = join(root, ".git", "refs", "heads", "main.lock");
    writeFileSync(headLock, "delayed HEAD lock\n");
    writeFileSync(refLock, "delayed branch lock\n");
    let finalObservation = false;

    await expect(waitForReferenceLocksToRelease(
      headLock,
      refLock,
      () => {
        finalObservation = true;
        rmSync(headLock);
        rmSync(refLock);
      },
    )).resolves.toBe(true);

    expect(finalObservation).toBe(true);
  });

  it("rejects replacement Git metadata at the final reviewed boundary", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed metadata source\n");
    const review = await captureGitCommitReview(root);
    const gitPath = join(root, ".git");
    const originalIdentity = statSync(gitPath, { bigint: true });
    const assertIdentity = (): void => {
      const current = statSync(gitPath, { bigint: true });
      if (
        current.dev !== originalIdentity.dev
        || current.ino !== originalIdentity.ino
        || current.birthtimeNs !== originalIdentity.birthtimeNs
      ) throw new Error("Git metadata identity changed.");
    };

    await expect(commitReviewedChanges(
      root,
      "Must reject replaced metadata",
      ["selected.txt"],
      review.fingerprint,
      {
        verifyRepositoryIdentity: assertIdentity,
        testHooks: {
          afterFinalReview: () => {
            const original = join(root, ".git-original");
            renameSync(gitPath, original);
            cpSync(original, gitPath, { recursive: true });
          },
        },
      },
    )).rejects.toThrow(/metadata identity changed/iu);

    expect(git(root, "log", "-1", "--format=%s")).toBe("Initial");
    expect(() => readFileSync(join(root, ".git", "index.lock"))).toThrow();
  });

  it("finishes index recovery when reference commit acknowledgement is lost", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed acknowledged source\n");
    const review = await captureGitCommitReview(root);

    const result = await commitReviewedChanges(
      root,
      "Recover acknowledged commit",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterReferenceCommit: () => {
            throw new Error("Simulated lost update-ref acknowledgement.");
          },
        },
      },
    );

    expect(result.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "show", "HEAD:selected.txt"))
      .toBe("reviewed acknowledged source");
    expect(git(root, "status", "--short")).toBe("");
    expect(() => readFileSync(
      `${git(root, "rev-parse", "--path-format=absolute", "--git-path", "index")}.inertia-commit-transaction.json`,
    )).toThrow();
  });

  it("recovers a lost reference acknowledgement on a Unicode branch", async () => {
    const root = repository();
    git(root, "switch", "-c", "café");
    writeFileSync(join(root, "selected.txt"), "reviewed Unicode branch source\n");
    const review = await captureGitCommitReview(root);

    const result = await commitReviewedChanges(
      root,
      "Recover Unicode branch commit",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterReferenceCommit: () => {
            throw new Error("Simulated lost acknowledgement.");
          },
        },
      },
    );

    expect(result.refreshWarning).toBeUndefined();
    expect(result.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/café");
    expect(git(root, "status", "--short")).toBe("");
  });

  it("commits and recovers on a branch ending in Unicode whitespace", async () => {
    const root = repository();
    const branch = `reviewed-${"\u00a0"}`;
    const headRef = `refs/heads/${branch}`;
    git(root, "switch", "-c", branch);
    writeFileSync(join(root, "selected.txt"), "reviewed NBSP source\n");
    const firstReview = await captureGitCommitReview(root);

    const first = await commitReviewedChanges(
      root,
      "Commit NBSP branch",
      ["selected.txt"],
      firstReview.fingerprint,
    );

    expect(first.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(gitPreservingWhitespace(root, "symbolic-ref", "HEAD"))
      .toBe(headRef);

    writeFileSync(join(root, "selected.txt"), "reviewed NBSP recovery\n");
    const secondReview = await captureGitCommitReview(root);
    const second = await commitReviewedChanges(
      root,
      "Recover NBSP branch commit",
      ["selected.txt"],
      secondReview.fingerprint,
      {
        testHooks: {
          afterReferenceCommit: () => {
            throw new Error("Simulated lost acknowledgement.");
          },
        },
      },
    );

    expect(second.refreshWarning).toBeUndefined();
    expect(second.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(gitPreservingWhitespace(root, "symbolic-ref", "HEAD"))
      .toBe(headRef);
    expect(git(root, "status", "--short")).toBe("");
  });

  it("acknowledges an irreversible commit when status refresh fails", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed status source\n");
    const review = await captureGitCommitReview(root);
    const before = git(root, "rev-list", "--count", "HEAD");

    const result = await commitReviewedChanges(
      root,
      "Commit despite refresh failure",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforePostCommitStatus: () => {
            throw new Error("Injected status refresh failure.");
          },
        },
      },
    );

    expect(result.refreshWarning).toMatch(/status could not be refreshed/iu);
    expect(result.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "rev-list", "--count", "HEAD"))
      .toBe(String(Number(before) + 1));
  });

  it("rejects a recovery journal with an out-of-repository HEAD path", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed journal source\n");
    const review = await captureGitCommitReview(root);
    const indexPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const outside = mkdtempSync(join(tmpdir(), "inertia-foreign-head-"));
    roots.push(outside);
    const outsideHead = join(outside, "HEAD");
    const outsideLock = `${outsideHead}.lock`;
    writeFileSync(outsideHead, "ref: refs/heads/main\n");
    writeFileSync(outsideLock, "foreign lock\n");
    const head = git(root, "rev-parse", "HEAD");
    const refPath = git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "refs/heads/main",
    );
    writeFileSync(`${indexPath}.inertia-commit-transaction.json`, JSON.stringify({
      expectedHead: head,
      headRef: "refs/heads/main",
      headPath: outsideHead,
      refPath,
      newCommit: head,
      oldIndexHash: "1".repeat(64),
      newIndexHash: createHash("sha256")
        .update(readFileSync(indexPath)).digest("hex"),
      indexPath,
      stagePath: `${indexPath}.inertia-stage-${"c".repeat(32)}`,
      reservationToken: "3".repeat(64),
    }));

    await expect(commitReviewedChanges(
      root,
      "Must reject foreign journal",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/does not belong to this repository/iu);

    expect(readFileSync(outsideLock, "utf8")).toBe("foreign lock\n");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });
});

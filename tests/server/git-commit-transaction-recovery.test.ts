import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureGitCommitReview,
  commitReviewedChanges,
} from "../../src/server/git";

const roots: string[] = [];

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

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-commit-recovery-"));
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

function reftableRepository(): string | null {
  const root = mkdtempSync(join(tmpdir(), "inertia-reftable-review-"));
  roots.push(root);
  try {
    git(root, "init", "-q", "--initial-branch=main", "--ref-format=reftable");
  } catch {
    return null;
  }
  git(root, "config", "user.email", "tests@inertia.invalid");
  git(root, "config", "user.name", "Inertia Tests");
  writeFileSync(join(root, "selected.txt"), "selected before\n");
  git(root, "add", "--", "selected.txt");
  git(root, "commit", "-q", "-m", "Initial");
  return root;
}

function leaveRestartTransaction(
  root: string,
  createReservation = false,
): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "inertia-restart-fixture-"));
  roots.push(fixtureRoot);
  const fixturePath = join(fixtureRoot, "leave-commit-transaction.cjs");
  writeFileSync(fixturePath, `
const { createHash } = require("node:crypto");
const { copyFileSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const root = process.argv[2];
const createReservation = process.argv[3] === "true";
const run = (...args) => execFileSync("git", args, {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
}).trim();
const indexPath = run("rev-parse", "--path-format=absolute", "--git-path", "index");
const temporaryIndex = join(root, ".git", "restart-reconciled.index");
copyFileSync(indexPath, temporaryIndex);
const gitEnv = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
execFileSync("git", ["add", "--", "selected.txt"], { cwd: root, env: gitEnv });
const tree = execFileSync("git", ["write-tree"], {
  cwd: root, env: gitEnv, encoding: "utf8",
}).trim();
const oldHead = run("rev-parse", "HEAD");
const commit = execFileSync("git", ["commit-tree", tree, "-p", oldHead, "-m", "Restart recovery"], {
  cwd: root, encoding: "utf8",
}).trim();
const stagePath = indexPath + ".inertia-stage-" + "d".repeat(32);
const token = "4".repeat(64);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const journalPath = indexPath + ".inertia-commit-transaction.json";
writeFileSync(journalPath, JSON.stringify({
  expectedHead: oldHead,
  headRef: "refs/heads/main",
  headPath: run("rev-parse", "--path-format=absolute", "--git-path", "HEAD"),
  refPath: run("rev-parse", "--path-format=absolute", "--git-path", "refs/heads/main"),
  newCommit: commit,
  oldIndexHash: hash(readFileSync(indexPath)),
  newIndexHash: hash(readFileSync(temporaryIndex)),
  indexPath,
  stagePath,
  reservationToken: token,
}));
renameSync(temporaryIndex, stagePath);
if (createReservation) {
  writeFileSync(indexPath + ".lock", token + "\\n", { flag: "wx", mode: 0o600 });
}
execFileSync("git", ["update-ref", "refs/heads/main", commit, oldHead], { cwd: root });
`);
  execFileSync(process.execPath, [fixturePath, root, String(createReservation)]);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("reviewed commit transaction recovery", () => {
  it("preserves a colliding private stage without advancing the commit", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed stage collision\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git", "index"));
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const foreignStage = Buffer.from("foreign private stage\n");
    let collisionPath: string | undefined;

    await expect(commitReviewedChanges(
      root,
      "Must preserve a private-stage collision",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforePrivateIndexStageCreate: (stagePath) => {
            collisionPath = stagePath;
            writeFileSync(stagePath, foreignStage, { mode: 0o600 });
          },
        },
      },
    )).rejects.toThrow(/private index stage/iu);

    expect(collisionPath).toBeDefined();
    expect(readFileSync(collisionPath!)).toEqual(foreignStage);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("preserves a replaced reservation after installing the exact stage", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed replacement-lock source\n");
    const review = await captureGitCommitReview(root);
    const originalHead = git(root, "rev-parse", "HEAD");
    const lockPath = join(root, ".git", "index.lock");
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const foreignLock = Buffer.from("foreign replacement lock\n");
    let privateStagePath: string | undefined;
    let expectedIndex: Buffer | undefined;

    const result = await commitReviewedChanges(
      root,
      "Commit without overwriting a foreign lock",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterIndexInstallBeforeReservationRelease: () => {
            const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
              stagePath: string;
            };
            privateStagePath = journal.stagePath;
            expectedIndex = readFileSync(join(root, ".git", "index"));
            rmSync(lockPath);
            writeFileSync(lockPath, foreignLock);
          },
        },
      },
    );

    expect(git(root, "rev-parse", "HEAD")).not.toBe(originalHead);
    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(git(root, "show", "HEAD:selected.txt"))
      .toBe("reviewed replacement-lock source");
    expect(expectedIndex).toBeDefined();
    expect(readFileSync(join(root, ".git", "index"))).toEqual(expectedIndex);
    expect(readFileSync(lockPath)).toEqual(foreignLock);
    expect(privateStagePath).toBeDefined();
    expect(existsSync(privateStagePath!)).toBe(false);
    expect(readFileSync(journalPath, "utf8")).toContain(result.commit);
  });

  it("recovers the exact stage after an install acknowledgement failure", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed recovery-lock source\n");
    const review = await captureGitCommitReview(root);
    const lockPath = join(root, ".git", "index.lock");
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );

    const result = await commitReviewedChanges(
      root,
      "Recover exact private reviewed index",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforeIndexInstall: () => {
            throw new Error("Simulated lost private-index install acknowledgement.");
          },
        },
      },
    );

    expect(result.refreshWarning).toBeUndefined();
    expect(result.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "show", "HEAD:selected.txt"))
      .toBe("reviewed recovery-lock source");
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(join(root, ".git")))
      .not.toContainEqual(expect.stringContaining("index.inertia-stage-"));
    expect(existsSync(journalPath)).toBe(false);
  });

  it("recovers a committed stage after the creating process exits", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed restart source\n");
    const staleReview = await captureGitCommitReview(root);
    const originalHead = git(root, "rev-parse", "HEAD");
    leaveRestartTransaction(root);

    await expect(commitReviewedChanges(
      root,
      "Stale request after restart recovery",
      ["selected.txt"],
      staleReview.fingerprint,
    )).rejects.toThrow(/no changes to review|no longer part|changed after.*reviewed/iu);

    expect(git(root, "rev-parse", "HEAD")).not.toBe(originalHead);
    expect(git(root, "show", "HEAD:selected.txt"))
      .toBe("reviewed restart source");
    expect(git(root, "status", "--short")).toBe("");
    expect(git(root, "write-tree"))
      .toBe(git(root, "rev-parse", "HEAD^{tree}"));
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    expect(existsSync(join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    ))).toBe(false);
    expect(readdirSync(join(root, ".git")))
      .not.toContainEqual(expect.stringContaining("index.inertia-stage-"));
  });

  it("preserves restart artifacts when Git wins reservation reacquisition", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed restart race\n");
    const staleReview = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    leaveRestartTransaction(root);
    const lockPath = join(root, ".git", "index.lock");
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    const foreignLock = Buffer.from("normal Git recovery race\n");

    await expect(commitReviewedChanges(
      root,
      "Must not race Git during recovery",
      ["selected.txt"],
      staleReview.fingerprint,
      {
        testHooks: {
          beforeRecoveryReservationAcquire: () => {
            writeFileSync(lockPath, foreignLock, { flag: "wx" });
          },
        },
      },
    )).rejects.toThrow(/could not reserve the repository index/iu);

    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(readFileSync(lockPath)).toEqual(foreignLock);
    expect(existsSync(journal.stagePath)).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("rejects a completed Git mutation before restart reservation reacquisition", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed stale restart stage\n");
    const staleReview = await captureGitCommitReview(root);
    leaveRestartTransaction(root);
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };

    await expect(commitReviewedChanges(
      root,
      "Must reject post-crash Git drift",
      ["selected.txt"],
      staleReview.fingerprint,
      {
        testHooks: {
          beforeRecoveryReservationAcquire: () => {
            writeFileSync(join(root, "other.txt"), "other independently staged\n");
            git(root, "add", "--", "other.txt");
          },
        },
      },
    )).rejects.toThrow(/repository drift after reserving the index/iu);

    expect(git(root, "diff", "--cached", "--name-only"))
      .toContain("other.txt");
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    expect(existsSync(journal.stagePath)).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("preserves a late private-stage collision during reservation release", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed release collision\n");
    const review = await captureGitCommitReview(root);
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const foreignStage = Buffer.from("late private stage collision\n");
    let stagePath: string | undefined;

    const result = await commitReviewedChanges(
      root,
      "Preserve a late stage collision",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterIndexInstallBeforeReservationRelease: () => {
            const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
              stagePath: string;
            };
            stagePath = journal.stagePath;
            writeFileSync(stagePath, foreignStage, { flag: "wx" });
          },
        },
      },
    );

    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(git(root, "show", "HEAD:selected.txt"))
      .toBe("reviewed release collision");
    expect(readFileSync(stagePath!)).toEqual(foreignStage);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("retains recovery state when Windows cannot unlink the reservation", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed unlink failure\n");
    const review = await captureGitCommitReview(root);
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const unlinkFailure = Object.assign(new Error("sharing violation"), {
      code: "EPERM",
    });

    const result = await commitReviewedChanges(
      root,
      "Retain Windows unlink recovery",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforeIndexReservationUnlink: () => {
            throw unlinkFailure;
          },
        },
      },
    );

    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(git(root, "show", "HEAD:selected.txt"))
      .toBe("reviewed unlink failure");
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("retains the stage and journal when Windows cannot install the index", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed rename failure\n");
    const review = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );

    const result = await commitReviewedChanges(
      root,
      "Retain Windows rename recovery",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforePrivateIndexStageRename: () => {
            throw Object.assign(new Error("sharing violation"), {
              code: "EPERM",
            });
          },
        },
      },
    );

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(existsSync(journal.stagePath)).toBe(true);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(true);
  });

  it("keeps the journal when private-stage cleanup is blocked", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed cleanup failure\n");
    const review = await captureGitCommitReview(root);
    const head = git(root, "rev-parse", "HEAD");
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );

    await expect(commitReviewedChanges(
      root,
      "Retain blocked stage cleanup",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          beforeTransactionLock: () => {
            throw new Error("Stop before reservation acquisition.");
          },
          beforePrivateIndexStageUnlink: () => {
            throw Object.assign(new Error("sharing violation"), {
              code: "EPERM",
            });
          },
        },
      },
    )).rejects.toThrow(/sharing violation/iu);

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(journal.stagePath)).toBe(true);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("retains the stage when another operation replaces the reservation", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed foreign-lock source\n");
    const review = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    const lockPath = join(root, ".git", "index.lock");
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const foreignLock = Buffer.from("foreign pre-install lock\n");

    const result = await commitReviewedChanges(
      root,
      "Preserve foreign reservation",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterPrivateIndexStageValidation: () => {
            rmSync(lockPath);
            writeFileSync(lockPath, foreignLock);
          },
        },
      },
    );

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(readFileSync(lockPath)).toEqual(foreignLock);
    expect(existsSync(journal.stagePath)).toBe(true);
    expect(readFileSync(journal.stagePath)).not.toEqual(foreignLock);
  });

  it("rejects in-place stage mutation after asynchronous validation", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed stage bytes\n");
    const review = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );

    const result = await commitReviewedChanges(
      root,
      "Reject mutated private stage",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterPrivateIndexStageValidation: () => {
            const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
              stagePath: string;
            };
            writeFileSync(journal.stagePath, "mutated in place\n");
          },
        },
      },
    );

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(readFileSync(journal.stagePath, "utf8"))
      .toBe("mutated in place\n");
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(true);
  });

  it("rejects lock-path replacement after hashing the private stage", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed final lock binding\n");
    const review = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    const lockPath = join(root, ".git", "index.lock");
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const foreignLock = Buffer.from("foreign lock during stage hash\n");

    const result = await commitReviewedChanges(
      root,
      "Reject final lock replacement",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterPrivateIndexStageHash: () => {
            rmSync(lockPath);
            writeFileSync(lockPath, foreignLock);
          },
        },
      },
    );

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(readFileSync(lockPath)).toEqual(foreignLock);
    expect(existsSync(journal.stagePath)).toBe(true);
  });

  it("rejects in-place stage mutation after the first descriptor hash", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed final stage bytes\n");
    const review = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );

    const result = await commitReviewedChanges(
      root,
      "Reject post-hash stage mutation",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterPrivateIndexStageHash: () => {
            const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
              stagePath: string;
            };
            writeFileSync(journal.stagePath, "post-hash mutation\n");
          },
        },
      },
    );

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(readFileSync(journal.stagePath, "utf8"))
      .toBe("post-hash mutation\n");
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(true);
  });

  it("rejects stage-path replacement after hashing its retained descriptor", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed final stage binding\n");
    const review = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const foreignStage = Buffer.from("foreign stage during hash\n");

    const result = await commitReviewedChanges(
      root,
      "Reject final stage replacement",
      ["selected.txt"],
      review.fingerprint,
      {
        testHooks: {
          afterPrivateIndexStageHash: () => {
            const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
              stagePath: string;
            };
            rmSync(journal.stagePath);
            writeFileSync(journal.stagePath, foreignStage);
          },
        },
      },
    );

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    expect(result.refreshWarning).toMatch(/index recovery.*manual/iu);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(readFileSync(journal.stagePath)).toEqual(foreignStage);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(true);
  });

  it("rejects a ref-only move at the final restart install boundary", async () => {
    const root = repository();
    writeFileSync(join(root, "selected.txt"), "reviewed final ref binding\n");
    const staleReview = await captureGitCommitReview(root);
    const originalIndex = readFileSync(join(root, ".git", "index"));
    leaveRestartTransaction(root);
    const journalPath = join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      stagePath: string;
    };
    let foreignCommit: string | undefined;

    await expect(commitReviewedChanges(
      root,
      "Reject final ref move",
      ["selected.txt"],
      staleReview.fingerprint,
      {
        testHooks: {
          beforePrivateIndexStageRename: () => {
            const current = git(root, "rev-parse", "HEAD");
            foreignCommit = git(
              root,
              "commit-tree",
              `${current}^{tree}`,
              "-p",
              current,
              "-m",
              "Foreign ref-only move",
            );
            git(
              root,
              "update-ref",
              "refs/heads/main",
              foreignCommit,
              current,
            );
          },
        },
      },
    )).rejects.toThrow(/replaced the reviewed commit reservation/iu);

    expect(foreignCommit).toBeDefined();
    expect(git(root, "rev-parse", "HEAD")).toBe(foreignCommit);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
    expect(existsSync(journal.stagePath)).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("commits safely when the files backend starts from a packed ref", async () => {
    const root = repository();
    git(root, "pack-refs", "--all");
    expect(git(
      root,
      "config",
      "--local",
      "--get",
      "--default",
      "files",
      "extensions.refStorage",
    )).toBe("files");
    expect(existsSync(join(root, ".git", "refs", "heads", "main")))
      .toBe(false);
    writeFileSync(join(root, "selected.txt"), "reviewed packed ref\n");
    const review = await captureGitCommitReview(root);

    const result = await commitReviewedChanges(
      root,
      "Commit from a packed branch",
      ["selected.txt"],
      review.fingerprint,
    );

    expect(result.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "show", "HEAD:selected.txt")).toBe("reviewed packed ref");
    expect(existsSync(join(root, ".git", "refs", "heads", "main")))
      .toBe(true);
  });

  it("rejects reftable before creating reviewed transaction state", async ({
    skip,
  }) => {
    const root = reftableRepository();
    if (root === null) return skip("This Git build cannot initialize reftable.");
    writeFileSync(join(root, "selected.txt"), "unsupported reftable edit\n");
    const review = await captureGitCommitReview(root);
    const originalHead = git(root, "rev-parse", "HEAD");
    const originalCommitCount = git(root, "rev-list", "--all", "--count");

    await expect(commitReviewedChanges(
      root,
      "Do not commit through reftable",
      ["selected.txt"],
      review.fingerprint,
    )).rejects.toThrow(/require Git's files reference format/iu);

    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    expect(git(root, "rev-list", "--all", "--count"))
      .toBe(originalCommitCount);
    expect(existsSync(join(
      root,
      ".git",
      "index.inertia-commit-transaction.json",
    ))).toBe(false);
  });
});

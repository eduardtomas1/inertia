import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { NETWORK_TIMEOUT_MS } from "./constants";
import {
  repositoryRoot,
  validatedPaths,
} from "./paths";
import {
  runGit,
  runGitInspection,
  withPreparedGitRefUpdate,
} from "./runner";
import { getRepositoryStatus, hasHead } from "./status";
import {
  deriveGitCommitSelection,
  gitCommitReviewFingerprintsEqual,
  prepareGitCommitSelection,
  prepareGitCommitReview,
  requireGitCommitReviewFingerprint,
} from "./commit-review";
import {
  GitError,
  type GitCommitResult,
} from "./types";
import {
  acquireIndexReservationSync,
  commitLockIdentity,
  createPrivateIndexStagePath,
  installPrivateIndexStageSync,
  isOwnedReservation,
  parseCommitTransactionJournal,
  releaseOwnedIndexReservation,
  removeVerifiedStageSync,
  reservationBytes,
  sameCommitLockIdentity,
  type CommitLockIdentity,
  type CommitTransactionJournal,
} from "./commit-transaction";
import { prepareReconciledIndex, readIndexSync } from "./commit-index";

const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const REFERENCE_LOCK_RELEASE_GRACE_MS = 500;
const REFERENCE_LOCK_POLL_MS = 10;
const COMMIT_POLICY_HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "reference-transaction",
] as const;

interface CommitHeadState {
  head: string | null;
  headRef: string | null;
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function stripTerminalEol(value: string): string {
  return value.replace(/(?:\r\n|\n)$/u, "");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function syncDirectorySync(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(dirname(path), "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed best-effort directory sync must not mask the Git result.
      }
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return false;
    throw error;
  }
}

async function waitForReferenceLocksToRelease(
  headLockPath: string,
  refLockPath: string,
): Promise<boolean> {
  // Git for Windows can close the prepared update process just before its
  // reference-lock deletions become observable. This is a cleanup-only grace;
  // the operation deadline has already revoked every reviewed mutation.
  const expiresAt = Date.now() + REFERENCE_LOCK_RELEASE_GRACE_MS;
  while (await pathExists(headLockPath) || await pathExists(refLockPath)) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(REFERENCE_LOCK_POLL_MS, remaining));
  }
  return true;
}

async function readOptionalRegularFile(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_INDEX_BYTES) {
      throw new GitError(
        "output-limit",
        "The repository index is unavailable for an atomic reviewed commit.",
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readRegularFile(path: string): Promise<Buffer> {
  return await readOptionalRegularFile(path) ?? Buffer.alloc(0);
}

async function headState(
  root: string,
  options: { deadlineAt?: number } = {},
): Promise<CommitHeadState> {
  const currentHasHead = await hasHead(root, options);
  const head = currentHasHead
    ? (await runGitInspection(root, ["rev-parse", "--verify", "HEAD"], {
        deadlineAt: options.deadlineAt,
        maxOutputBytes: 256,
        failureMessage: "Unable to verify the reviewed commit parent.",
      })).stdout.toString("utf8").trim()
    : null;
  let headRef: string | null = null;
  try {
    const symbolicHead = await runGitInspection(
      root,
      ["symbolic-ref", "--quiet", "HEAD"],
      {
        deadlineAt: options.deadlineAt,
        maxOutputBytes: 4_096,
        failureMessage: "Unable to verify the reviewed branch.",
      },
    );
    headRef = stripTerminalEol(symbolicHead.stdout.toString("utf8")) || null;
  } catch (error) {
    if (!(error instanceof GitError && error.code === "operation-failed")) {
      throw error;
    }
  }
  return { head, headRef };
}

async function optionalGitValue(
  root: string,
  args: readonly string[],
  failureMessage: string,
  deadlineAt?: number,
): Promise<string | null> {
  try {
    const result = await runGitInspection(root, args, {
      deadlineAt,
      maxOutputBytes: 4_096,
      failureMessage,
    });
    return stripTerminalEol(result.stdout.toString("utf8")) || null;
  } catch (error) {
    if (error instanceof GitError && error.code === "operation-failed") {
      return null;
    }
    throw error;
  }
}

async function ensureReviewedCommitPolicy(
  root: string,
  options: { deadlineAt?: number } = {},
): Promise<void> {
  let referenceFormat = "unsupported";
  try {
    referenceFormat = stripTerminalEol((await runGitInspection(root, [
      "config",
      "--local",
      "--get",
      "--default",
      "files",
      "extensions.refStorage",
    ], {
      deadlineAt: options.deadlineAt,
      maxOutputBytes: 256,
      failureMessage: "Unable to verify the repository reference format.",
    })).stdout.toString("utf8"));
  } catch (error) {
    if (!(error instanceof GitError && error.code === "operation-failed"))
      throw error;
  }
  if (referenceFormat !== "files") {
    throw new GitError(
      "conflict",
      "Reviewed commits currently require Git's files reference format.",
    );
  }
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_START",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
  ]) {
    const statePath = stripTerminalEol((await runGitInspection(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      name,
    ], {
      deadlineAt: options.deadlineAt,
      maxOutputBytes: 4_096,
      failureMessage: "Unable to verify the repository operation state.",
    })).stdout.toString("utf8"));
    if (await pathExists(statePath)) {
      throw new GitError(
        "conflict",
        name === "rebase-apply"
          || name === "rebase-merge"
          || name === "sequencer"
          ? "Finish the active rebase, apply, or sequenced Git operation before creating a reviewed commit."
          : "Finish the active merge, cherry-pick, revert, or bisect before creating a reviewed commit.",
      );
    }
  }
  const signing = await optionalGitValue(
    root,
    ["config", "--type=bool", "--get", "commit.gpgSign"],
    "Unable to verify the repository signing policy.",
    options.deadlineAt,
  );
  if (signing === "true") {
    throw new GitError(
      "conflict",
      "Reviewed commits are unavailable while automatic commit signing is enabled.",
    );
  }
  if (await optionalGitValue(
    root,
    ["config", "--path", "--get", "core.hooksPath"],
    "Unable to verify the repository hook policy.",
    options.deadlineAt,
  )) {
    throw new GitError(
      "conflict",
      "Reviewed commits are unavailable while a custom Git hooks path is configured.",
    );
  }
  const hooks = await runGitInspection(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ], {
    deadlineAt: options.deadlineAt,
    maxOutputBytes: 4_096,
    failureMessage: "Unable to verify the repository hook policy.",
  });
  const hooksPath = stripTerminalEol(hooks.stdout.toString("utf8"));
  for (const hook of COMMIT_POLICY_HOOKS) {
    await access(`${hooksPath}/${hook}`, fsConstants.F_OK).then(() => {
      throw new GitError(
        "conflict",
        "Reviewed commits are unavailable while commit policy hooks are installed.",
      );
    }).catch((error) => {
      if (error instanceof GitError) throw error;
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "ENOENT"
      ) throw error;
    });
  }
}

async function commitIndexPath(root: string): Promise<string> {
  return (await runGitInspection(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ], {
    maxOutputBytes: 4_096,
    failureMessage: "Unable to locate the repository index.",
  })).stdout.toString("utf8").replace(/(?:\r\n|\n)$/u, "");
}

async function commitHeadPath(root: string): Promise<string> {
  return stripTerminalEol((await runGitInspection(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "HEAD",
  ], {
    maxOutputBytes: 4_096,
    failureMessage: "Unable to locate the repository HEAD.",
  })).stdout.toString("utf8"));
}

async function commitRefPath(root: string, ref: string): Promise<string> {
  return stripTerminalEol((await runGitInspection(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    ref,
  ], {
    maxOutputBytes: 4_096,
    failureMessage: "Unable to locate the reviewed branch reference.",
  })).stdout.toString("utf8"));
}

async function referenceOid(root: string, ref: string): Promise<string | null> {
  const value = stripTerminalEol((await runGitInspection(root, [
    "for-each-ref",
    "--format=%(objectname)",
    "--count=1",
    ref,
  ], {
    maxOutputBytes: 256,
    failureMessage: "Unable to inspect the reviewed branch reference.",
  })).stdout.toString("utf8"));
  if (value === "") return null;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new GitError(
      "conflict",
      "The reviewed branch reference is invalid.",
    );
  }
  return value;
}

async function recoverCommitTransaction(
  root: string,
  options: {
    ownedIndexLockIdentity?: CommitLockIdentity | null;
    reservationWasNeverAcquired?: boolean;
    beforeReservationAcquire?: () => void | Promise<void>;
    afterStageValidation?: () => void | Promise<void>;
    beforeStageRename?: () => void;
    afterStageHash?: () => void;
    beforeStageUnlink?: () => void | Promise<void>;
    beforeReservationUnlink?: () => void;
  } = {},
): Promise<void> {
  const indexPath = await commitIndexPath(root);
  const lockPath = `${indexPath}.lock`;
  const journalPath = `${indexPath}.inertia-commit-transaction.json`;
  const journalBytes = await readRegularFile(journalPath);
  if (journalBytes.length === 0) return;
  if (journalBytes.length > 4_096) {
    throw new GitError("conflict", "The reviewed commit recovery journal is invalid.");
  }
  const journal = parseCommitTransactionJournal(journalBytes, indexPath);
  try {
    await runGitInspection(root, ["check-ref-format", journal.headRef], {
      maxOutputBytes: 1_024,
      failureMessage: "Unable to verify the reviewed branch recovery reference.",
    });
  } catch {
    throw new GitError("conflict", "The reviewed commit recovery journal is invalid.");
  }
  if (
    journal.headPath !== await commitHeadPath(root)
    || journal.refPath !== await commitRefPath(root, journal.headRef)
  ) {
    throw new GitError(
      "conflict",
      "The reviewed commit recovery journal does not belong to this repository.",
    );
  }
  const current = await headState(root);
  const currentHeadContent = await readOptionalRegularFile(journal.headPath);
  if (
    current.headRef !== journal.headRef
    || currentHeadContent === null
    || stripTerminalEol(currentHeadContent.toString("utf8"))
      !== `ref: ${journal.headRef}`
  ) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery found that the checked-out branch changed. Inspect it before continuing.",
    );
  }
  const lock = await readOptionalRegularFile(lockPath);
  const stage = await readOptionalRegularFile(journal.stagePath);
  const observedLockIdentity = lock === null
    ? null
    : await commitLockIdentity(lockPath);
  const observedStageIdentity = stage === null
    ? null
    : await commitLockIdentity(journal.stagePath);
  const lockIsOwned = isOwnedReservation(
    lock,
    observedLockIdentity,
    journal.reservationToken,
    options.ownedIndexLockIdentity,
  );
  const stageIsIndex = stage !== null
    && digest(stage) === journal.newIndexHash;
  const headLockPath = `${journal.headPath}.lock`;
  const headLock = await readOptionalRegularFile(headLockPath);
  const refLock = await readOptionalRegularFile(`${journal.refPath}.lock`);
  const requireReferenceLocksFree = (): void => {
    if (headLock !== null || refLock !== null) {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery found a Git lock owned by another operation. Inspect it before continuing.",
      );
    }
  };
  const removeJournal = async (): Promise<void> => {
    await unlink(journalPath);
    await syncDirectory(journalPath);
  };
  const requireValidStage = (): void => {
    if (stage !== null && !stageIsIndex) {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery found an invalid private index stage. Inspect it before continuing.",
      );
    }
  };
  const requireOwnedOrAbsentLock = (): void => {
    if (lock !== null && !lockIsOwned) {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery found a Git lock owned by another operation. Inspect it before continuing.",
      );
    }
  };
  const removeVerifiedArtifacts = async (): Promise<void> => {
    requireReferenceLocksFree();
    requireValidStage();
    requireOwnedOrAbsentLock();
    if (stageIsIndex) {
      await options.beforeStageUnlink?.();
      removeVerifiedStageSync(
        journal.stagePath,
        observedStageIdentity!,
      );
      await syncDirectory(journal.stagePath);
    }
    await releaseOwnedIndexReservation(
      lockPath,
      journal.stagePath,
      journal.reservationToken,
      options.ownedIndexLockIdentity ?? observedLockIdentity,
      options.beforeReservationUnlink,
    );
  };
  if (current.head === journal.expectedHead) {
    if (digest(await readRegularFile(indexPath)) !== journal.oldIndexHash) {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery found that the repository index changed. Inspect it before continuing.",
      );
    }
    if (options.reservationWasNeverAcquired && lock !== null && !lockIsOwned) {
      requireReferenceLocksFree();
      requireValidStage();
      if (!stageIsIndex) {
        throw new GitError(
          "conflict",
          "A reviewed commit recovery requires manual Git inspection before continuing.",
        );
      }
      await options.beforeStageUnlink?.();
      removeVerifiedStageSync(
        journal.stagePath,
        observedStageIdentity!,
      );
      await syncDirectory(journal.stagePath);
    } else {
      await removeVerifiedArtifacts();
    }
    await removeJournal();
    return;
  }
  if (current.head !== journal.newCommit) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery requires manual Git inspection before continuing.",
    );
  }
  const currentIndex = await readRegularFile(indexPath);
  if (digest(currentIndex) === journal.newIndexHash) {
    await removeVerifiedArtifacts();
    await removeJournal();
    return;
  }
  if (digest(currentIndex) !== journal.oldIndexHash) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery requires manual Git inspection before continuing.",
    );
  }
  requireReferenceLocksFree();
  if (!stageIsIndex) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery requires manual Git inspection before continuing.",
    );
  }
  let recoveryLockIdentity = observedLockIdentity;
  if (lock === null) {
    await options.beforeReservationAcquire?.();
    try {
      recoveryLockIdentity = acquireIndexReservationSync(
        lockPath,
        journal.reservationToken,
      );
    } catch {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery could not reserve the repository index. Inspect it before continuing.",
      );
    }
  } else if (!lockIsOwned) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery found a Git lock owned by another operation. Inspect it before continuing.",
    );
  }
  const reservedIndex = await readRegularFile(indexPath);
  const reservedStage = await readOptionalRegularFile(journal.stagePath);
  const reservedStageIdentity = reservedStage === null
    ? null
    : await commitLockIdentity(journal.stagePath);
  const reservedHeadContent = await readOptionalRegularFile(journal.headPath);
  const reservedHead = await headState(root);
  const reservedRef = await referenceOid(root, journal.headRef);
  const reservedHeadLock = await readOptionalRegularFile(
    `${journal.headPath}.lock`,
  );
  const reservedRefLock = await readOptionalRegularFile(
    `${journal.refPath}.lock`,
  );
  if (
    digest(reservedIndex) !== journal.oldIndexHash
    || reservedStage === null
    || digest(reservedStage) !== journal.newIndexHash
    || reservedStageIdentity === null
    || !sameCommitLockIdentity(
      observedStageIdentity!,
      reservedStageIdentity,
    )
    || reservedHead.head !== journal.newCommit
    || reservedHead.headRef !== journal.headRef
    || reservedRef !== journal.newCommit
    || reservedHeadContent === null
    || stripTerminalEol(reservedHeadContent.toString("utf8"))
      !== `ref: ${journal.headRef}`
    || reservedHeadLock !== null
    || reservedRefLock !== null
  ) {
    await releaseOwnedIndexReservation(
      lockPath,
      journal.stagePath,
      journal.reservationToken,
      recoveryLockIdentity,
      options.beforeReservationUnlink,
      true,
    ).catch(() => undefined);
    throw new GitError(
      "conflict",
      "A reviewed commit recovery found repository drift after reserving the index. Inspect it before continuing.",
    );
  }
  await options.afterStageValidation?.();
  installPrivateIndexStageSync({
    stagePath: journal.stagePath,
    indexPath,
    lockPath,
    headPath: journal.headPath,
    refPath: journal.refPath,
    headRef: journal.headRef,
    newCommit: journal.newCommit,
    token: journal.reservationToken,
    stageIdentity: reservedStageIdentity,
    stageHash: journal.newIndexHash,
    lockIdentity: recoveryLockIdentity!,
    beforeFinalValidation: options.beforeStageRename,
    afterStageHash: options.afterStageHash,
  });
  await syncDirectory(indexPath);
  await releaseOwnedIndexReservation(
    lockPath,
    journal.stagePath,
    journal.reservationToken,
    recoveryLockIdentity,
    options.beforeReservationUnlink,
  );
  await removeJournal();
}

async function reviewedCommitResult(
  root: string,
  commit: string,
  fallbackStatus: GitCommitResult["status"],
  refreshWarning?: string,
  beforeStatus?: () => void | Promise<void>,
): Promise<GitCommitResult> {
  try {
    await beforeStatus?.();
    return {
      commit,
      status: await getRepositoryStatus(root),
      ...(refreshWarning ? { refreshWarning } : {}),
    };
  } catch {
    return {
      commit,
      status: fallbackStatus,
      refreshWarning: refreshWarning
        ?? "The commit was created, but repository status could not be refreshed yet.",
    };
  }
}

export async function commitChanges(
  repositoryPath: string,
  message: string,
  paths?: readonly string[],
): Promise<GitCommitResult> {
  const root = await repositoryRoot(repositoryPath);
  if (
    typeof message !== "string"
    || message.trim().length === 0
    || message.length > 10_000
    || message.includes("\0")
  ) {
    throw new GitError(
      "invalid-input",
      "Enter a commit message between 1 and 10,000 characters.",
    );
  }
  if (paths && paths.length === 0) {
    throw new GitError(
      "invalid-input",
      "Select at least one path to commit.",
    );
  }
  const selected = paths ? await validatedPaths(root, paths) : null;
  await runGit(root, ["add", "-A", "--", ...(selected ?? [])], {
    failureMessage: "Unable to stage the selected changes.",
  });
  await runGit(
    root,
    ["commit", "-m", message, ...(selected ? ["--", ...selected] : [])],
    {
      timeoutMs: NETWORK_TIMEOUT_MS,
      failureMessage: "Unable to create the commit.",
    },
  );
  const commitResult = await runGit(root, ["rev-parse", "HEAD"], {
    maxOutputBytes: 256,
    failureMessage:
      "The commit was created, but its identifier could not be read.",
  });
  return {
    commit: commitResult.stdout.toString("utf8").trim(),
    status: await getRepositoryStatus(root),
  };
}

export async function commitReviewedChanges(
  repositoryPath: string,
  message: string,
  paths: readonly string[],
  expectedReviewFingerprint: string,
  options: {
    deadlineAt?: number;
    verifyRepositoryIdentity?: (signal?: AbortSignal) => void | Promise<void>;
    testHooks?: {
      afterFinalReview?: () => void | Promise<void>;
      runCommitTree?: typeof runGit;
      beforeTransactionLock?: () => void | Promise<void>;
      beforePrivateIndexStageCreate?: (
        stagePath: string,
      ) => void | Promise<void>;
      beforeRecoveryReservationAcquire?: () => void | Promise<void>;
      duringPreparedMutation?: () => void;
      afterReferenceCommit?: () => void | Promise<void>;
      beforeIndexInstall?: () => void | Promise<void>;
      afterPrivateIndexStageValidation?: () => void | Promise<void>;
      beforePrivateIndexStageRename?: () => void;
      afterPrivateIndexStageHash?: () => void;
      afterIndexInstallBeforeReservationRelease?: () => void | Promise<void>;
      beforePrivateIndexStageUnlink?: () => void | Promise<void>;
      beforeIndexReservationUnlink?: () => void;
      beforePostCommitStatus?: () => void | Promise<void>;
    };
  } = {},
): Promise<GitCommitResult> {
  const root = await repositoryRoot(repositoryPath, options);
  if (
    typeof message !== "string"
    || message.trim().length === 0
    || message.length > 10_000
    || message.includes("\0")
  ) {
    throw new GitError(
      "invalid-input",
      "Enter a commit message between 1 and 10,000 characters.",
    );
  }
  if (paths.length === 0) {
    throw new GitError("invalid-input", "Select at least one path to commit.");
  }
  await recoverCommitTransaction(root, {
    beforeReservationAcquire:
      options.testHooks?.beforeRecoveryReservationAcquire,
    afterStageValidation:
      options.testHooks?.afterPrivateIndexStageValidation,
    beforeStageRename:
      options.testHooks?.beforePrivateIndexStageRename,
    afterStageHash:
      options.testHooks?.afterPrivateIndexStageHash,
    beforeStageUnlink:
      options.testHooks?.beforePrivateIndexStageUnlink,
    beforeReservationUnlink:
      options.testHooks?.beforeIndexReservationUnlink,
  });
  await ensureReviewedCommitPolicy(root, options);
  const selected = await validatedPaths(root, paths, options);
  const expected = requireGitCommitReviewFingerprint(
    expectedReviewFingerprint,
  );
  const prepared = await prepareGitCommitReview(root, options);
  let finalSelection: Awaited<ReturnType<typeof prepareGitCommitSelection>> | null = null;
  try {
    const current = prepared.capture;
    const selectedSet = new Set(selected);
    const previousInputs = current.status.files.flatMap((file) =>
      selectedSet.has(file.path)
        && file.status === "renamed"
        && file.previousPath
        ? [file.previousPath]
        : []
    );
    const reviewedPaths = new Set(current.mutationPaths);
    const stagedPaths = [...new Set([...selected, ...previousInputs])];
    if (selected.some((path) =>
      !current.status.files.some((file) => file.path === path)
    ) || stagedPaths.some((path) => !reviewedPaths.has(path))) {
      throw new GitError(
        "conflict",
        "A selected file is no longer part of the reviewed change set. Refresh and try again.",
      );
    }
    if (!gitCommitReviewFingerprintsEqual(expected, current.fingerprint)) {
      throw new GitError(
        "conflict",
        "The repository changed after its complete diff was reviewed. Refresh the diff and try again.",
      );
    }
    const expectedSelection = await deriveGitCommitSelection(
      root,
      prepared.selection,
      stagedPaths,
      current.mutationPaths,
      current.head,
      options,
    );
    finalSelection = await prepareGitCommitSelection(
      root,
      current.head,
      stagedPaths,
      options,
      false,
      current.removalPaths.filter((path) => stagedPaths.includes(path)),
    );
    if (finalSelection.tree !== expectedSelection.tree) {
      throw new GitError(
        "conflict",
        "The selected files changed while their commit state was being verified. Refresh and try again.",
      );
    }
    await options.testHooks?.afterFinalReview?.();
    await options.verifyRepositoryIdentity?.();
    const currentHead = await headState(root, options);
    if (
      currentHead.head !== current.head
      || currentHead.headRef !== current.headRef
    ) {
      throw new GitError(
        "conflict",
        "The branch changed while the selected commit was being prepared. Refresh and try again.",
      );
    }
    if (!currentHead.headRef) {
      throw new GitError(
        "conflict",
        "Reviewed commits require a checked-out branch. Switch from detached HEAD and try again.",
      );
    }
    const parentTreeResult = current.head
      ? await runGitInspection(
          root,
          ["rev-parse", "--verify", `${current.head}^{tree}`],
          {
            deadlineAt: options.deadlineAt,
            maxOutputBytes: 256,
            failureMessage: "Unable to verify the reviewed commit parent.",
          },
        )
      : await runGit(root, ["hash-object", "-t", "tree", "--stdin"], {
          deadlineAt: options.deadlineAt,
          input: Buffer.alloc(0),
          maxOutputBytes: 256,
          failureMessage: "Unable to verify the reviewed empty tree.",
        });
    const parentTree = stripTerminalEol(
      parentTreeResult.stdout.toString("utf8"),
    );
    if (finalSelection.tree === parentTree) {
      throw new GitError(
        "nothing-to-commit",
        "The selected files have no changes to commit.",
      );
    }
    const indexPath = await commitIndexPath(root);
    const originalIndex = await readRegularFile(indexPath);
    const originalIndexHash = digest(originalIndex);
    await options.verifyRepositoryIdentity?.();
    const commitResult = await (options.testHooks?.runCommitTree ?? runGit)(root, [
      "commit-tree",
      finalSelection.tree,
      ...(current.head ? ["-p", current.head] : []),
      "-F",
      "-",
    ], {
      deadlineAt: options.deadlineAt,
      timeoutMs: NETWORK_TIMEOUT_MS,
      environment: finalSelection.environment,
      input: Buffer.from(message),
      maxOutputBytes: 256,
      failureMessage: "Unable to create the reviewed commit object.",
    });
    const commit = commitResult.stdout.toString("utf8").trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
      throw new GitError(
        "operation-failed",
        "Git returned an invalid reviewed commit identifier.",
      );
    }
    const reconciledIndex = await prepareReconciledIndex(
      root,
      originalIndex,
      finalSelection.tree,
      stagedPaths,
      finalSelection.directory,
      options.deadlineAt,
    );
    const lockPath = `${indexPath}.lock`;
    const headPath = await commitHeadPath(root);
    const refPath = await commitRefPath(root, currentHead.headRef);
    const journalPath = `${indexPath}.inertia-commit-transaction.json`;
    const stagePath = createPrivateIndexStagePath(indexPath);
    const reservationToken = randomBytes(32).toString("hex");
    const journal: CommitTransactionJournal = {
      expectedHead: current.head,
      headRef: currentHead.headRef,
      headPath,
      refPath,
      newCommit: commit,
      oldIndexHash: originalIndexHash,
      newIndexHash: digest(reconciledIndex),
      indexPath,
      stagePath,
      reservationToken,
    };
    await options.verifyRepositoryIdentity?.();
    const journalHandle = await open(journalPath, "wx", 0o600).catch(() => {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery is already pending.",
      );
    });
    try {
      await journalHandle.writeFile(JSON.stringify(journal));
      await journalHandle.sync();
    } finally {
      await journalHandle.close();
    }
    await syncDirectory(journalPath);
    let stageCreated = false;
    let ownedStageIdentity: CommitLockIdentity | null = null;
    try {
      await options.testHooks?.beforePrivateIndexStageCreate?.(stagePath);
      const stageHandle = await open(
        stagePath,
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_WRONLY
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      stageCreated = true;
      try {
        const stageInfo = await stageHandle.stat({ bigint: true });
        ownedStageIdentity = {
          dev: stageInfo.dev,
          ino: stageInfo.ino,
          birthtimeNs: stageInfo.birthtimeNs,
        };
        await stageHandle.writeFile(reconciledIndex);
        await stageHandle.sync();
      } finally {
        await stageHandle.close();
      }
    } catch {
      if (stageCreated) {
        if (!ownedStageIdentity) {
          throw new GitError(
            "conflict",
            "The reviewed commit private index stage could not be verified. Inspect it manually before continuing.",
          );
        }
        try {
          removeVerifiedStageSync(stagePath, ownedStageIdentity);
          await syncDirectory(stagePath);
        } catch {
          throw new GitError(
            "conflict",
            "The reviewed commit private index stage could not be cleaned up. Inspect it manually before continuing.",
          );
        }
      }
      await unlink(journalPath).catch(() => undefined);
      await syncDirectory(journalPath);
      throw new GitError(
        "conflict",
        "Unable to reserve a private index stage for the reviewed commit.",
      );
    }
    await syncDirectory(stagePath);
    let committed = false;
    let ownsLock = false;
    let ownedIndexLockIdentity: CommitLockIdentity | null = null;
    let lock: number | null = null;
    try {
      await options.testHooks?.beforeTransactionLock?.();
      const expectedHead = current.head ?? "0".repeat(commit.length);
      await withPreparedGitRefUpdate(
        root,
        currentHead.headRef,
        commit,
        expectedHead,
        {
          deadlineAt: options.deadlineAt,
          failureMessage: "The branch changed before the reviewed commit could be applied.",
          testHooks: {
            afterCommitAcknowledged:
              options.testHooks?.afterReferenceCommit,
          },
        },
        async (context) => {
          context.assertActive();
          await options.verifyRepositoryIdentity?.(context.signal);
          context.assertActive();
          await ensureReviewedCommitPolicy(root, options);
          context.assertActive();
          const lockedHead = await readOptionalRegularFile(headPath);
          context.assertActive();
          if (
            lockedHead === null
            || stripTerminalEol(lockedHead.toString("utf8"))
              !== `ref: ${journal.headRef}`
          ) {
            throw new GitError(
              "conflict",
              "The checked-out branch changed before the reviewed commit. Refresh and try again.",
            );
          }
          context.mutate(() => {
            try {
              lock = openSync(
                lockPath,
                fsConstants.O_CREAT
                  | fsConstants.O_EXCL
                  | fsConstants.O_WRONLY
                  | (fsConstants.O_NOFOLLOW ?? 0),
                0o600,
              );
            } catch {
              throw new GitError(
                "conflict",
                "The repository index is busy. Wait for the other Git operation and try again.",
              );
            }
            ownsLock = true;
            try {
              const openedLockInfo = fstatSync(lock, { bigint: true });
              ownedIndexLockIdentity = {
                dev: openedLockInfo.dev,
                ino: openedLockInfo.ino,
                birthtimeNs: openedLockInfo.birthtimeNs,
              };
              options.testHooks?.duringPreparedMutation?.();
              if (digest(readIndexSync(indexPath)) !== originalIndexHash) {
                throw new GitError(
                  "conflict",
                  "The repository index changed before the reviewed commit. Refresh and try again.",
                );
              }
              writeFileSync(lock, reservationBytes(reservationToken));
              fsyncSync(lock);
              closeSync(lock);
              lock = null;
              syncDirectorySync(lockPath);
            } catch (error) {
              if (lock !== null) {
                try {
                  closeSync(lock);
                } catch {
                  // Cleanup below verifies ownership before removing the lock.
                }
                lock = null;
              }
              throw error;
            }
            return undefined;
          });
        },
      );
      committed = true;
      await options.verifyRepositoryIdentity?.();
      const committedHead = await readOptionalRegularFile(headPath);
      if (
        committedHead === null
        || stripTerminalEol(committedHead.toString("utf8"))
          !== `ref: ${journal.headRef}`
      ) {
        throw new GitError(
          "conflict",
          "The checked-out branch changed after the reviewed commit. Inspect it before continuing.",
        );
      }
      await options.testHooks?.beforeIndexInstall?.();
      const installStageIdentity = await commitLockIdentity(stagePath);
      const installStageContent = await readOptionalRegularFile(stagePath);
      if (
        !ownedIndexLockIdentity
        || !ownedStageIdentity
        || !installStageIdentity
        || !sameCommitLockIdentity(ownedStageIdentity, installStageIdentity)
        || installStageContent === null
        || digest(installStageContent) !== journal.newIndexHash
      ) {
        throw new GitError(
          "conflict",
          "Another Git operation replaced the reviewed commit reservation. Inspect it manually before continuing.",
        );
      }
      await options.testHooks?.afterPrivateIndexStageValidation?.();
      installPrivateIndexStageSync({
        stagePath,
        indexPath,
        lockPath,
        headPath,
        refPath,
        headRef: journal.headRef,
        newCommit: journal.newCommit,
        token: reservationToken,
        stageIdentity: ownedStageIdentity,
        stageHash: journal.newIndexHash,
        lockIdentity: ownedIndexLockIdentity,
        beforeFinalValidation:
          options.testHooks?.beforePrivateIndexStageRename,
        afterStageHash: options.testHooks?.afterPrivateIndexStageHash,
      });
      await syncDirectory(indexPath);
      await options.testHooks?.afterIndexInstallBeforeReservationRelease?.();
      await releaseOwnedIndexReservation(
        lockPath,
        stagePath,
        reservationToken,
        ownedIndexLockIdentity,
        options.testHooks?.beforeIndexReservationUnlink,
      );
      await unlink(journalPath);
      await syncDirectory(journalPath);
    } catch (error) {
      if (lock !== null) {
        try {
          closeSync(lock);
        } catch {
          // Cleanup below verifies ownership before removing the lock.
        }
        lock = null;
      }
      if (!committed) {
        if (!await waitForReferenceLocksToRelease(
          `${headPath}.lock`,
          `${refPath}.lock`,
        )) {
          throw new GitError(
            "conflict",
            "The reviewed commit transaction stopped with Git locks still present. Inspect it manually before continuing.",
          );
        }
        let observedRef: string | null;
        try {
          observedRef = await referenceOid(root, currentHead.headRef);
        } catch {
          throw new GitError(
            "conflict",
            `Commit ${commit.slice(0, 7)} may have been created, and the repository requires manual Git inspection.`,
          );
        }
        if (observedRef === commit) {
          committed = true;
        } else if (observedRef !== current.head) {
          throw new GitError(
            "conflict",
            "The reviewed branch changed during commit. Inspect it manually before continuing.",
          );
        }
      }
      if (!committed) {
        if (ownsLock && !ownedIndexLockIdentity) {
          throw new GitError(
            "conflict",
            "The reviewed commit stopped without a verifiable index lock. Inspect it manually before continuing.",
          );
        }
        await recoverCommitTransaction(root, {
          ownedIndexLockIdentity: ownsLock
            ? ownedIndexLockIdentity
            : null,
          reservationWasNeverAcquired: !ownsLock,
          beforeStageUnlink:
            options.testHooks?.beforePrivateIndexStageUnlink,
          beforeReservationUnlink:
            options.testHooks?.beforeIndexReservationUnlink,
          beforeStageRename:
            options.testHooks?.beforePrivateIndexStageRename,
          afterStageHash:
            options.testHooks?.afterPrivateIndexStageHash,
        });
      } else {
        try {
          await recoverCommitTransaction(root, {
            ownedIndexLockIdentity: ownsLock
              ? ownedIndexLockIdentity
              : null,
            beforeStageUnlink:
              options.testHooks?.beforePrivateIndexStageUnlink,
            beforeReservationUnlink:
              options.testHooks?.beforeIndexReservationUnlink,
            beforeStageRename:
              options.testHooks?.beforePrivateIndexStageRename,
            afterStageHash:
              options.testHooks?.afterPrivateIndexStageHash,
          });
          return await reviewedCommitResult(
            root,
            commit,
            current.status,
            undefined,
            options.testHooks?.beforePostCommitStatus,
          );
        } catch {
          return await reviewedCommitResult(
            root,
            commit,
            current.status,
            `Commit ${commit.slice(0, 7)} was created, but its index recovery still requires manual Git inspection.`,
            options.testHooks?.beforePostCommitStatus,
          );
        }
      }
      throw error;
    }
    return await reviewedCommitResult(
      root,
      commit,
      current.status,
      undefined,
      options.testHooks?.beforePostCommitStatus,
    );
  } finally {
    await finalSelection?.dispose().catch(() => undefined);
    await prepared.selection.dispose().catch(() => undefined);
  }
}

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  runGitInspection,
  withPreparedGitRefReservation,
} from "./runner";
import { hasHead } from "./status";
import {
  assertPreparedReferenceLocksSync,
  acquireIndexReservationSync,
  commitLockIdentity,
  installPrivateIndexStageSync,
  isOwnedReservation,
  MAX_COMMIT_JOURNAL_BYTES,
  observeCommitTransactionJournalSync,
  parseCommitTransactionJournal,
  removeOwnedCommitTransactionJournal,
  removeOwnedCommitTransactionJournalAlias,
  releaseOwnedIndexReservation,
  removeVerifiedStageSync,
  sameCommitLockIdentity,
  type CommitLockIdentity,
  type OwnedCommitTransactionJournal,
} from "./commit-transaction";
import { GitError } from "./types";

const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const REFERENCE_LOCK_RELEASE_GRACE_MS = 500;
const REFERENCE_LOCK_POLL_MS = 10;

interface HeadState {
  head: string | null;
  headRef: string | null;
}

interface ReservationState {
  content: Buffer | null;
  identity: CommitLockIdentity | null;
  owned: boolean;
}

export interface CommitRecoveryHooks {
  ownedJournal?: OwnedCommitTransactionJournal;
  ownedIndexLockIdentity?: CommitLockIdentity | null;
  reservationWasNeverAcquired?: boolean;
  beforeReservationAcquire?: () => void | Promise<void>;
  beforeRefReservationAcquire?: () => void | Promise<void>;
  beforeHeadReservationAcquire?: () => void | Promise<void>;
  afterSecondReferenceAbort?: () => void | Promise<void>;
  afterSecondReferenceAbortAcknowledged?: () => void | Promise<void>;
  beforeFinalReferenceLockObservation?: () => void | Promise<void>;
  afterStageValidation?: () => void | Promise<void>;
  beforeStageRename?: () => void;
  afterStageHash?: () => void;
  beforeStageUnlink?: () => void | Promise<void>;
  beforeReservationUnlink?: () => void;
  beforeJournalUnlink?: () => void;
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

async function headState(root: string): Promise<HeadState> {
  const head = await hasHead(root)
    ? (await runGitInspection(root, ["rev-parse", "--verify", "HEAD"], {
        maxOutputBytes: 256,
        failureMessage: "Unable to verify the reviewed commit parent.",
      })).stdout.toString("utf8").trim()
    : null;
  let headRef: string | null = null;
  try {
    headRef = stripTerminalEol((await runGitInspection(
      root,
      ["symbolic-ref", "--quiet", "HEAD"],
      {
        maxOutputBytes: 4_096,
        failureMessage: "Unable to verify the reviewed branch.",
      },
    )).stdout.toString("utf8")) || null;
  } catch (error) {
    if (!(error instanceof GitError && error.code === "operation-failed"))
      throw error;
  }
  return { head, headRef };
}

export async function commitIndexPath(root: string): Promise<string> {
  return stripTerminalEol((await runGitInspection(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ], {
    maxOutputBytes: 4_096,
    failureMessage: "Unable to locate the repository index.",
  })).stdout.toString("utf8"));
}

export async function commitHeadPath(root: string): Promise<string> {
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

export async function commitRefPath(root: string, ref: string): Promise<string> {
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

export async function referenceOid(
  root: string,
  ref: string,
): Promise<string | null> {
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
    throw new GitError("conflict", "The reviewed branch reference is invalid.");
  }
  return value;
}

async function observeReservation(
  path: string,
  token: string,
  kind: "index",
  expectedIdentity?: CommitLockIdentity | null,
): Promise<ReservationState> {
  const content = await readOptionalRegularFile(path);
  const identity = content === null ? null : await commitLockIdentity(path);
  return {
    content,
    identity,
    owned: isOwnedReservation(
      content,
      identity,
      token,
      kind,
      expectedIdentity,
    ),
  };
}

function requireOwnedOrAbsent(state: ReservationState): void {
  if (state.content !== null && !state.owned) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery found a Git lock owned by another operation. Inspect it before continuing.",
    );
  }
}

async function acquireOrAdopt(
  state: ReservationState,
  path: string,
  token: string,
  beforeAcquire?: () => void | Promise<void>,
): Promise<CommitLockIdentity> {
  requireOwnedOrAbsent(state);
  if (state.identity) return state.identity;
  await beforeAcquire?.();
  try {
    return acquireIndexReservationSync(path, token);
  } catch {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery could not reserve the repository index. Inspect it before continuing.",
    );
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
  beforeFinalObservation?: () => void | Promise<void>,
): Promise<boolean> {
  const expiresAt = Date.now() + REFERENCE_LOCK_RELEASE_GRACE_MS;
  while (await pathExists(headLockPath) || await pathExists(refLockPath)) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      await beforeFinalObservation?.();
      return !await pathExists(headLockPath) && !await pathExists(refLockPath);
    }
    await delay(Math.min(REFERENCE_LOCK_POLL_MS, remaining));
  }
  return true;
}

export async function recoverCommitTransaction(
  root: string,
  options: CommitRecoveryHooks = {},
): Promise<void> {
  const indexPath = await commitIndexPath(root);
  const indexLockPath = `${indexPath}.lock`;
  const journalPath = `${indexPath}.inertia-commit-transaction.json`;
  const observedJournal = observeCommitTransactionJournalSync(journalPath);
  if (observedJournal === null) return;
  const journalBytes = observedJournal.content;
  if (journalBytes.length === 0) {
    throw new GitError("conflict", "The reviewed commit recovery journal is invalid.");
  }
  if (journalBytes.length > MAX_COMMIT_JOURNAL_BYTES) {
    throw new GitError("conflict", "The reviewed commit recovery journal is invalid.");
  }
  const journal = parseCommitTransactionJournal(journalBytes, indexPath);
  if (
    options.ownedJournal
    && (
      !options.ownedJournal.content.equals(observedJournal.content)
      || !sameCommitLockIdentity(
        options.ownedJournal.identity,
        observedJournal.identity,
      )
    )
  ) {
    throw new GitError(
      "conflict",
      "The reviewed commit recovery journal was replaced. Inspect it before continuing.",
    );
  }
  await removeOwnedCommitTransactionJournalAlias(
    journalPath,
    journal.reservationToken,
    observedJournal,
  );
  const reboundJournal = observeCommitTransactionJournalSync(journalPath);
  if (
    reboundJournal === null
    || !reboundJournal.content.equals(observedJournal.content)
    || !sameCommitLockIdentity(
      reboundJournal.identity,
      observedJournal.identity,
    )
  ) {
    throw new GitError(
      "conflict",
      "The reviewed commit recovery journal changed after publication cleanup.",
    );
  }
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
  const headLockPath = `${journal.headPath}.lock`;
  const refLockPath = `${journal.refPath}.lock`;
  const index = await readRegularFile(indexPath);
  const stage = await readOptionalRegularFile(journal.stagePath);
  const stageIdentity = stage === null
    ? null
    : await commitLockIdentity(journal.stagePath);
  const indexLock = await observeReservation(
    indexLockPath,
    journal.reservationToken,
    "index",
    options.ownedIndexLockIdentity,
  );
  const stageIsIndex = stage !== null
    && digest(stage) === journal.newIndexHash;
  const releaseReservations = async (allowStage: boolean): Promise<void> => {
    if (await pathExists(headLockPath) || await pathExists(refLockPath)) {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery found a Git reference lock owned by another operation. Inspect it before continuing.",
      );
    }
    requireOwnedOrAbsent(indexLock);
    await releaseOwnedIndexReservation(
      indexLockPath,
      journal.stagePath,
      journal.reservationToken,
      options.ownedIndexLockIdentity ?? indexLock.identity,
      options.beforeReservationUnlink,
      allowStage,
    );
  };
  if (digest(index) === journal.newIndexHash && stage === null) {
    await releaseReservations(false);
    await removeOwnedCommitTransactionJournal(
      journalPath,
      reboundJournal,
      options.beforeJournalUnlink,
    );
    return;
  }
  const current = await headState(root);
  const headContent = await readOptionalRegularFile(journal.headPath);
  if (
    current.headRef !== journal.headRef
    || headContent === null
    || stripTerminalEol(headContent.toString("utf8"))
      !== `ref: ${journal.headRef}`
  ) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery found that the checked-out branch changed. Inspect it before continuing.",
    );
  }
  if (current.head === journal.expectedHead) {
    if (digest(index) !== journal.oldIndexHash) {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery found repository drift. Inspect it before continuing.",
      );
    }
    if (stage === null) {
      requireOwnedOrAbsent(indexLock);
      await releaseReservations(false);
      await removeOwnedCommitTransactionJournal(
        journalPath,
        reboundJournal,
        options.beforeJournalUnlink,
      );
      return;
    }
    if (!stageIsIndex) {
      throw new GitError(
        "conflict",
        "A reviewed commit recovery found repository drift. Inspect it before continuing.",
      );
    }
    if (
      options.reservationWasNeverAcquired
      && indexLock.content !== null
      && !indexLock.owned
    ) {
      await options.beforeStageUnlink?.();
      removeVerifiedStageSync(journal.stagePath, stageIdentity!);
      await syncDirectory(journal.stagePath);
    } else {
      if (stageIsIndex) {
        await options.beforeStageUnlink?.();
        removeVerifiedStageSync(journal.stagePath, stageIdentity!);
        await syncDirectory(journal.stagePath);
      }
      await releaseReservations(false);
    }
    await removeOwnedCommitTransactionJournal(
      journalPath,
      reboundJournal,
      options.beforeJournalUnlink,
    );
    return;
  }
  if (
    current.head !== journal.newCommit
    || digest(index) !== journal.oldIndexHash
    || !stageIsIndex
  ) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery requires manual Git inspection before continuing.",
    );
  }
  if (!await waitForReferenceLocksToRelease(
    headLockPath,
    refLockPath,
    options.beforeFinalReferenceLockObservation,
  )) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery found Git reference locks still active. Inspect it before continuing.",
    );
  }
  const indexIdentity = await acquireOrAdopt(
    indexLock,
    indexLockPath,
    journal.reservationToken,
    options.beforeReservationAcquire,
  );
  await options.beforeRefReservationAcquire?.();
  await withPreparedGitRefReservation(
    root,
    journal.headRef,
    journal.newCommit,
    {
      failureMessage: "Unable to reserve the reviewed branch while recovering its index.",
      testHooks: {
        afterAbortAcknowledged:
          options.afterSecondReferenceAbortAcknowledged,
        afterFailedCallbackAbortAcknowledged:
          options.afterSecondReferenceAbort,
      },
    },
    async (context) => {
      context.assertActive();
      await options.beforeHeadReservationAcquire?.();
      context.assertActive();
      const reservedIndex = await readRegularFile(indexPath);
      const reservedStage = await readOptionalRegularFile(journal.stagePath);
      const reservedStageIdentity = reservedStage === null
        ? null
        : await commitLockIdentity(journal.stagePath);
      const reservedHead = await headState(root);
      const reservedHeadContent = await readOptionalRegularFile(journal.headPath);
      const reservedRef = await referenceOid(root, journal.headRef);
      context.assertActive();
      if (
        digest(reservedIndex) !== journal.oldIndexHash
        || reservedStage === null
        || digest(reservedStage) !== journal.newIndexHash
        || reservedStageIdentity === null
        || !sameCommitLockIdentity(stageIdentity!, reservedStageIdentity)
        || reservedHead.head !== journal.newCommit
        || reservedHead.headRef !== journal.headRef
        || reservedRef !== journal.newCommit
        || reservedHeadContent === null
        || stripTerminalEol(reservedHeadContent.toString("utf8"))
          !== `ref: ${journal.headRef}`
      ) {
        throw new GitError(
          "conflict",
          "A reviewed commit recovery found repository drift after reserving the index. Inspect it before continuing.",
        );
      }
      await options.afterStageValidation?.();
      context.mutate(() => {
        assertPreparedReferenceLocksSync(journal.headPath, journal.refPath);
        installPrivateIndexStageSync({
          stagePath: journal.stagePath,
          indexPath,
          lockPath: indexLockPath,
          headPath: journal.headPath,
          headRef: journal.headRef,
          token: journal.reservationToken,
          stageIdentity: reservedStageIdentity,
          stageHash: journal.newIndexHash,
          lockIdentity: indexIdentity,
          beforeFinalValidation: options.beforeStageRename,
          afterStageHash: options.afterStageHash,
        });
        return undefined;
      });
    },
  );
  if (!await waitForReferenceLocksToRelease(
    headLockPath,
    refLockPath,
    options.beforeFinalReferenceLockObservation,
  )) {
    throw new GitError(
      "conflict",
      "Git did not release the prepared branch recovery locks.",
    );
  }
  await syncDirectory(indexPath);
  await releaseOwnedIndexReservation(
    indexLockPath,
    journal.stagePath,
    journal.reservationToken,
    indexIdentity,
    options.beforeReservationUnlink,
  );
  await removeOwnedCommitTransactionJournal(
    journalPath,
    reboundJournal,
    options.beforeJournalUnlink,
  );
}

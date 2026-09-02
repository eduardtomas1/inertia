import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { link, lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";
import { GitError } from "./types";

export interface CommitTransactionJournal {
  expectedHead: string | null;
  headRef: string;
  headPath: string;
  refPath: string;
  newCommit: string;
  oldIndexHash: string;
  newIndexHash: string;
  indexPath: string;
  stagePath: string;
  reservationToken: string;
}

export interface CommitLockIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

export type CommitReservationKind = "index";

export interface OwnedCommitTransactionJournal {
  content: Buffer;
  identity: CommitLockIdentity;
}

export const MAX_COMMIT_JOURNAL_BYTES = 4_096;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function createPrivateIndexStagePath(indexPath: string): string {
  return `${indexPath}.inertia-stage-${randomBytes(16).toString("hex")}`;
}

export async function publishCommitTransactionJournal(
  journalPath: string,
  journal: CommitTransactionJournal,
  hooks: {
    beforeLink?: (temporaryPath: string, journalPath: string) => void;
    afterLink?: (temporaryPath: string, journalPath: string) => void;
  } = {},
): Promise<OwnedCommitTransactionJournal> {
  const content = Buffer.from(JSON.stringify(journal), "utf8");
  if (content.length === 0 || content.length > MAX_COMMIT_JOURNAL_BYTES) {
    throw new GitError(
      "output-limit",
      "The reviewed commit recovery journal is too large.",
    );
  }
  const temporaryPath = commitTransactionJournalAliasPath(
    journalPath,
    journal.reservationToken,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  let temporaryIdentity: CommitLockIdentity;
  try {
    const info = await handle.stat({ bigint: true });
    temporaryIdentity = lockIdentityFromStat(info);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(temporaryPath);
  const temporary = observeCommitTransactionJournalSync(temporaryPath);
  if (
    temporary === null
    || !temporary.content.equals(content)
    || !sameCommitLockIdentity(temporaryIdentity, temporary.identity)
  ) {
    throw new GitError(
      "conflict",
      "The reviewed commit recovery journal changed before publication.",
    );
  }
  try {
    hooks.beforeLink?.(temporaryPath, journalPath);
    await link(temporaryPath, journalPath);
  } catch (error) {
    const publishedIdentity = await commitLockIdentity(journalPath)
      .catch(() => null);
    if (
      publishedIdentity === null
      || !sameCommitLockIdentity(temporary.identity, publishedIdentity)
    ) {
      removeExactCommitTransactionFileSync(temporaryPath, temporary);
      await syncDirectory(temporaryPath);
    }
    throw error;
  }
  await syncDirectory(journalPath);
  hooks.afterLink?.(temporaryPath, journalPath);
  const published = observeCommitTransactionJournalSync(journalPath);
  if (
    temporary === null
    || published === null
    || !temporary.content.equals(content)
    || !published.content.equals(content)
    || !sameCommitLockIdentity(temporaryIdentity, temporary.identity)
    || !sameCommitLockIdentity(temporary.identity, published.identity)
  ) {
    throw new GitError(
      "conflict",
      "The reviewed commit recovery journal could not be published atomically.",
    );
  }
  removeExactCommitTransactionFileSync(temporaryPath, temporary);
  await syncDirectory(temporaryPath);
  const finalJournal = observeCommitTransactionJournalSync(journalPath);
  if (
    finalJournal === null
    || !finalJournal.content.equals(content)
    || !sameCommitLockIdentity(published.identity, finalJournal.identity)
  ) {
    throw new GitError(
      "conflict",
      "The reviewed commit recovery journal changed during publication.",
    );
  }
  return finalJournal;
}

export function commitTransactionJournalAliasPath(
  journalPath: string,
  reservationToken: string,
): string {
  return `${journalPath}.publish-${reservationToken}`;
}

export function observeCommitTransactionJournalSync(
  path: string,
): OwnedCommitTransactionJournal | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
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
    const initial = fstatSync(descriptor, { bigint: true });
    const content = initial.isFile()
      ? readDescriptorSync(
          descriptor,
          initial.size,
          MAX_COMMIT_JOURNAL_BYTES,
        )
      : null;
    const final = fstatSync(descriptor, { bigint: true });
    const pathInfo = lstatSync(path, { bigint: true });
    const identity = lockIdentityFromStat(final);
    if (
      content === null
      || !pathInfo.isFile()
      || initial.size !== final.size
      || !sameCommitLockIdentity(lockIdentityFromStat(initial), identity)
      || !sameCommitLockIdentity(identity, lockIdentityFromStat(pathInfo))
    ) {
      throw new GitError(
        "conflict",
        "The reviewed commit recovery journal changed while it was read.",
      );
    }
    return { content, identity };
  } finally {
    closeSync(descriptor);
  }
}

function removeExactCommitTransactionFileSync(
  path: string,
  owned: OwnedCommitTransactionJournal,
  beforeUnlink?: () => void,
): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
    );
  } catch {
    throw new GitError(
      "conflict",
      "The reviewed commit recovery journal was replaced. Inspect it before continuing.",
    );
  }
  try {
    const assertOwnedPath = (): void => {
      const descriptorInfo = fstatSync(descriptor, { bigint: true });
      const content = descriptorInfo.isFile()
        ? readDescriptorSync(
            descriptor,
            descriptorInfo.size,
            MAX_COMMIT_JOURNAL_BYTES,
          )
        : null;
      const pathInfo = lstatSync(path, { bigint: true });
      const descriptorIdentity = lockIdentityFromStat(descriptorInfo);
      if (
        content === null
        || !pathInfo.isFile()
        || !content.equals(owned.content)
        || !sameCommitLockIdentity(descriptorIdentity, owned.identity)
        || !sameCommitLockIdentity(
          descriptorIdentity,
          lockIdentityFromStat(pathInfo),
        )
      ) {
        throw new GitError(
          "conflict",
          "The reviewed commit recovery journal was replaced. Inspect it before continuing.",
        );
      }
    };
    assertOwnedPath();
    beforeUnlink?.();
    assertOwnedPath();
    unlinkSync(path);
  } finally {
    closeSync(descriptor);
  }
}

export async function removeOwnedCommitTransactionJournal(
  journalPath: string,
  owned: OwnedCommitTransactionJournal,
  beforeUnlink?: () => void,
): Promise<void> {
  removeExactCommitTransactionFileSync(journalPath, owned, beforeUnlink);
  await syncDirectory(journalPath);
}

export async function removeOwnedCommitTransactionJournalAlias(
  journalPath: string,
  reservationToken: string,
  owned: OwnedCommitTransactionJournal,
): Promise<void> {
  const aliasPath = commitTransactionJournalAliasPath(
    journalPath,
    reservationToken,
  );
  const alias = observeCommitTransactionJournalSync(aliasPath);
  if (alias === null) return;
  if (
    !alias.content.equals(owned.content)
    || !sameCommitLockIdentity(alias.identity, owned.identity)
  ) {
    throw new GitError(
      "conflict",
      "A reviewed commit recovery found a foreign journal publication alias.",
    );
  }
  removeExactCommitTransactionFileSync(aliasPath, alias);
  await syncDirectory(aliasPath);
}

export function isPrivateIndexStagePath(
  indexPath: string,
  candidate: string,
): boolean {
  const prefix = `${indexPath}.inertia-stage-`;
  return candidate.startsWith(prefix)
    && /^[0-9a-f]{32}$/u.test(candidate.slice(prefix.length));
}

export function sameCommitLockIdentity(
  left: CommitLockIdentity,
  right: CommitLockIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function lockIdentityFromStat(info: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}): CommitLockIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    birthtimeNs: info.birthtimeNs,
  };
}

function readDescriptorSync(
  descriptor: number,
  size: bigint,
  maxBytes: number,
): Buffer | null {
  if (size < 0n || size > BigInt(maxBytes)) return null;
  const content = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < content.length) {
    const count = readSync(
      descriptor,
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (count === 0) return null;
    offset += count;
  }
  return content;
}

export async function commitLockIdentity(
  path: string,
): Promise<CommitLockIdentity | null> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) return null;
    return {
      dev: info.dev,
      ino: info.ino,
      birthtimeNs: info.birthtimeNs,
    };
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return null;
    throw error;
  }
}

export function reservationBytes(
  token: string,
  kind: CommitReservationKind,
): Buffer {
  return Buffer.from(`inertia-reviewed-commit:${kind}:${token}\n`, "utf8");
}

export function acquireCommitReservationSync(
  lockPath: string,
  token: string,
  kind: CommitReservationKind,
): CommitLockIdentity {
  let descriptor: number | null = null;
  let identity: CommitLockIdentity | null = null;
  try {
    descriptor = openSync(
      lockPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | FILE_OPEN_NO_FOLLOW,
      0o600,
    );
    identity = lockIdentityFromStat(fstatSync(descriptor, { bigint: true }));
    writeFileSync(descriptor, reservationBytes(token, kind));
    fsyncSync(descriptor);
    return identity;
  } catch (error) {
    if (descriptor !== null && identity) {
      const observed = lstatSync(lockPath, { bigint: true });
      if (sameCommitLockIdentity(identity, lockIdentityFromStat(observed))) {
        unlinkSync(lockPath);
      }
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function acquireIndexReservationSync(
  lockPath: string,
  token: string,
): CommitLockIdentity {
  return acquireCommitReservationSync(lockPath, token, "index");
}

export function assertPreparedReferenceLocksSync(
  headPath: string,
  refPath: string,
): void {
  try {
    const headLock = lstatSync(`${headPath}.lock`, { bigint: true });
    const refLock = lstatSync(`${refPath}.lock`, { bigint: true });
    if (headLock.isFile() && refLock.isFile()) return;
  } catch {
    // The prepared transaction must own both native files-backend locks.
  }
  throw new GitError(
    "conflict",
    "Git did not retain the prepared branch transaction locks.",
  );
}

export function installPrivateIndexStageSync(options: {
  stagePath: string;
  indexPath: string;
  lockPath: string;
  headPath: string;
  headRef: string;
  token: string;
  stageIdentity: CommitLockIdentity;
  stageHash: string;
  lockIdentity: CommitLockIdentity;
  beforeFinalValidation?: () => void;
  afterStageHash?: () => void;
}): void {
  let lockDescriptor: number | null = null;
  let stageDescriptor: number | null = null;
  let headDescriptor: number | null = null;
  try {
    lockDescriptor = openSync(
      options.lockPath,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
    );
    stageDescriptor = openSync(
      options.stagePath,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
    );
    headDescriptor = openSync(
      options.headPath,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
    );
    options.beforeFinalValidation?.();
    const openedLockInfo = fstatSync(lockDescriptor, { bigint: true });
    const openedLockIdentity = lockIdentityFromStat(openedLockInfo);
    const openedStageInfo = fstatSync(stageDescriptor, { bigint: true });
    const openedStageIdentity = lockIdentityFromStat(openedStageInfo);
    const openedHeadInfo = fstatSync(headDescriptor, { bigint: true });
    const openedHeadIdentity = lockIdentityFromStat(openedHeadInfo);
    const lockContent = openedLockInfo.isFile() && openedLockInfo.size <= 256
      ? readFileSync(lockDescriptor)
      : null;
    const stagedIndexHash = openedStageInfo.isFile()
      && openedStageInfo.size <= 256 * 1024 * 1024
      ? createHash("sha256")
          .update(readFileSync(stageDescriptor)).digest("hex")
      : null;
    const headContent = openedHeadInfo.isFile() && openedHeadInfo.size <= 4_096
      ? readFileSync(headDescriptor).toString("utf8")
      : null;
    if (
      lockContent === null
      || !lockContent.equals(reservationBytes(options.token, "index"))
      || stagedIndexHash !== options.stageHash
      || headContent !== `ref: ${options.headRef}\n`
    ) {
      throw new GitError(
        "conflict",
        "Another Git operation replaced the reviewed commit reservation. Inspect it manually before continuing.",
      );
    }
    options.afterStageHash?.();
    const validatedLockInfo = fstatSync(lockDescriptor, { bigint: true });
    const validatedStageInfo = fstatSync(stageDescriptor, { bigint: true });
    const validatedHeadInfo = fstatSync(headDescriptor, { bigint: true });
    const finalLockContent = validatedLockInfo.isFile()
      ? readDescriptorSync(lockDescriptor, validatedLockInfo.size, 256)
      : null;
    const finalStageContent = validatedStageInfo.isFile()
      ? readDescriptorSync(
          stageDescriptor,
          validatedStageInfo.size,
          256 * 1024 * 1024,
        )
      : null;
    const finalHeadContent = validatedHeadInfo.isFile()
      ? readDescriptorSync(headDescriptor, validatedHeadInfo.size, 4_096)
      : null;
    const finalContentsMatch = finalLockContent !== null
      && finalLockContent.equals(reservationBytes(options.token, "index"))
      && finalHeadContent?.toString("utf8") === `ref: ${options.headRef}\n`
      && finalStageContent !== null
      && createHash("sha256").update(finalStageContent).digest("hex")
        === options.stageHash;
    const finalOpenedLockInfo = fstatSync(lockDescriptor, { bigint: true });
    const finalOpenedStageInfo = fstatSync(stageDescriptor, { bigint: true });
    const finalOpenedHeadInfo = fstatSync(headDescriptor, { bigint: true });
    const pathLockInfo = lstatSync(options.lockPath, { bigint: true });
    const pathStageInfo = lstatSync(options.stagePath, { bigint: true });
    const pathHeadInfo = lstatSync(options.headPath, { bigint: true });
    const pathLockIdentity = lockIdentityFromStat(pathLockInfo);
    const pathStageIdentity = lockIdentityFromStat(pathStageInfo);
    const pathHeadIdentity = lockIdentityFromStat(pathHeadInfo);
    if (
      !pathLockInfo.isFile()
      || !pathStageInfo.isFile()
      || !pathHeadInfo.isFile()
      || !sameCommitLockIdentity(options.lockIdentity, openedLockIdentity)
      || !sameCommitLockIdentity(
        openedLockIdentity,
        lockIdentityFromStat(finalOpenedLockInfo),
      )
      || !sameCommitLockIdentity(
        lockIdentityFromStat(finalOpenedLockInfo),
        pathLockIdentity,
      )
      || !finalContentsMatch
      || !sameCommitLockIdentity(options.stageIdentity, openedStageIdentity)
      || !sameCommitLockIdentity(
        openedStageIdentity,
        lockIdentityFromStat(finalOpenedStageInfo),
      )
      || !sameCommitLockIdentity(
        lockIdentityFromStat(finalOpenedStageInfo),
        pathStageIdentity,
      )
      || !sameCommitLockIdentity(
        openedHeadIdentity,
        lockIdentityFromStat(finalOpenedHeadInfo),
      )
      || !sameCommitLockIdentity(
        lockIdentityFromStat(finalOpenedHeadInfo),
        pathHeadIdentity,
      )
      || finalOpenedLockInfo.size !== validatedLockInfo.size
      || finalOpenedStageInfo.size !== validatedStageInfo.size
      || finalOpenedHeadInfo.size !== validatedHeadInfo.size
    ) {
      throw new GitError(
        "conflict",
        "Another Git operation replaced the reviewed commit reservation. Inspect it manually before continuing.",
      );
    }
    renameSync(options.stagePath, options.indexPath);
  } finally {
    if (headDescriptor !== null) closeSync(headDescriptor);
    if (stageDescriptor !== null) closeSync(stageDescriptor);
    if (lockDescriptor !== null) closeSync(lockDescriptor);
  }
}

export function removeVerifiedStageSync(
  stagePath: string,
  expectedIdentity: CommitLockIdentity,
): void {
  const observed = lockIdentityFromStat(
    lstatSync(stagePath, { bigint: true }),
  );
  if (!sameCommitLockIdentity(expectedIdentity, observed)) {
    throw new GitError(
      "conflict",
      "The reviewed commit private index stage was replaced. Inspect it manually before continuing.",
    );
  }
  unlinkSync(stagePath);
}

export function isOwnedReservation(
  content: Buffer | null,
  identity: CommitLockIdentity | null,
  token: string,
  kind: CommitReservationKind,
  expectedIdentity?: CommitLockIdentity | null,
): boolean {
  return content !== null
    && content.equals(reservationBytes(token, kind))
    && identity !== null
    && (!expectedIdentity
      || sameCommitLockIdentity(expectedIdentity, identity));
}

export async function releaseOwnedIndexReservation(
  lockPath: string,
  stagePath: string,
  token: string,
  expectedIdentity?: CommitLockIdentity | null,
  beforeReservationUnlink?: () => void,
  allowExistingStage = false,
): Promise<void> {
  if (!allowExistingStage) {
    try {
      lstatSync(stagePath);
      throw new GitError(
        "conflict",
        "The reviewed commit private stage path was reused. Inspect it manually before continuing.",
      );
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "ENOENT"
      ) throw error;
    }
  }
  await releaseOwnedCommitReservation(
    lockPath,
    token,
    "index",
    expectedIdentity,
    beforeReservationUnlink,
  );
}

export async function releaseOwnedCommitReservation(
  lockPath: string,
  token: string,
  kind: CommitReservationKind,
  expectedIdentity?: CommitLockIdentity | null,
  beforeReservationUnlink?: () => void,
): Promise<void> {
  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
    );
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return;
    throw error;
  }
  try {
    const openedIdentity = lockIdentityFromStat(
      fstatSync(descriptor, { bigint: true }),
    );
    const initialPathIdentity = lockIdentityFromStat(
      lstatSync(lockPath, { bigint: true }),
    );
    if (
      !readFileSync(descriptor).equals(reservationBytes(token, kind))
      || !sameCommitLockIdentity(openedIdentity, initialPathIdentity)
      || (expectedIdentity
        && !sameCommitLockIdentity(expectedIdentity, openedIdentity))
    ) {
      throw new GitError(
        "conflict",
        "Another Git operation replaced the reviewed commit reservation. Inspect it manually before continuing.",
      );
    }
    beforeReservationUnlink?.();
    const finalPathIdentity = lockIdentityFromStat(
      lstatSync(lockPath, { bigint: true }),
    );
    if (!sameCommitLockIdentity(openedIdentity, finalPathIdentity)) {
      throw new GitError(
        "conflict",
        "Another Git operation replaced the reviewed commit reservation. Inspect it manually before continuing.",
      );
    }
    unlinkSync(lockPath);
  } finally {
    closeSync(descriptor);
  }
  await syncDirectory(lockPath);
}

export function requireStagePathAbsentSync(stagePath: string): void {
  try {
    lstatSync(stagePath);
    throw new GitError(
      "conflict",
      "The reviewed commit private stage path was reused. Inspect it manually before continuing.",
    );
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }
}

export function parseCommitTransactionJournal(
  content: Buffer,
  indexPath: string,
): CommitTransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new GitError("conflict", "The reviewed commit recovery journal is invalid.");
  }
  if (
    typeof value !== "object"
    || value === null
    || !("expectedHead" in value)
    || !("newCommit" in value)
    || !("headRef" in value)
    || !("headPath" in value)
    || !("refPath" in value)
    || !("oldIndexHash" in value)
    || !("newIndexHash" in value)
    || !("indexPath" in value)
    || !("stagePath" in value)
    || !("reservationToken" in value)
    || (value.expectedHead !== null && typeof value.expectedHead !== "string")
    || typeof value.headRef !== "string"
    || typeof value.headPath !== "string"
    || typeof value.refPath !== "string"
    || typeof value.newCommit !== "string"
    || typeof value.oldIndexHash !== "string"
    || typeof value.newIndexHash !== "string"
    || value.indexPath !== indexPath
    || typeof value.stagePath !== "string"
    || !isPrivateIndexStagePath(indexPath, value.stagePath)
    || typeof value.reservationToken !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.reservationToken)
    || !value.headRef.startsWith("refs/heads/")
    || Buffer.byteLength(value.headRef, "utf8") > 4_096
    || /[\u0000\r\n]/u.test(value.headRef)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.newCommit)
    || (value.expectedHead !== null
      && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.expectedHead))
    || !/^[0-9a-f]{64}$/u.test(value.oldIndexHash)
    || !/^[0-9a-f]{64}$/u.test(value.newIndexHash)
  ) {
    throw new GitError("conflict", "The reviewed commit recovery journal is invalid.");
  }
  return value as CommitTransactionJournal;
}

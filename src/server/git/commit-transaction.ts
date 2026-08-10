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
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

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

export function reservationBytes(token: string): Buffer {
  return Buffer.from(`${token}\n`, "utf8");
}

export function acquireIndexReservationSync(
  lockPath: string,
  token: string,
): CommitLockIdentity {
  let descriptor: number | null = null;
  let identity: CommitLockIdentity | null = null;
  try {
    descriptor = openSync(
      lockPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    identity = lockIdentityFromStat(fstatSync(descriptor, { bigint: true }));
    writeFileSync(descriptor, reservationBytes(token));
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

export function installPrivateIndexStageSync(options: {
  stagePath: string;
  indexPath: string;
  lockPath: string;
  headPath: string;
  refPath: string;
  headRef: string;
  newCommit: string;
  token: string;
  stageIdentity: CommitLockIdentity;
  stageHash: string;
  lockIdentity: CommitLockIdentity;
  beforeFinalValidation?: () => void;
  afterStageHash?: () => void;
}): void {
  const lockDescriptor = openSync(
    options.lockPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let stageDescriptor: number | null = null;
  let headDescriptor: number | null = null;
  let refDescriptor: number | null = null;
  try {
    stageDescriptor = openSync(
      options.stagePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    headDescriptor = openSync(
      options.headPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    refDescriptor = openSync(
      options.refPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    options.beforeFinalValidation?.();
    const openedLockInfo = fstatSync(lockDescriptor, { bigint: true });
    const openedLockIdentity = lockIdentityFromStat(openedLockInfo);
    const openedStageInfo = fstatSync(stageDescriptor, { bigint: true });
    const openedStageIdentity = lockIdentityFromStat(openedStageInfo);
    const openedHeadInfo = fstatSync(headDescriptor, { bigint: true });
    const openedHeadIdentity = lockIdentityFromStat(openedHeadInfo);
    const openedRefInfo = fstatSync(refDescriptor, { bigint: true });
    const openedRefIdentity = lockIdentityFromStat(openedRefInfo);
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
    const refContent = openedRefInfo.isFile() && openedRefInfo.size <= 4_096
      ? readFileSync(refDescriptor).toString("utf8")
      : null;
    if (
      lockContent === null
      || !lockContent.equals(reservationBytes(options.token))
      || stagedIndexHash !== options.stageHash
      || headContent !== `ref: ${options.headRef}\n`
      || refContent?.replace(/(?:\r\n|\n)$/u, "") !== options.newCommit
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
    const validatedRefInfo = fstatSync(refDescriptor, { bigint: true });
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
    const finalRefContent = validatedRefInfo.isFile()
      ? readDescriptorSync(refDescriptor, validatedRefInfo.size, 4_096)
      : null;
    const finalContentsMatch = finalLockContent !== null
      && finalLockContent.equals(reservationBytes(options.token))
      && finalHeadContent?.toString("utf8") === `ref: ${options.headRef}\n`
      && finalRefContent?.toString("utf8")
        .replace(/(?:\r\n|\n)$/u, "") === options.newCommit
      && finalStageContent !== null
      && createHash("sha256").update(finalStageContent).digest("hex")
        === options.stageHash;
    const finalOpenedLockInfo = fstatSync(lockDescriptor, { bigint: true });
    const finalOpenedStageInfo = fstatSync(stageDescriptor, { bigint: true });
    const finalOpenedHeadInfo = fstatSync(headDescriptor, { bigint: true });
    const finalOpenedRefInfo = fstatSync(refDescriptor, { bigint: true });
    const pathLockInfo = lstatSync(options.lockPath, { bigint: true });
    const pathStageInfo = lstatSync(options.stagePath, { bigint: true });
    const pathHeadInfo = lstatSync(options.headPath, { bigint: true });
    const pathRefInfo = lstatSync(options.refPath, { bigint: true });
    const pathLockIdentity = lockIdentityFromStat(pathLockInfo);
    const pathStageIdentity = lockIdentityFromStat(pathStageInfo);
    const pathHeadIdentity = lockIdentityFromStat(pathHeadInfo);
    const pathRefIdentity = lockIdentityFromStat(pathRefInfo);
    if (
      !pathLockInfo.isFile()
      || !pathStageInfo.isFile()
      || !pathHeadInfo.isFile()
      || !pathRefInfo.isFile()
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
      || !sameCommitLockIdentity(
        openedRefIdentity,
        lockIdentityFromStat(finalOpenedRefInfo),
      )
      || !sameCommitLockIdentity(
        lockIdentityFromStat(finalOpenedRefInfo),
        pathRefIdentity,
      )
      || finalOpenedLockInfo.size !== validatedLockInfo.size
      || finalOpenedStageInfo.size !== validatedStageInfo.size
      || finalOpenedHeadInfo.size !== validatedHeadInfo.size
      || finalOpenedRefInfo.size !== validatedRefInfo.size
    ) {
      throw new GitError(
        "conflict",
        "Another Git operation replaced the reviewed commit reservation. Inspect it manually before continuing.",
      );
    }
    renameSync(options.stagePath, options.indexPath);
  } finally {
    if (refDescriptor !== null) closeSync(refDescriptor);
    if (headDescriptor !== null) closeSync(headDescriptor);
    if (stageDescriptor !== null) closeSync(stageDescriptor);
    closeSync(lockDescriptor);
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
  expectedIdentity?: CommitLockIdentity | null,
): boolean {
  return content !== null
    && content.equals(reservationBytes(token))
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
  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
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
      !readFileSync(descriptor).equals(reservationBytes(token))
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

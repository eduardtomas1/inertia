import { link, lstat } from "node:fs/promises";

import type { SecureFileIdentity } from "../node/secure-file-protocol.js";
import { removeExact, syncCurrentDirectory } from "./secure-file-cleanup.js";
import {
  errorCode,
  identity,
  sameIdentity,
  snapshotNamedFile,
  type FileSnapshot,
} from "./secure-file-io.js";

interface SecureFileClaimHooks {
  beforeQuarantine?(name: string): Promise<void> | void;
}

export type SecureFileClaimResult =
  | { ok: true; backup: FileSnapshot }
  | { ok: false; code: "conflict" | "unsafe"; message: string };

async function discardUnclaimedTransaction(
  journalName: string,
  journalIdentity: SecureFileIdentity,
  backupName: string,
  backupIdentity: SecureFileIdentity | null,
  backupQuarantineName: string,
  journalQuarantineName: string,
  hooks: SecureFileClaimHooks,
): Promise<void> {
  if (backupIdentity) {
    await removeExact(
      backupName,
      backupIdentity,
      hooks,
      backupQuarantineName,
    );
  }
  await removeExact(
    journalName,
    journalIdentity,
    hooks,
    journalQuarantineName,
  );
  await syncCurrentDirectory();
}

export async function claimSecureFileTarget(options: {
  basename: string;
  backupName: string;
  backupQuarantineName: string;
  journalName: string;
  journalIdentity: SecureFileIdentity;
  journalQuarantineName: string;
  maxBytes: number;
  expectedIdentity: SecureFileIdentity;
  expectedDigest: string;
  expectedMode: number;
  hooks: SecureFileClaimHooks;
}): Promise<SecureFileClaimResult> {
  try {
    await link(options.basename, options.backupName);
  } catch (error) {
    await discardUnclaimedTransaction(
      options.journalName,
      options.journalIdentity,
      options.backupName,
      null,
      options.backupQuarantineName,
      options.journalQuarantineName,
      options.hooks,
    );
    return errorCode(error) === "EEXIST"
      ? {
          ok: false,
          code: "conflict",
          message: "A concurrent transaction prevented secure file claim.",
        }
      : {
          ok: false,
          code: "unsafe",
          message: "The selected file became unsafe before it could be claimed.",
        };
  }
  const backupInfo = await lstat(options.backupName, { bigint: true })
    .catch(() => null);
  const backupIdentity = backupInfo ? identity(backupInfo) : null;
  let backup: FileSnapshot | null = null;
  let target: FileSnapshot | null = null;
  try {
    backup = await snapshotNamedFile(options.backupName, options.maxBytes);
    target = await snapshotNamedFile(options.basename, options.maxBytes);
  } catch {
    await discardUnclaimedTransaction(
      options.journalName,
      options.journalIdentity,
      options.backupName,
      backupIdentity,
      options.backupQuarantineName,
      options.journalQuarantineName,
      options.hooks,
    );
    return {
      ok: false,
      code: "unsafe",
      message: "The selected file changed to an unsafe path before claim.",
    };
  }
  const matchesExpected = (snapshot: FileSnapshot | null): boolean => Boolean(
    snapshot?.metadata
    && sameIdentity(snapshot.fileIdentity, options.expectedIdentity)
    && snapshot.metadata.digest === options.expectedDigest
    && snapshot.metadata.mode === options.expectedMode,
  );
  if (
    !backup
    || !target
    || !matchesExpected(backup)
    || !matchesExpected(target)
    || !sameIdentity(backup.fileIdentity, target.fileIdentity)
    || backup.linkCount !== 2
    || target.linkCount !== 2
  ) {
    await discardUnclaimedTransaction(
      options.journalName,
      options.journalIdentity,
      options.backupName,
      backupIdentity,
      options.backupQuarantineName,
      options.journalQuarantineName,
      options.hooks,
    );
    return {
      ok: false,
      code: "conflict",
      message: "The selected file changed before the secure save claimed it.",
    };
  }
  return { ok: true, backup };
}

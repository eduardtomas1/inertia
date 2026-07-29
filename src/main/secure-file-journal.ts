import { link, unlink } from "node:fs/promises";

import type {
  SecureFileIdentity,
  SecureFileMetadata,
} from "../node/secure-file-protocol.js";
import {
  removeExact,
  syncCurrentDirectory,
} from "./secure-file-cleanup.js";
import {
  errorCode,
  sameIdentity,
  SecureFileOperationError,
  snapshotNamedFile,
  type FileSnapshot,
} from "./secure-file-io.js";

export const TRANSACTION_PREFIX = ".inertia-save-";
export const JOURNAL_SUFFIX = ".journal";
export const MAX_JOURNAL_BYTES = 4_096;

export interface SaveJournal {
  version: 1;
  token: string;
  target: string;
  stage: string;
  backup: string;
  maxBytes: number;
  expectedIdentity: SecureFileIdentity;
  expectedDigest: string;
  expectedMode: number;
  replacementIdentity: SecureFileIdentity;
  replacementDigest: string;
  replacementMode: number;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parsedIdentity(value: unknown): SecureFileIdentity | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return null;
  const candidate = value as Record<string, unknown>;
  return exactKeys(candidate, ["dev", "ino"])
    && typeof candidate.dev === "string"
    && /^(?:0|[1-9][0-9]{0,39})$/u.test(candidate.dev)
    && typeof candidate.ino === "string"
    && /^[1-9][0-9]{0,39}$/u.test(candidate.ino)
    ? { dev: candidate.dev, ino: candidate.ino }
    : null;
}

export function parseJournal(
  value: string,
  journalName: string,
): SaveJournal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) return null;
  const record = parsed as Record<string, unknown>;
  const keys = [
    "backup",
    "expectedDigest",
    "expectedIdentity",
    "expectedMode",
    "maxBytes",
    "replacementDigest",
    "replacementIdentity",
    "replacementMode",
    "stage",
    "target",
    "token",
    "version",
  ] as const;
  if (!exactKeys(record, keys)) return null;
  const token = typeof record.token === "string" ? record.token : "";
  const expectedIdentity = parsedIdentity(record.expectedIdentity);
  const replacementIdentity = parsedIdentity(record.replacementIdentity);
  const stem = `${TRANSACTION_PREFIX}${token}`;
  if (
    record.version !== 1
    || !/^[a-f0-9-]{36}$/u.test(token)
    || journalName !== `${stem}${JOURNAL_SUFFIX}`
    || record.stage !== `${stem}.stage`
    || record.backup !== `${stem}.backup`
    || typeof record.target !== "string"
    || !expectedIdentity
    || !replacementIdentity
    || typeof record.maxBytes !== "number"
    || !Number.isSafeInteger(record.maxBytes)
    || record.maxBytes < 1
    || record.maxBytes > 2 * 1024 * 1024
    || typeof record.expectedDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.expectedDigest)
    || typeof record.replacementDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.replacementDigest)
    || typeof record.expectedMode !== "number"
    || !Number.isSafeInteger(record.expectedMode)
    || record.expectedMode < 0
    || record.expectedMode > 0o777
    || typeof record.replacementMode !== "number"
    || !Number.isSafeInteger(record.replacementMode)
    || record.replacementMode < 0
    || record.replacementMode > 0o777
  ) return null;
  return {
    version: 1,
    token,
    target: record.target,
    stage: record.stage as string,
    backup: record.backup as string,
    maxBytes: record.maxBytes,
    expectedIdentity,
    expectedDigest: record.expectedDigest,
    expectedMode: record.expectedMode,
    replacementIdentity,
    replacementDigest: record.replacementDigest,
    replacementMode: record.replacementMode,
  };
}

export function parsePendingJournal(value: string): SaveJournal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) return null;
  const token = (parsed as Record<string, unknown>).token;
  return typeof token === "string"
    ? parseJournal(
        value,
        `${TRANSACTION_PREFIX}${token}${JOURNAL_SUFFIX}`,
      )
    : null;
}

export async function recoverPendingJournal(
  pendingName: string,
  basename: string,
): Promise<boolean> {
  const pending = await snapshotNamedFile(pendingName, MAX_JOURNAL_BYTES);
  if (!pending?.content) return false;
  const journal = parsePendingJournal(pending.content.toString("utf8"));
  if (journal?.target !== basename) return false;
  if (pending.linkCount === 2) {
    const journalName = (
      `${TRANSACTION_PREFIX}${journal.token}${JOURNAL_SUFFIX}`
    );
    const published = await snapshotNamedFile(
      journalName,
      MAX_JOURNAL_BYTES,
    );
    if (
      !published?.content
      || published.linkCount !== 2
      || !sameIdentity(published.fileIdentity, pending.fileIdentity)
      || !parseJournal(published.content.toString("utf8"), journalName)
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "A partially published secure save journal is unsafe.",
      );
    }
    await removeExact(
      pendingName,
      pending.fileIdentity,
      undefined,
      `${pendingName}.quarantine`,
    );
    await readJournal(journalName, pending.fileIdentity);
    return true;
  }
  if (pending.linkCount === 1) {
    await removeExact(
      pendingName,
      pending.fileIdentity,
      undefined,
      `${pendingName}.quarantine`,
    );
    return true;
  }
  throw new SecureFileOperationError(
    "unsafe",
    "A pending secure save journal was linked unexpectedly.",
  );
}

export function matchesSnapshot(
  snapshot: FileSnapshot | null,
  expectedIdentity: SecureFileIdentity,
  expectedDigest: string,
  expectedMode: number,
): snapshot is FileSnapshot & { metadata: SecureFileMetadata } {
  return Boolean(
    snapshot?.metadata
    && sameIdentity(snapshot.fileIdentity, expectedIdentity)
    && snapshot.metadata.digest === expectedDigest
    && snapshot.metadata.mode === expectedMode,
  );
}

export function quarantineName(
  journal: SaveJournal,
  role:
    | "target"
    | "rollback-target"
    | "stage"
    | "backup"
    | "journal"
    | "probe",
): string {
  return `${TRANSACTION_PREFIX}${journal.token}.${role}.quarantine`;
}

export async function restoreQuarantinedFile(
  name: string,
  quarantinedName: string,
  validate: (snapshot: FileSnapshot) => boolean,
): Promise<void> {
  const quarantined = await snapshotNamedFile(
    quarantinedName,
    MAX_JOURNAL_BYTES * 512,
  );
  if (!quarantined) return;
  if (!validate(quarantined)) {
    throw new SecureFileOperationError(
      "unsafe",
      "A secure save quarantine could not be verified.",
    );
  }
  const current = await snapshotNamedFile(name, MAX_JOURNAL_BYTES * 512);
  if (current) {
    if (!sameIdentity(current.fileIdentity, quarantined.fileIdentity)) {
      throw new SecureFileOperationError(
        "conflict",
        "A concurrent file prevents secure save quarantine recovery.",
      );
    }
  } else {
    try {
      await link(quarantinedName, name);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const restored = await snapshotNamedFile(
      name,
      MAX_JOURNAL_BYTES * 512,
    );
    if (
      !restored
      || !sameIdentity(restored.fileIdentity, quarantined.fileIdentity)
    ) {
      throw new SecureFileOperationError(
        "conflict",
        "A concurrent file prevents secure save quarantine recovery.",
      );
    }
  }
  await unlink(quarantinedName);
  await syncCurrentDirectory();
}

export async function readJournal(
  name: string,
  expectedIdentity?: SecureFileIdentity,
): Promise<{
  journal: SaveJournal;
  identity: SecureFileIdentity;
}> {
  const snapshot = await snapshotNamedFile(name, MAX_JOURNAL_BYTES);
  if (!snapshot?.content || snapshot.linkCount !== 1) {
    throw new SecureFileOperationError(
      "unsafe",
      "A secure save journal is missing or unsafe.",
    );
  }
  const journal = parseJournal(snapshot.content.toString("utf8"), name);
  if (!journal) {
    throw new SecureFileOperationError(
      "unsafe",
      "A secure save journal is invalid.",
    );
  }
  if (
    expectedIdentity
    && !sameIdentity(snapshot.fileIdentity, expectedIdentity)
  ) {
    throw new SecureFileOperationError(
      "unsafe",
      "The published secure save journal was replaced unexpectedly.",
    );
  }
  return { journal, identity: snapshot.fileIdentity };
}

export async function restoreTransactionQuarantines(
  journalName: string,
  journal: SaveJournal,
): Promise<void> {
  await restoreQuarantinedFile(
    journal.target,
    quarantineName(journal, "target"),
    (snapshot) => matchesSnapshot(
      snapshot,
      journal.expectedIdentity,
      journal.expectedDigest,
      journal.expectedMode,
    ),
  );
  await restoreQuarantinedFile(
    journal.stage,
    quarantineName(journal, "stage"),
    (snapshot) => matchesSnapshot(
      snapshot,
      journal.replacementIdentity,
      journal.replacementDigest,
      journal.replacementMode,
    ),
  );
  await restoreQuarantinedFile(
    journal.backup,
    quarantineName(journal, "backup"),
    (snapshot) => matchesSnapshot(
      snapshot,
      journal.expectedIdentity,
      journal.expectedDigest,
      journal.expectedMode,
    ),
  );
  await restoreQuarantinedFile(
    journalName,
    quarantineName(journal, "journal"),
    (snapshot) => Boolean(
      snapshot.content
      && parseJournal(snapshot.content.toString("utf8"), journalName),
    ),
  );
}

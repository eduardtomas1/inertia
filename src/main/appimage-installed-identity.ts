import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  link,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  installedApplicationName,
  type InertiaReleaseChannel,
} from "./release-channel.js";
import {
  APPIMAGE_UPDATE_JOURNAL_SCHEMA as JOURNAL_SCHEMA,
  createAppImageHandoffJournal as createHandoffJournal,
  parseAppImageUpdateJournal as parseJournal,
  type AppImageFileIdentity as FileIdentity,
  type AppImageHandoffJournal as HandoffJournal,
  type AppImageUpdateJournal as UpdateJournal,
  type PreparedAppImageJournal as PreparedJournal,
  type PreparingAppImageJournal as PreparingJournal,
} from "./appimage-update-journal.js";

const MAX_PATH_BYTES = 4 * 1_024;
const MAX_JOURNAL_BYTES = 16 * 1_024;
const MAX_APPIMAGE_BYTES = 4 * 1_024 * 1_024 * 1_024;
const COPY_BUFFER_BYTES = 1024 * 1_024;

interface UpdateJournalRecord {
  readonly journal: UpdateJournal;
  readonly identity: FileIdentity;
}

interface TransactionPaths {
  directory: string;
  original: string;
  stable: string;
  candidate: string;
  backup: string;
  journal: string;
  nextJournal: string;
}

export interface InstallAppImageUpdateOptions {
  channel: InertiaReleaseChannel;
  activePath: string;
  downloadedPath: string;
  environment?: NodeJS.ProcessEnv;
  launch?: (path: string, environment: NodeJS.ProcessEnv) => Promise<void>;
}

export interface RecoverAppImageUpdateOptions {
  channel: InertiaReleaseChannel;
  activePath: string;
}

export interface AppImageHandoffRecoveryExpectation {
  readonly operationId: string;
  readonly artifactDigest: string;
  readonly executableIdentityDigest: string;
  readonly phases: readonly ("staged" | "ownership-committed")[];
}

export interface AppImageHandoffRecoveryReceipt {
  readonly activePath: string;
  readonly operationId: string;
  readonly artifactDigest: string;
  readonly executableIdentityDigest: string;
  readonly phase: "staged" | "ownership-committed";
  readonly activeCandidateRolledBack: boolean;
}

export interface PrepareAppImageUpdateOptions {
  channel: InertiaReleaseChannel;
  activePath: string;
  downloadedPath: string;
  operationId: string;
}

export interface AppImageCandidateIdentity {
  readonly artifactDigest: string;
  readonly executableIdentityDigest: string;
}

export interface PreparedAppImageUpdate extends AppImageCandidateIdentity {
  readonly operationId: string;
  readonly candidatePath: string;
  readonly stablePath: string;
  commit(): Promise<string>;
  rollback(): Promise<void>;
}

type AppImageFinalizationCleanupStep =
  | "backup-unlinked"
  | "original-unlinked"
  | "next-journal-unlinked"
  | "rollback-residue-synced"
  | "journal-unlinked"
  | "directory-synced";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function exactPath(path: string, label: string): void {
  if (
    !isAbsolute(path)
    || path.includes("\0")
    || path !== path.trim()
    || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error(`${label} must be a bounded absolute path.`);
  }
}

function identity(metadata: { dev: number | bigint; ino: number | bigint }): FileIdentity {
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

function sameIdentity(
  metadata: { dev: number | bigint; ino: number | bigint },
  expected: FileIdentity,
): boolean {
  return String(metadata.dev) === expected.dev && String(metadata.ino) === expected.ino;
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function currentUid(): number | null {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function requireOwnedRegularFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a direct regular file.`);
  }
  const uid = currentUid();
  if (uid !== null && metadata.uid !== uid) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

function transactionPaths(
  directory: string,
  original: string,
  channel: InertiaReleaseChannel,
): TransactionPaths {
  const stableName = installedApplicationName(channel, "linux");
  return {
    directory,
    original,
    stable: join(directory, stableName),
    candidate: join(directory, `.${stableName}.inertia-update-candidate`),
    backup: join(directory, `.${stableName}.inertia-update-backup`),
    journal: join(directory, `.${stableName}.inertia-update.json`),
    nextJournal: join(directory, `.${stableName}.inertia-update-next.json`),
  };
}

async function directActivePath(
  activePath: string,
  channel: InertiaReleaseChannel,
): Promise<{ paths: TransactionPaths; metadata: Awaited<ReturnType<typeof lstat>> }> {
  exactPath(activePath, "The active AppImage path");
  const directMetadata = await lstat(activePath);
  requireOwnedRegularFile(directMetadata, "The active AppImage");
  const [actualPath, actualDirectory] = await Promise.all([
    realpath(activePath),
    realpath(dirname(activePath)),
  ]);
  if (dirname(actualPath) !== actualDirectory) {
    throw new Error("The active AppImage escapes its containing directory.");
  }
  const [metadata, directoryMetadata] = await Promise.all([
    lstat(actualPath),
    lstat(actualDirectory),
  ]);
  requireOwnedRegularFile(metadata, "The active AppImage");
  if (!sameFile(metadata, directMetadata)) {
    throw new Error("The active AppImage changed during validation.");
  }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error("The active AppImage directory is invalid.");
  }
  const uid = currentUid();
  if (uid !== null && directoryMetadata.uid !== uid) {
    throw new Error("The active AppImage directory must be owned by the current user.");
  }
  await Promise.all([
    access(actualPath, constants.R_OK),
    access(actualDirectory, constants.R_OK | constants.W_OK),
  ]);
  return {
    paths: transactionPaths(actualDirectory, actualPath, channel),
    metadata,
  };
}

async function metadataIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function unlinkOwnedIdentity(path: string, expected: FileIdentity): Promise<void> {
  const metadata = await metadataIfPresent(path);
  if (!metadata) return;
  requireOwnedRegularFile(metadata, `The update transaction file ${basename(path)}`);
  if (!sameIdentity(metadata, expected)) {
    throw new Error(`The update transaction file ${basename(path)} changed unexpectedly.`);
  }
  const confirmed = await lstat(path);
  requireOwnedRegularFile(confirmed, `The update transaction file ${basename(path)}`);
  if (!sameFile(metadata, confirmed) || !sameIdentity(confirmed, expected)) {
    throw new Error(`The update transaction file ${basename(path)} changed unexpectedly.`);
  }
  await unlink(path);
}

async function unlinkOwnedRegular(path: string): Promise<void> {
  const metadata = await metadataIfPresent(path);
  if (!metadata) return;
  requireOwnedRegularFile(metadata, `The update transaction file ${basename(path)}`);
  await unlinkOwnedIdentity(path, identity(metadata));
}

async function readJournalRecord(
  paths: TransactionPaths,
  channel: InertiaReleaseChannel,
): Promise<UpdateJournalRecord | null> {
  const named = await metadataIfPresent(paths.journal);
  if (!named) return null;
  requireOwnedRegularFile(named, "The AppImage update recovery journal");
  if (named.size <= 0 || named.size > MAX_JOURNAL_BYTES) {
    throw new Error("The AppImage update recovery journal is oversized.");
  }
  const handle = await open(
    paths.journal,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    requireOwnedRegularFile(opened, "The AppImage update recovery journal");
    if (
      !sameFile(named, opened)
      || opened.size !== named.size
      || opened.size <= 0
      || opened.size > MAX_JOURNAL_BYTES
    ) throw new Error("The AppImage update recovery journal changed while opening.");
    const bytes = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.byteLength - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const [afterRead, afterNamed] = await Promise.all([
      handle.stat(),
      lstat(paths.journal),
    ]);
    requireOwnedRegularFile(afterRead, "The AppImage update recovery journal");
    requireOwnedRegularFile(afterNamed, "The AppImage update recovery journal");
    if (
      length !== opened.size
      || length > MAX_JOURNAL_BYTES
      || afterRead.size !== opened.size
      || afterNamed.size !== opened.size
      || afterRead.mode !== opened.mode
      || afterNamed.mode !== opened.mode
      || !sameFile(opened, afterRead)
      || !sameFile(opened, afterNamed)
    ) throw new Error("The AppImage update recovery journal changed while reading.");
    return {
      journal: parseJournal(
        JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown,
        channel,
        basename(paths.stable),
      ),
      identity: identity(opened),
    };
  } finally {
    await handle.close();
  }
}

async function readJournal(
  paths: TransactionPaths,
  channel: InertiaReleaseChannel,
): Promise<UpdateJournal | null> {
  return (await readJournalRecord(paths, channel))?.journal ?? null;
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const flags = constants.O_CREAT
    | constants.O_EXCL
    | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function installRecoveryJournal(
  paths: TransactionPaths,
  journal: PreparingJournal,
): Promise<void> {
  await writeExclusiveJson(paths.journal, journal);
  await syncDirectory(paths.directory);
}

async function promoteRecoveryJournal(
  paths: TransactionPaths,
  journal: PreparedJournal | HandoffJournal,
): Promise<void> {
  await writeExclusiveJson(paths.nextJournal, journal);
  await rename(paths.nextJournal, paths.journal);
  await syncDirectory(paths.directory);
}

async function copyVerifiedAppImage(
  downloadedPath: string,
  candidatePath: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  exactPath(downloadedPath, "The downloaded AppImage path");
  const directMetadata = await lstat(downloadedPath);
  requireOwnedRegularFile(directMetadata, "The downloaded AppImage");
  if (directMetadata.size <= 0 || directMetadata.size > MAX_APPIMAGE_BYTES) {
    throw new Error("The downloaded AppImage size is invalid.");
  }
  const actualPath = await realpath(downloadedPath);
  const sourceFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const destinationFlags = constants.O_CREAT
    | constants.O_EXCL
    | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0);
  const source = await open(actualPath, sourceFlags);
  let destination: Awaited<ReturnType<typeof open>> | null = null;
  let copiedIdentity: FileIdentity | null = null;
  try {
    const sourceMetadata = await source.stat();
    requireOwnedRegularFile(sourceMetadata, "The downloaded AppImage");
    if (!sameFile(sourceMetadata, directMetadata)) {
      throw new Error("The downloaded AppImage changed during validation.");
    }
    if (sourceMetadata.size !== directMetadata.size) {
      throw new Error("The downloaded AppImage changed size during validation.");
    }
    destination = await open(candidatePath, destinationFlags, 0o600);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (position < sourceMetadata.size) {
      const requested = Math.min(buffer.length, sourceMetadata.size - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error("The downloaded AppImage was truncated.");
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) throw new Error("The AppImage update copy stopped early.");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (position !== sourceMetadata.size) {
      throw new Error("The downloaded AppImage changed size during the update copy.");
    }
    await destination.chmod(0o755);
    await destination.sync();
    const copiedMetadata = await destination.stat();
    requireOwnedRegularFile(copiedMetadata, "The AppImage update candidate");
    if (copiedMetadata.size !== directMetadata.size) {
      throw new Error("The copied AppImage update has an unexpected size.");
    }
    copiedIdentity = identity(copiedMetadata);
  } finally {
    await Promise.allSettled([source.close(), destination?.close() ?? Promise.resolve()]);
  }
  const candidateMetadata = await lstat(candidatePath);
  requireOwnedRegularFile(candidateMetadata, "The AppImage update candidate");
  if (!copiedIdentity || !sameIdentity(candidateMetadata, copiedIdentity)) {
    throw new Error("The AppImage update candidate changed after it was copied.");
  }
  return candidateMetadata;
}

async function inspectAppImageFile(
  path: string,
  label: string,
  deadlineAt?: string,
): Promise<{
  readonly metadata: Awaited<ReturnType<typeof lstat>>;
  readonly identity: AppImageCandidateIdentity;
}> {
  const deadline = deadlineAt === undefined ? Number.MAX_SAFE_INTEGER : Date.parse(deadlineAt);
  const requireDeadline = (): void => {
    if (!Number.isFinite(deadline) || Date.now() >= deadline) {
      throw new Error(`${label} validation deadline expired.`);
    }
  };
  requireDeadline();
  exactPath(path, label);
  const named = await lstat(path);
  requireOwnedRegularFile(named, label);
  if (named.size <= 0 || named.size > MAX_APPIMAGE_BYTES) {
    throw new Error(`${label} size is invalid.`);
  }
  const actual = await realpath(path);
  const handle = await open(
    actual,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    requireDeadline();
    requireOwnedRegularFile(opened, label);
    if (!sameFile(named, opened) || named.size !== opened.size) {
      throw new Error(`${label} changed during identity validation.`);
    }
    const artifact = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (position < opened.size) {
      requireDeadline();
      const requested = Math.min(buffer.length, opened.size - position);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead <= 0) throw new Error(`${label} was truncated.`);
      artifact.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    requireDeadline();
    const afterRead = await handle.stat();
    const afterNamed = await lstat(path);
    requireDeadline();
    if (
      position !== opened.size
      || afterRead.size !== opened.size
      || afterRead.mode !== opened.mode
      || afterNamed.size !== opened.size
      || afterNamed.mode !== opened.mode
      || !sameFile(opened, afterRead)
      || !sameFile(opened, afterNamed)
    ) throw new Error(`${label} changed during identity validation.`);
    const executableIdentityDigest = createHash("sha256")
      .update("inertia.appimage-executable-identity.v1\0", "utf8")
      .update(JSON.stringify([
        String(opened.dev),
        String(opened.ino),
        opened.size,
        opened.mode & 0o777,
      ]), "utf8")
      .digest("hex");
    return {
      metadata: afterNamed,
      identity: {
        artifactDigest: artifact.digest("hex"),
        executableIdentityDigest,
      },
    };
  } finally {
    await handle.close();
  }
}

export async function appImageCandidateIdentity(
  path: string,
): Promise<AppImageCandidateIdentity> {
  return (await inspectAppImageFile(
    path,
    "The AppImage update candidate",
  )).identity;
}

async function cleanTransactionFiles(
  paths: TransactionPaths,
  original: FileIdentity,
  candidate?: FileIdentity,
  retainJournal = false,
  journalIdentity?: FileIdentity,
): Promise<void> {
  if (candidate) await unlinkOwnedIdentity(paths.candidate, candidate);
  else await unlinkOwnedRegular(paths.candidate);
  await unlinkOwnedIdentity(paths.backup, original);
  await unlinkOwnedRegular(paths.nextJournal);
  await syncDirectory(paths.directory);
  if (!retainJournal) {
    if (journalIdentity) {
      await unlinkOwnedIdentity(paths.journal, journalIdentity);
    } else {
      await unlinkOwnedRegular(paths.journal);
    }
    await syncDirectory(paths.directory);
  }
}

interface AppImageRecoveryOutcome {
  readonly activePath: string;
  readonly journal: HandoffJournal | null;
  readonly activeCandidateRolledBack: boolean;
}

function handoffRecoveryMatches(
  journal: UpdateJournal | null,
  expected: AppImageHandoffRecoveryExpectation,
): journal is HandoffJournal {
  return journal?.schema === 2
    && journal.operationId === expected.operationId
    && journal.candidateArtifactDigest === expected.artifactDigest
    && journal.candidateExecutableIdentityDigest
      === expected.executableIdentityDigest
    && expected.phases.includes(journal.phase);
}

async function recoverAppImageUpdateOutcome(
  options: RecoverAppImageUpdateOptions,
  expected?: AppImageHandoffRecoveryExpectation,
): Promise<AppImageRecoveryOutcome> {
  const active = await directActivePath(options.activePath, options.channel);
  const journalRecord = await readJournalRecord(active.paths, options.channel);
  const journal = journalRecord?.journal ?? null;
  if (expected && !handoffRecoveryMatches(journal, expected)) {
    throw new Error(
      "The AppImage update recovery journal does not match its handoff authority.",
    );
  }
  if (!journal) return {
    activePath: active.paths.original,
    journal: null,
    activeCandidateRolledBack: false,
  };
  const originalPath = join(active.paths.directory, journal.originalName);
  const journalPaths = transactionPaths(active.paths.directory, originalPath, options.channel);
  const activeIsOriginal = active.paths.original === originalPath
    && sameIdentity(active.metadata, journal.original);
  const activeIsStable = active.paths.original === journalPaths.stable;

  if (journal.phase === "preparing") {
    if (!activeIsOriginal && !activeIsStable) {
      throw new Error("The AppImage update recovery journal does not own the active application.");
    }
    await cleanTransactionFiles(
      journalPaths,
      journal.original,
      undefined,
      false,
      journalRecord?.identity,
    );
    return {
      activePath: active.paths.original,
      journal: null,
      activeCandidateRolledBack: false,
    };
  }

  const stableMetadata = await metadataIfPresent(journalPaths.stable);
  if (stableMetadata) {
    requireOwnedRegularFile(stableMetadata, "The stable AppImage");
  }
  const stableIsCandidate = stableMetadata !== null
    && sameIdentity(stableMetadata, journal.candidate);
  const stableIsOriginal = stableMetadata !== null
    && sameIdentity(stableMetadata, journal.original);

  if (activeIsStable && stableIsCandidate) {
    // Reaching the candidate executable proves only that the kernel started a
    // process. Without a token-bound bootstrap acknowledgement this crash
    // prefix cannot consume rollback authority or delete the known-good app.
    await rollbackTransaction(
      journalPaths,
      journal.original,
      journal.candidate,
      expected !== undefined,
      journalRecord?.identity,
    );
    return {
      activePath: originalPath,
      journal: journal.schema === 2 ? journal : null,
      activeCandidateRolledBack: true,
    };
  }
  if (!activeIsOriginal) {
    throw new Error("The active AppImage does not match its recovery journal.");
  }
  if (stableMetadata && !stableIsCandidate && !stableIsOriginal) {
    throw new Error("The stable AppImage changed before recovery.");
  }
  if (stableIsCandidate) {
    await unlinkOwnedIdentity(journalPaths.stable, journal.candidate);
  }
  await cleanTransactionFiles(
    journalPaths,
    journal.original,
    journal.candidate,
    expected !== undefined,
    journalRecord?.identity,
  );
  return {
    activePath: originalPath,
    journal: journal.schema === 2 ? journal : null,
    activeCandidateRolledBack: false,
  };
}

/** Recovers only files named and identified by Inertia's bounded transaction journal. */
export async function recoverAppImageUpdate(
  options: RecoverAppImageUpdateOptions,
): Promise<string> {
  const outcome = await recoverAppImageUpdateOutcome(options);
  if (outcome.activeCandidateRolledBack) {
    throw new Error(
      "The AppImage update was rolled back because candidate bootstrap was not acknowledged.",
    );
  }
  return outcome.activePath;
}

/**
 * Recovers a Linux candidate only when its companion filesystem journal is
 * bound to the exact durable handoff. The receipt remains available after the
 * transaction journal is removed so the caller can retire only that authority.
 */
export async function recoverAppImageUpdateForHandoff(
  options: RecoverAppImageUpdateOptions & {
    readonly expected: AppImageHandoffRecoveryExpectation;
  },
): Promise<AppImageHandoffRecoveryReceipt> {
  const outcome = await recoverAppImageUpdateOutcome(options, options.expected);
  const journal = outcome.journal;
  if (!journal) {
    throw new Error("The AppImage update recovery receipt is unavailable.");
  }
  return Object.freeze({
    activePath: outcome.activePath,
    operationId: journal.operationId,
    artifactDigest: journal.candidateArtifactDigest,
    executableIdentityDigest: journal.candidateExecutableIdentityDigest,
    phase: journal.phase,
    activeCandidateRolledBack: outcome.activeCandidateRolledBack,
  });
}

async function rollbackTransaction(
  paths: TransactionPaths,
  original: FileIdentity,
  candidate: FileIdentity | null,
  retainJournal = false,
  journalIdentity?: FileIdentity,
): Promise<void> {
  const backupMetadata = await metadataIfPresent(paths.backup);
  const originalMetadata = await metadataIfPresent(paths.original);
  const stableMetadata = await metadataIfPresent(paths.stable);
  if (backupMetadata) {
    requireOwnedRegularFile(backupMetadata, "The AppImage update rollback copy");
    if (!sameIdentity(backupMetadata, original)) {
      throw new Error("The AppImage update rollback copy changed before rollback.");
    }
  }
  if (originalMetadata) {
    requireOwnedRegularFile(originalMetadata, "The original AppImage");
  }
  if (stableMetadata) {
    requireOwnedRegularFile(stableMetadata, "The stable AppImage");
  }
  const backupIsOriginal = backupMetadata !== null
    && sameIdentity(backupMetadata, original);
  const originalIsOriginal = originalMetadata !== null
    && sameIdentity(originalMetadata, original);
  const stableIsOriginal = stableMetadata !== null
    && sameIdentity(stableMetadata, original);
  const stableIsCandidate = candidate !== null
    && stableMetadata !== null
    && sameIdentity(stableMetadata, candidate);

  if (paths.original === paths.stable) {
    if (!stableMetadata) {
      if (!backupIsOriginal) {
        throw new Error("The known-good AppImage is unavailable for rollback.");
      }
      await rename(paths.backup, paths.stable);
    } else if (stableIsCandidate) {
      if (!backupIsOriginal) {
        throw new Error("The known-good AppImage is unavailable for rollback.");
      }
      await rename(paths.backup, paths.stable);
    } else if (stableIsOriginal) {
      if (backupIsOriginal) {
        await unlinkOwnedIdentity(paths.backup, original);
      }
    } else {
      throw new Error("The stable AppImage changed before rollback.");
    }
    const restored = await lstat(paths.stable);
    requireOwnedRegularFile(restored, "The restored AppImage");
    if (!sameIdentity(restored, original)) {
      throw new Error("The known-good AppImage could not be restored exactly.");
    }
  } else {
    if (originalMetadata && !originalIsOriginal) {
      throw new Error("The original AppImage changed before rollback.");
    }
    if (stableMetadata && !stableIsCandidate && !stableIsOriginal) {
      throw new Error("The stable AppImage changed before rollback.");
    }
    if (!originalMetadata) {
      if (!backupIsOriginal) {
        throw new Error("The known-good AppImage is unavailable for rollback.");
      }
      // link(2) retains no-clobber semantics if the original name is recreated
      // concurrently. A retry removes the still-exact backup after the link is
      // durably visible.
      await link(paths.backup, paths.original);
      const restored = await lstat(paths.original);
      requireOwnedRegularFile(restored, "The restored AppImage");
      if (!sameIdentity(restored, original)) {
        throw new Error("The known-good AppImage could not be restored exactly.");
      }
    }
    if (backupIsOriginal) {
      await unlinkOwnedIdentity(paths.backup, original);
    }
    if (stableIsCandidate) {
      await unlinkOwnedIdentity(paths.stable, candidate!);
    }
  }
  if (candidate) await unlinkOwnedIdentity(paths.candidate, candidate);
  else await unlinkOwnedRegular(paths.candidate);
  await unlinkOwnedRegular(paths.nextJournal);
  await syncDirectory(paths.directory);
  if (!retainJournal) {
    if (journalIdentity) {
      await unlinkOwnedIdentity(paths.journal, journalIdentity);
    } else {
      await unlinkOwnedRegular(paths.journal);
    }
    await syncDirectory(paths.directory);
  }
}

function handoffJournalMatches(
  journal: UpdateJournal | null,
  expected: HandoffJournal,
  phase: HandoffJournal["phase"],
): journal is HandoffJournal {
  return journal?.schema === 2
    && journal.phase === phase
    && journal.operationId === expected.operationId
    && journal.originalName === expected.originalName
    && journal.stableName === expected.stableName
    && journal.original.dev === expected.original.dev
    && journal.original.ino === expected.original.ino
    && journal.candidate.dev === expected.candidate.dev
    && journal.candidate.ino === expected.candidate.ino
    && journal.candidateArtifactDigest === expected.candidateArtifactDigest
    && journal.candidateExecutableIdentityDigest
      === expected.candidateExecutableIdentityDigest;
}

/**
 * Stages an AppImage without transferring the stable executable identity.
 * The returned owner must either commit after exact candidate bootstrap or
 * roll back; a crash leaves enough direct-file authority for startup repair.
 */
export async function prepareAppImageUpdate(
  options: PrepareAppImageUpdateOptions,
): Promise<PreparedAppImageUpdate> {
  if (!UUID_PATTERN.test(options.operationId)) {
    throw new Error("The AppImage update operation identity is invalid.");
  }
  const recoveredPath = await recoverAppImageUpdate({
    channel: options.channel,
    activePath: options.activePath,
  });
  const active = await directActivePath(recoveredPath, options.channel);
  const { paths } = active;
  const originalIdentity = identity(active.metadata);
  const stableMetadata = paths.original === paths.stable
    ? active.metadata
    : await metadataIfPresent(paths.stable);
  if (stableMetadata && !sameFile(stableMetadata, active.metadata)) {
    throw new Error(`The stable AppImage path ${paths.stable} is already occupied.`);
  }
  for (const reserved of [
    paths.candidate,
    paths.backup,
    paths.journal,
    paths.nextJournal,
  ]) {
    if (await metadataIfPresent(reserved)) {
      throw new Error(
        `The AppImage update transaction path ${reserved} is already occupied.`,
      );
    }
  }

  const preparing: PreparingJournal = {
    schema: JOURNAL_SCHEMA,
    channel: options.channel,
    phase: "preparing",
    originalName: basename(paths.original),
    stableName: basename(paths.stable),
    original: originalIdentity,
  };
  let candidateIdentity: FileIdentity | null = null;
  try {
    await installRecoveryJournal(paths, preparing);
    const copied = await copyVerifiedAppImage(
      options.downloadedPath,
      paths.candidate,
    );
    candidateIdentity = identity(copied);
    const inspected = await inspectAppImageFile(
      paths.candidate,
      "The AppImage update candidate",
    );
    if (!sameIdentity(inspected.metadata, candidateIdentity)) {
      throw new Error("The AppImage update candidate identity changed.");
    }
    await link(paths.original, paths.backup);
    const backupMetadata = await lstat(paths.backup);
    requireOwnedRegularFile(backupMetadata, "The AppImage update rollback copy");
    if (!sameIdentity(backupMetadata, originalIdentity)) {
      throw new Error("The AppImage update rollback copy has the wrong identity.");
    }
    const staged = createHandoffJournal({
      channel: options.channel,
      phase: "staged",
      operationId: options.operationId,
      originalName: basename(paths.original),
      stableName: basename(paths.stable),
      original: originalIdentity,
      candidate: candidateIdentity,
      candidateArtifactDigest: inspected.identity.artifactDigest,
      candidateExecutableIdentityDigest:
        inspected.identity.executableIdentityDigest,
    });
    await promoteRecoveryJournal(paths, staged);
    let state: "staged" | "committed" | "rolled-back" = "staged";
    return Object.freeze({
      operationId: options.operationId,
      candidatePath: paths.candidate,
      stablePath: paths.stable,
      artifactDigest: inspected.identity.artifactDigest,
      executableIdentityDigest: inspected.identity.executableIdentityDigest,
      commit: async (): Promise<string> => {
        if (state !== "staged") {
          throw new Error("The AppImage update transaction cannot be committed.");
        }
        const journal = await readJournal(paths, options.channel);
        if (!handoffJournalMatches(journal, staged, "staged")) {
          throw new Error("The staged AppImage update authority changed.");
        }
        const currentOriginal = await lstat(paths.original);
        if (!sameIdentity(currentOriginal, originalIdentity)) {
          throw new Error("The active AppImage changed before commit.");
        }
        const currentCandidate = await inspectAppImageFile(
          paths.candidate,
          "The AppImage update candidate",
        );
        if (
          !sameIdentity(currentCandidate.metadata, candidateIdentity!)
          || currentCandidate.identity.artifactDigest
            !== staged.candidateArtifactDigest
          || currentCandidate.identity.executableIdentityDigest
            !== staged.candidateExecutableIdentityDigest
        ) throw new Error("The AppImage update candidate changed before commit.");
        if (paths.original === paths.stable) {
          await rename(paths.candidate, paths.stable);
        } else {
          await link(paths.candidate, paths.stable);
          await unlinkOwnedIdentity(paths.candidate, candidateIdentity!);
        }
        await syncDirectory(paths.directory);
        await promoteRecoveryJournal(paths, createHandoffJournal({
          channel: staged.channel,
          phase: "ownership-committed",
          operationId: staged.operationId,
          originalName: staged.originalName,
          stableName: staged.stableName,
          original: staged.original,
          candidate: staged.candidate,
          candidateArtifactDigest: staged.candidateArtifactDigest,
          candidateExecutableIdentityDigest:
            staged.candidateExecutableIdentityDigest,
        }));
        state = "committed";
        return paths.stable;
      },
      rollback: async (): Promise<void> => {
        if (state === "rolled-back") return;
        await rollbackTransaction(paths, originalIdentity, candidateIdentity);
        state = "rolled-back";
      },
    });
  } catch (error) {
    try {
      await rollbackTransaction(paths, originalIdentity, candidateIdentity);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "The AppImage update staging failed and could not be rolled back completely.",
      );
    }
    throw error;
  }
}
export async function validateStagedAppImageUpdate(options: {
  channel: InertiaReleaseChannel;
  operationId: string;
  candidatePath: string;
  artifactDigest: string;
  executableIdentityDigest: string;
  deadlineAt: string;
}): Promise<{ readonly stablePath: string }> {
  if (
    !UUID_PATTERN.test(options.operationId)
    || !DIGEST_PATTERN.test(options.artifactDigest)
    || !DIGEST_PATTERN.test(options.executableIdentityDigest)
  ) throw new Error("The staged AppImage update identity is invalid.");
  const candidate = await directActivePath(options.candidatePath, options.channel);
  if (candidate.paths.original !== candidate.paths.candidate) {
    throw new Error("The staged AppImage candidate path is invalid.");
  }
  const journal = await readJournal(candidate.paths, options.channel);
  if (
    journal?.schema !== 2
    || journal.phase !== "staged"
    || journal.operationId !== options.operationId
    || !sameIdentity(candidate.metadata, journal.candidate)
    || journal.candidateArtifactDigest !== options.artifactDigest
    || journal.candidateExecutableIdentityDigest
      !== options.executableIdentityDigest
  ) throw new Error("The staged AppImage update journal does not match.");
  const inspected = await inspectAppImageFile(
    candidate.paths.candidate,
    "The AppImage update candidate",
    options.deadlineAt,
  );
  if (
    inspected.identity.artifactDigest !== options.artifactDigest
    || inspected.identity.executableIdentityDigest
      !== options.executableIdentityDigest
  ) throw new Error("The staged AppImage update candidate does not match.");
  return Object.freeze({ stablePath: candidate.paths.stable });
}
export async function validateCommittedAppImageUpdate(options: {
  channel: InertiaReleaseChannel;
  operationId: string;
  stablePath: string;
  artifactDigest: string;
  executableIdentityDigest: string;
  deadlineAt: string;
}): Promise<void> {
  if (
    !UUID_PATTERN.test(options.operationId)
    || !DIGEST_PATTERN.test(options.artifactDigest)
    || !DIGEST_PATTERN.test(options.executableIdentityDigest)
  ) throw new Error("The committed AppImage update identity is invalid.");
  const active = await directActivePath(options.stablePath, options.channel);
  if (active.paths.original !== active.paths.stable) {
    throw new Error("The committed AppImage path is not stable.");
  }
  const journal = await readJournal(active.paths, options.channel);
  if (
    journal?.schema !== 2
    || journal.phase !== "ownership-committed"
    || journal.operationId !== options.operationId
    || !sameIdentity(active.metadata, journal.candidate)
    || journal.candidateArtifactDigest !== options.artifactDigest
    || journal.candidateExecutableIdentityDigest
      !== options.executableIdentityDigest
  ) throw new Error("The committed AppImage update journal does not match.");
  const inspected = await inspectAppImageFile(
    active.paths.stable,
    "The committed AppImage update candidate",
    options.deadlineAt,
  );
  if (
    inspected.identity.artifactDigest !== options.artifactDigest
    || inspected.identity.executableIdentityDigest
      !== options.executableIdentityDigest
  ) throw new Error("The committed AppImage update candidate does not match.");
}
/** Retires rollback authority only after the admitted candidate completes startup. */
export async function finalizeAppImageUpdate(options: {
  channel: InertiaReleaseChannel;
  operationId: string;
  stablePath: string;
  artifactDigest: string;
  executableIdentityDigest: string;
  testHooks?: {
    afterCleanupStep?: (
      step: AppImageFinalizationCleanupStep,
    ) => void | Promise<void>;
  };
}): Promise<void> {
  const active = await directActivePath(options.stablePath, options.channel);
  if (active.paths.original !== active.paths.stable) {
    throw new Error("The committed AppImage path is not stable.");
  }
  const inspected = await inspectAppImageFile(
    active.paths.stable,
    "The committed AppImage update candidate",
  );
  if (
    !sameFile(active.metadata, inspected.metadata)
    || inspected.identity.artifactDigest !== options.artifactDigest
    || inspected.identity.executableIdentityDigest
      !== options.executableIdentityDigest
  ) throw new Error("The committed AppImage update candidate does not match.");
  const journalRecord = await readJournalRecord(active.paths, options.channel);
  const journal = journalRecord?.journal ?? null;
  if (!journalRecord || !journal) {
    // Finalization removes the companion journal only after every identity-bound
    // rollback artifact. An exact outer `completed` handoff can therefore
    // resume after that unlink by re-proving the stable candidate identity and
    // the absence of all fixed transaction residue. This is the only safe
    // missing-journal crash prefix; any remaining residue stays fail-closed.
    const residue = await Promise.all([
      metadataIfPresent(active.paths.backup),
      metadataIfPresent(active.paths.candidate),
      metadataIfPresent(active.paths.nextJournal),
    ]);
    if (residue.some((entry) => entry !== null)) {
      throw new Error("The AppImage update finalization authority is unavailable.");
    }
    await syncDirectory(active.paths.directory);
    await options.testHooks?.afterCleanupStep?.("directory-synced");
    return;
  }
  if (
    journal.schema !== 2
    || journal.phase !== "ownership-committed"
    || journal.operationId !== options.operationId
    || !sameIdentity(active.metadata, journal.candidate)
    || journal.candidateArtifactDigest !== options.artifactDigest
    || journal.candidateExecutableIdentityDigest
      !== options.executableIdentityDigest
  ) {
    throw new Error("The AppImage update finalization authority is unavailable.");
  }
  const originalPath = join(active.paths.directory, journal.originalName);
  const paths = transactionPaths(
    active.paths.directory,
    originalPath,
    options.channel,
  );
  const unexpectedResidue = await Promise.all([
    metadataIfPresent(paths.candidate),
    metadataIfPresent(paths.nextJournal),
  ]);
  if (unexpectedResidue.some((entry) => entry !== null)) {
    throw new Error("The AppImage update finalization residue is ambiguous.");
  }
  const stableBeforeCleanup = await lstat(paths.stable);
  requireOwnedRegularFile(
    stableBeforeCleanup,
    "The committed AppImage update candidate",
  );
  if (!sameIdentity(stableBeforeCleanup, journal.candidate)) {
    throw new Error("The committed AppImage update candidate changed before cleanup.");
  }
  await unlinkOwnedIdentity(paths.backup, journal.original);
  await options.testHooks?.afterCleanupStep?.("backup-unlinked");
  if (paths.original !== paths.stable) {
    await unlinkOwnedIdentity(paths.original, journal.original);
  }
  await options.testHooks?.afterCleanupStep?.("original-unlinked");
  const residueBeforeRetirement = await Promise.all([
    metadataIfPresent(paths.backup),
    paths.original === paths.stable
      ? Promise.resolve(null)
      : metadataIfPresent(paths.original),
    metadataIfPresent(paths.candidate),
    metadataIfPresent(paths.nextJournal),
  ]);
  if (residueBeforeRetirement.some((entry) => entry !== null)) {
    throw new Error("The AppImage update finalization residue is ambiguous.");
  }
  const stableBeforeRetirement = await lstat(paths.stable);
  requireOwnedRegularFile(
    stableBeforeRetirement,
    "The committed AppImage update candidate",
  );
  if (!sameIdentity(stableBeforeRetirement, journal.candidate)) {
    throw new Error("The committed AppImage update candidate changed before retirement.");
  }
  await options.testHooks?.afterCleanupStep?.("next-journal-unlinked");
  // Make every rollback-artifact deletion durable before removing the only
  // companion record that carries the versioned original pathname. If a power
  // loss makes the journal unlink observable, the earlier cleanup is already
  // durable and the missing-journal retry is unambiguous.
  await syncDirectory(paths.directory);
  await options.testHooks?.afterCleanupStep?.("rollback-residue-synced");
  await unlinkOwnedIdentity(paths.journal, journalRecord.identity);
  await options.testHooks?.afterCleanupStep?.("journal-unlinked");
  await syncDirectory(paths.directory);
  await options.testHooks?.afterCleanupStep?.("directory-synced");
}

/** Refuses launch until a restricted bootstrap can return an exact ACK. */
export async function launchAppImage(
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  exactPath(path, "The installed AppImage path");
  void environment;
  // Process creation proves neither candidate identity nor bootstrap safety.
  // Until main startup has a restricted, token-bound acknowledgement path,
  // production installation must roll this filesystem transaction back.
  throw new Error(
    "The updated AppImage cannot be admitted without a verified bootstrap acknowledgement.",
  );
}

/** Installs one verified updater download under the channel's durable AppImage name. */
export async function installAppImageUpdate(
  options: InstallAppImageUpdateOptions,
): Promise<string> {
  const recoveredPath = await recoverAppImageUpdate({
    channel: options.channel,
    activePath: options.activePath,
  });
  const active = await directActivePath(recoveredPath, options.channel);
  const { paths } = active;
  const originalIdentity = identity(active.metadata);
  const stableMetadata = paths.original === paths.stable
    ? active.metadata
    : await metadataIfPresent(paths.stable);
  if (stableMetadata && !sameFile(stableMetadata, active.metadata)) {
    throw new Error(`The stable AppImage path ${paths.stable} is already occupied.`);
  }
  for (const reserved of [paths.candidate, paths.backup, paths.journal, paths.nextJournal]) {
    if (await metadataIfPresent(reserved)) {
      throw new Error(`The AppImage update transaction path ${reserved} is already occupied.`);
    }
  }

  const preparing: PreparingJournal = {
    schema: JOURNAL_SCHEMA,
    channel: options.channel,
    phase: "preparing",
    originalName: basename(paths.original),
    stableName: basename(paths.stable),
    original: originalIdentity,
  };
  let candidateIdentity: FileIdentity | null = null;
  let replacementLaunched = false;
  try {
    await installRecoveryJournal(paths, preparing);
    const candidateMetadata = await copyVerifiedAppImage(
      options.downloadedPath,
      paths.candidate,
    );
    candidateIdentity = identity(candidateMetadata);
    await link(paths.original, paths.backup);
    const backupMetadata = await lstat(paths.backup);
    requireOwnedRegularFile(backupMetadata, "The AppImage update rollback copy");
    if (!sameIdentity(backupMetadata, originalIdentity)) {
      throw new Error("The AppImage update rollback copy has the wrong identity.");
    }
    await promoteRecoveryJournal(paths, {
      ...preparing,
      phase: "prepared",
      candidate: candidateIdentity,
    });
    const currentMetadata = await lstat(paths.original);
    if (!sameIdentity(currentMetadata, originalIdentity)) {
      throw new Error("The active AppImage changed before the atomic update.");
    }
    const currentCandidate = await lstat(paths.candidate);
    requireOwnedRegularFile(currentCandidate, "The AppImage update candidate");
    if (!sameIdentity(currentCandidate, candidateIdentity)) {
      throw new Error("The AppImage update candidate changed before installation.");
    }
    if (paths.original === paths.stable) {
      await rename(paths.candidate, paths.stable);
    } else {
      // link(2) is an atomic no-clobber install. A stable path created after
      // validation makes the transaction fail closed instead of being replaced.
      await link(paths.candidate, paths.stable);
      await unlinkOwnedIdentity(paths.candidate, candidateIdentity);
    }
    await syncDirectory(paths.directory);
    await (options.launch ?? launchAppImage)(
      paths.stable,
      options.environment ?? process.env,
    );
    replacementLaunched = true;
    // Once the stable executable has launched, it is the recovery authority.
    // Remove the hard-link backup before the versioned original so every
    // interrupted cleanup still leaves at least one known-good executable.
    await unlinkOwnedIdentity(paths.backup, originalIdentity);
    if (paths.original !== paths.stable) {
      await unlinkOwnedIdentity(paths.original, originalIdentity);
    }
    await unlinkOwnedRegular(paths.journal);
    await syncDirectory(paths.directory);
    return paths.stable;
  } catch (error) {
    if (replacementLaunched) return paths.stable;
    try {
      await rollbackTransaction(paths, originalIdentity, candidateIdentity);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "The AppImage update failed and could not be rolled back completely.",
      );
    }
    throw error;
  }
}

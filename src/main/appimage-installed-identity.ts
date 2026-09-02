import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  link,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  installedApplicationName,
  type InertiaReleaseChannel,
} from "./release-channel.js";

const MAX_PATH_BYTES = 4 * 1_024;
const MAX_JOURNAL_BYTES = 16 * 1_024;
const MAX_APPIMAGE_BYTES = 4 * 1_024 * 1_024 * 1_024;
const COPY_BUFFER_BYTES = 1024 * 1_024;
const LAUNCH_TIMEOUT_MS = 5_000;
const JOURNAL_SCHEMA = 1;

interface FileIdentity {
  dev: string;
  ino: string;
}

interface PreparingJournal {
  schema: typeof JOURNAL_SCHEMA;
  channel: InertiaReleaseChannel;
  phase: "preparing";
  originalName: string;
  stableName: string;
  original: FileIdentity;
}

interface PreparedJournal extends Omit<PreparingJournal, "phase"> {
  phase: "prepared";
  candidate: FileIdentity;
}

type UpdateJournal = PreparingJournal | PreparedJournal;

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
  await unlink(path);
}

async function unlinkOwnedRegular(path: string): Promise<void> {
  const metadata = await metadataIfPresent(path);
  if (!metadata) return;
  requireOwnedRegularFile(metadata, `The update transaction file ${basename(path)}`);
  await unlink(path);
}

function validIdentity(value: unknown): value is FileIdentity {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "dev\0ino"
    && typeof (value as FileIdentity).dev === "string"
    && /^(?:0|[1-9]\d*)$/u.test((value as FileIdentity).dev)
    && typeof (value as FileIdentity).ino === "string"
    && /^(?:0|[1-9]\d*)$/u.test((value as FileIdentity).ino);
}

function parseJournal(
  value: unknown,
  channel: InertiaReleaseChannel,
  stableName: string,
): UpdateJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The AppImage update recovery journal is invalid.");
  }
  const candidate = value as {
    schema?: unknown;
    channel?: unknown;
    phase?: unknown;
    originalName?: unknown;
    stableName?: unknown;
    original?: unknown;
    candidate?: unknown;
  };
  const keys = Object.keys(value).sort().join("\0");
  const expectedKeys = candidate.phase === "prepared"
    ? "candidate\0channel\0original\0originalName\0phase\0schema\0stableName"
    : "channel\0original\0originalName\0phase\0schema\0stableName";
  if (
    keys !== expectedKeys
    || candidate.schema !== JOURNAL_SCHEMA
    || candidate.channel !== channel
    || (candidate.phase !== "preparing" && candidate.phase !== "prepared")
    || typeof candidate.originalName !== "string"
    || basename(candidate.originalName) !== candidate.originalName
    || candidate.originalName.length === 0
    || candidate.stableName !== stableName
    || !validIdentity(candidate.original)
    || (candidate.phase === "prepared" && !validIdentity(candidate.candidate))
  ) {
    throw new Error("The AppImage update recovery journal is invalid.");
  }
  return candidate as UpdateJournal;
}

async function readJournal(
  paths: TransactionPaths,
  channel: InertiaReleaseChannel,
): Promise<UpdateJournal | null> {
  const metadata = await metadataIfPresent(paths.journal);
  if (!metadata) return null;
  requireOwnedRegularFile(metadata, "The AppImage update recovery journal");
  if (metadata.size <= 0 || metadata.size > MAX_JOURNAL_BYTES) {
    throw new Error("The AppImage update recovery journal is oversized.");
  }
  const source = await readFile(paths.journal, "utf8");
  return parseJournal(
    JSON.parse(source) as unknown,
    channel,
    basename(paths.stable),
  );
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
  journal: PreparedJournal,
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
  try {
    const sourceMetadata = await source.stat();
    requireOwnedRegularFile(sourceMetadata, "The downloaded AppImage");
    if (!sameFile(sourceMetadata, directMetadata)) {
      throw new Error("The downloaded AppImage changed during validation.");
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
    await destination.sync();
  } finally {
    await Promise.allSettled([source.close(), destination?.close() ?? Promise.resolve()]);
  }
  await chmod(candidatePath, 0o755);
  const candidateMetadata = await lstat(candidatePath);
  requireOwnedRegularFile(candidateMetadata, "The AppImage update candidate");
  if (candidateMetadata.size !== directMetadata.size) {
    throw new Error("The copied AppImage update has an unexpected size.");
  }
  return candidateMetadata;
}

async function cleanTransactionFiles(
  paths: TransactionPaths,
  original: FileIdentity,
  candidate?: FileIdentity,
): Promise<void> {
  if (candidate) await unlinkOwnedIdentity(paths.candidate, candidate);
  else await unlinkOwnedRegular(paths.candidate);
  await unlinkOwnedIdentity(paths.backup, original);
  await unlinkOwnedRegular(paths.nextJournal);
  await unlinkOwnedRegular(paths.journal);
  await syncDirectory(paths.directory);
}

/** Recovers only files named and identified by Inertia's bounded transaction journal. */
export async function recoverAppImageUpdate(
  options: RecoverAppImageUpdateOptions,
): Promise<string> {
  const active = await directActivePath(options.activePath, options.channel);
  const journal = await readJournal(active.paths, options.channel);
  if (!journal) return active.paths.original;
  const originalPath = join(active.paths.directory, journal.originalName);
  const journalPaths = transactionPaths(active.paths.directory, originalPath, options.channel);
  const activeIsOriginal = active.paths.original === originalPath
    && sameIdentity(active.metadata, journal.original);
  const activeIsStable = active.paths.original === journalPaths.stable;

  if (journal.phase === "preparing") {
    if (!activeIsOriginal && !activeIsStable) {
      throw new Error("The AppImage update recovery journal does not own the active application.");
    }
    await cleanTransactionFiles(journalPaths, journal.original);
    return active.paths.original;
  }

  const stableMetadata = await metadataIfPresent(journalPaths.stable);
  const stableIsCandidate = stableMetadata !== null
    && !stableMetadata.isSymbolicLink()
    && stableMetadata.isFile()
    && sameIdentity(stableMetadata, journal.candidate);

  if (activeIsStable && stableIsCandidate) {
    if (originalPath !== journalPaths.stable) {
      await unlinkOwnedIdentity(originalPath, journal.original);
    }
    await cleanTransactionFiles(journalPaths, journal.original, journal.candidate);
    return journalPaths.stable;
  }
  if (!activeIsOriginal) {
    throw new Error("The active AppImage does not match its recovery journal.");
  }
  if (stableIsCandidate) await unlink(journalPaths.stable);
  await cleanTransactionFiles(journalPaths, journal.original, journal.candidate);
  return originalPath;
}

async function rollbackTransaction(
  paths: TransactionPaths,
  original: FileIdentity,
  candidate: FileIdentity | null,
): Promise<void> {
  const backupMetadata = await metadataIfPresent(paths.backup);
  const originalMetadata = await metadataIfPresent(paths.original);
  const stableMetadata = await metadataIfPresent(paths.stable);
  const stableIsCandidate = candidate !== null
    && stableMetadata !== null
    && !stableMetadata.isSymbolicLink()
    && stableMetadata.isFile()
    && sameIdentity(stableMetadata, candidate);

  if (paths.original === paths.stable) {
    if (backupMetadata && sameIdentity(backupMetadata, original)) {
      if (
        stableMetadata
        && !sameIdentity(stableMetadata, original)
        && (candidate === null || !sameIdentity(stableMetadata, candidate))
      ) {
        throw new Error("The stable AppImage changed before rollback.");
      }
      await rename(paths.backup, paths.stable);
    }
  } else {
    if (!originalMetadata && backupMetadata && sameIdentity(backupMetadata, original)) {
      await rename(paths.backup, paths.original);
    } else if (backupMetadata && sameIdentity(backupMetadata, original)) {
      await unlink(paths.backup);
    }
    if (stableIsCandidate) await unlink(paths.stable);
  }
  if (candidate) await unlinkOwnedIdentity(paths.candidate, candidate);
  else await unlinkOwnedRegular(paths.candidate);
  await unlinkOwnedRegular(paths.nextJournal);
  await unlinkOwnedRegular(paths.journal);
  await syncDirectory(paths.directory);
}

export async function launchAppImage(
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  exactPath(path, "The installed AppImage path");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(path, [], {
      detached: true,
      env: {
        ...environment,
        APPIMAGE: path,
        APPIMAGE_SILENT_INSTALL: "true",
        APPIMAGE_EXIT_AFTER_INSTALL: undefined,
      },
      shell: false,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
      if (error) reject(error);
      else {
        child.unref();
        resolve();
      }
    };
    const onError = (error: Error): void => finish(error);
    const onSpawn = (): void => finish();
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("The updated AppImage did not launch in time."));
    }, LAUNCH_TIMEOUT_MS);
    timeout.unref?.();
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
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
    await rename(paths.candidate, paths.stable);
    await syncDirectory(paths.directory);
    await (options.launch ?? launchAppImage)(
      paths.stable,
      options.environment ?? process.env,
    );
    if (paths.original !== paths.stable) {
      await unlinkOwnedIdentity(paths.original, originalIdentity);
    }
    await unlinkOwnedIdentity(paths.backup, originalIdentity);
    await unlinkOwnedRegular(paths.journal);
    await syncDirectory(paths.directory);
    return paths.stable;
  } catch (error) {
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

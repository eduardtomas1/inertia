import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenMatches,
  type AppUpdateHandoffChannel,
  type AppUpdateHandoffSnapshot,
} from "./app-update-handoff.js";
import {
  AppUpdateHandoffTokenVault,
  type AppUpdateHandoffTokenClaim,
} from "./app-update-handoff-token-vault.js";
import {
  validateCommittedAppImageUpdate,
  validateStagedAppImageUpdate,
} from "./appimage-installed-identity.js";
import { forceKillRuntimeProcessTree } from "./runtime-process-tree.js";
import { exactProcessGroupTerminal } from
  "../node/runtime-owned-process-posix.js";

const CANDIDATE_MODE = "bootstrap-v1";
const MAX_PATH_BYTES = 4 * 1_024;
const MAX_PACKET_BYTES = 2 * 1_024;
const MAX_BOOTSTRAP_WAIT_MS = 60_000;
const MAX_UPDATE_ARTIFACT_BYTES = 4 * 1_024 * 1_024 * 1_024;
const FILE_HASH_BUFFER_BYTES = 1024 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const WINDOWS_CANDIDATE_DIGEST_MARKER =
  "inertia.windows-candidate-executable-sha256.v1:";
const WINDOWS_CANDIDATE_DIGEST_MARKER_BYTES = Buffer.from(
  WINDOWS_CANDIDATE_DIGEST_MARKER,
  "utf16le",
);
const WINDOWS_CANDIDATE_DIGEST_RECORD_BYTES =
  WINDOWS_CANDIDATE_DIGEST_MARKER_BYTES.byteLength + (64 * 2) + 2;
const VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const APP_UPDATE_CANDIDATE_ENV = Object.freeze({
  mode: "INERTIA_APP_UPDATE_CANDIDATE_MODE",
  operationId: "INERTIA_APP_UPDATE_OPERATION_ID",
  handoffDirectory: "INERTIA_APP_UPDATE_HANDOFF_DIRECTORY",
  profileDirectory: "INERTIA_APP_UPDATE_PROFILE_DIRECTORY",
  dataDirectory: "INERTIA_APP_UPDATE_DATA_DIRECTORY",
} as const);

interface CandidateSecretPacket {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly handoffToken: string;
}

interface CandidateAckPacket {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly revision: number;
  readonly checksum: string;
}

export interface AppUpdateCandidateBootstrapRequest {
  readonly operationId: string;
  readonly handoffDirectory: string;
  readonly profileDirectory: string;
  readonly dataDirectory: string;
}

export interface AppUpdateLinuxCandidateAdmission {
  readonly platform: "linux";
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly handoffToken: string;
  readonly stableAppImagePath: string;
}

export interface AppUpdateWindowsCandidateAdmission {
  readonly platform: "win32";
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly handoffToken: string;
  readonly tokenClaim: AppUpdateHandoffTokenClaim;
}

export type AppUpdateCandidateAdmission =
  | AppUpdateLinuxCandidateAdmission
  | AppUpdateWindowsCandidateAdmission;

export interface AppUpdateWindowsCandidateBootstrapRequest {
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly handoffDirectory: string;
  readonly profileDirectory: string;
  readonly dataDirectory: string;
  readonly executablePath: string;
}

export interface AppUpdateCandidateProcess {
  readonly pid: number;
  readonly acknowledgement: AppUpdateHandoffSnapshot;
  alive(): boolean;
  abort(): Promise<void>;
}

export interface AppUpdateArtifactIdentity {
  readonly artifactDigest: string;
  readonly directFileIdentityDigest: string;
}

export interface WindowsAppUpdateInstallerIdentity
  extends AppUpdateArtifactIdentity {
  readonly candidateExecutableDigest: string;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function boundedAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && isAbsolute(value)
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES;
}

function ownedDirectory(path: string): {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
} {
  if (!boundedAbsolutePath(path)) {
    throw new Error("The app update identity path is invalid.");
  }
  const direct = lstatSync(path, { bigint: true });
  if (direct.isSymbolicLink() || !direct.isDirectory()) {
    throw new Error("The app update identity path is not a direct directory.");
  }
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (uid !== null && direct.uid !== BigInt(uid)) {
    throw new Error("The app update identity directory has a foreign owner.");
  }
  const actualPath = realpathSync(path);
  const actual = lstatSync(actualPath, { bigint: true });
  if (
    !actual.isDirectory()
    || actual.dev !== direct.dev
    || actual.ino !== direct.ino
  ) throw new Error("The app update identity directory changed.");
  return {
    path: actualPath,
    dev: String(actual.dev),
    ino: String(actual.ino),
  };
}

export function appUpdateDirectoryIdentityDigest(
  path: string,
  kind: "data" | "profile",
): string {
  const directory = ownedDirectory(path);
  return createHash("sha256")
    .update(`inertia.app-update-${kind}-identity.v1\0`, "utf8")
    .update(JSON.stringify([
      directory.path,
      directory.dev,
      directory.ino,
    ]), "utf8")
    .digest("hex");
}

function sameFileIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

function requireOwnedRegularFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The app update artifact is not a direct regular file.");
  }
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (uid !== null && metadata.uid !== uid) {
    throw new Error("The app update artifact has a foreign owner.");
  }
  if (metadata.size <= 0 || metadata.size > MAX_UPDATE_ARTIFACT_BYTES) {
    throw new Error("The app update artifact size is invalid.");
  }
}

function collectWindowsCandidateExecutableDigests(
  bytes: Buffer,
  digests: Set<string>,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const markerAt = bytes.indexOf(
      WINDOWS_CANDIDATE_DIGEST_MARKER_BYTES,
      offset,
    );
    if (markerAt < 0) return;
    const recordEnd = markerAt + WINDOWS_CANDIDATE_DIGEST_RECORD_BYTES;
    if (
      recordEnd <= bytes.byteLength
      && bytes[recordEnd - 2] === 0
      && bytes[recordEnd - 1] === 0
    ) {
      const digestBytes = bytes.subarray(
        markerAt + WINDOWS_CANDIDATE_DIGEST_MARKER_BYTES.byteLength,
        recordEnd - 2,
      );
      let canonicalUtf16 = true;
      for (let index = 1; index < digestBytes.byteLength; index += 2) {
        if (digestBytes[index] !== 0) {
          canonicalUtf16 = false;
          break;
        }
      }
      if (canonicalUtf16) {
        const digest = digestBytes.toString("utf16le");
        if (DIGEST_PATTERN.test(digest)) digests.add(digest);
      }
    }
    offset = markerAt + 2;
  }
}

async function inspectAppUpdateArtifact(
  path: string,
  readWindowsCandidateDigest: boolean,
): Promise<{
  readonly artifactDigest: string;
  readonly candidateExecutableDigest: string | null;
  readonly directFileIdentityDigest: string;
}> {
  if (!boundedAbsolutePath(path)) {
    throw new Error("The app update artifact path is invalid.");
  }
  const named = await lstat(path);
  requireOwnedRegularFile(named);
  const actualPath = await realpath(path);
  const handle = await open(
    actualPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    requireOwnedRegularFile(opened);
    if (!sameFileIdentity(named, opened) || named.size !== opened.size) {
      throw new Error("The app update artifact changed before hashing.");
    }
    const digest = createHash("sha256");
    const candidateDigests = new Set<string>();
    const buffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES);
    let scanTail = Buffer.alloc(0);
    let position = 0;
    while (position < opened.size) {
      const requested = Math.min(buffer.byteLength, opened.size - position);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("The app update artifact was truncated while hashing.");
      }
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (readWindowsCandidateDigest) {
        const scanWindow = scanTail.byteLength === 0
          ? chunk
          : Buffer.concat([scanTail, chunk]);
        collectWindowsCandidateExecutableDigests(scanWindow, candidateDigests);
        const retainedBytes = Math.min(
          WINDOWS_CANDIDATE_DIGEST_RECORD_BYTES - 1,
          scanWindow.byteLength,
        );
        scanTail = Buffer.from(scanWindow.subarray(
          scanWindow.byteLength - retainedBytes,
        ));
      }
      position += bytesRead;
    }
    const afterRead = await handle.stat();
    const afterNamed = await lstat(path);
    if (
      position !== opened.size
      || afterRead.size !== opened.size
      || afterNamed.size !== opened.size
      || !sameFileIdentity(opened, afterRead)
      || !sameFileIdentity(opened, afterNamed)
    ) throw new Error("The app update artifact changed while hashing.");
    if (readWindowsCandidateDigest && candidateDigests.size !== 1) {
      throw new Error("The Windows installer candidate identity is invalid.");
    }
    return Object.freeze({
      artifactDigest: digest.digest("hex"),
      candidateExecutableDigest: readWindowsCandidateDigest
        ? [...candidateDigests][0]!
        : null,
      directFileIdentityDigest: createHash("sha256")
        .update("inertia.app-update-artifact-file-identity.v1\0", "utf8")
        .update(JSON.stringify([
          String(opened.dev),
          String(opened.ino),
          opened.size,
          opened.mode & 0o777,
        ]), "utf8")
        .digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

/** Pins and hashes the exact updater-owned artifact selected for installation. */
export async function appUpdateArtifactIdentity(
  path: string,
): Promise<AppUpdateArtifactIdentity> {
  const inspected = await inspectAppUpdateArtifact(path, false);
  return Object.freeze({
    artifactDigest: inspected.artifactDigest,
    directFileIdentityDigest: inspected.directFileIdentityDigest,
  });
}

export function parseWindowsInstallerCandidateExecutableDigest(
  value: unknown,
): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8")
      !== WINDOWS_CANDIDATE_DIGEST_MARKER.length + 64
    || !value.startsWith(WINDOWS_CANDIDATE_DIGEST_MARKER)
  ) throw new Error("The Windows installer candidate identity is invalid.");
  const digest = value.slice(WINDOWS_CANDIDATE_DIGEST_MARKER.length);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error("The Windows installer candidate identity is invalid.");
  }
  return digest;
}

/** Pins one NSIS byte stream while hashing it and reading its signed marker. */
export async function windowsAppUpdateInstallerIdentity(
  installerPath: string,
): Promise<WindowsAppUpdateInstallerIdentity> {
  const inspected = await inspectAppUpdateArtifact(installerPath, true);
  return Object.freeze({
    artifactDigest: inspected.artifactDigest,
    candidateExecutableDigest: inspected.candidateExecutableDigest!,
    directFileIdentityDigest: inspected.directFileIdentityDigest,
  });
}

/** Binds one exact signed NSIS artifact to its exact installed executable. */
export function windowsAppUpdateExecutableLineageDigest(options: {
  readonly artifactDigest: string;
  readonly candidateExecutableDigest: string;
  readonly executablePath: string;
  readonly version: string;
}): string {
  if (
    !DIGEST_PATTERN.test(options.artifactDigest)
    || !DIGEST_PATTERN.test(options.candidateExecutableDigest)
    || !boundedAbsolutePath(options.executablePath)
    || options.version.length > 96
    || !VERSION_PATTERN.test(options.version)
  ) throw new Error("The Windows app update executable lineage is invalid.");
  const direct = lstatSync(options.executablePath, { bigint: true });
  if (direct.isSymbolicLink() || !direct.isFile()) {
    throw new Error("The Windows app update executable is not a direct file.");
  }
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (uid !== null && direct.uid !== BigInt(uid)) {
    throw new Error("The Windows app update executable has a foreign owner.");
  }
  const actualPath = realpathSync(options.executablePath);
  const actual = lstatSync(actualPath, { bigint: true });
  if (!actual.isFile() || !sameFileIdentity(direct, actual)) {
    throw new Error("The Windows app update executable identity changed.");
  }
  return createHash("sha256")
    .update("inertia.windows-app-update-executable-lineage.v1\0", "utf8")
    .update(JSON.stringify([
      actualPath.replaceAll("\\", "/").toLowerCase(),
      options.version,
      options.artifactDigest,
      options.candidateExecutableDigest,
    ]), "utf8")
    .digest("hex");
}

const WINDOWS_RESUMABLE_CANDIDATE_PHASES = new Set([
  "ownership-transfer-committed",
  "candidate-launched",
  "candidate-bootstrap-validated",
  "candidate-admitted",
]);

/**
 * Detects a native-updater candidate before ordinary application admission.
 * This inspection is deliberately non-mutating so a still-running old
 * generation retains its singleton authority.
 */
export async function windowsAppUpdateCandidateBootstrapRequest(options: {
  readonly handoffDirectory: string;
  readonly profileDirectory: string;
  readonly dataDirectory: string;
  readonly executablePath: string;
  readonly channel: AppUpdateHandoffChannel;
  readonly version: string;
  readonly now?: Date;
}): Promise<AppUpdateWindowsCandidateBootstrapRequest | null> {
  const journal = new AppUpdateHandoffJournal(options.handoffDirectory);
  const snapshot = journal.current();
  if (!snapshot) return null;
  if (snapshot.platform !== "win32") {
    throw new Error("The pending app update belongs to another platform.");
  }
  if (!WINDOWS_RESUMABLE_CANDIDATE_PHASES.has(snapshot.phase)) return null;
  if (
    snapshot.channel !== options.channel
    || snapshot.newVersion !== options.version
    || snapshot.profileIdentityDigest !== appUpdateDirectoryIdentityDigest(
      options.profileDirectory,
      "profile",
    )
    || snapshot.dataIdentityDigest !== appUpdateDirectoryIdentityDigest(
      options.dataDirectory,
      "data",
    )
    || (options.now ?? new Date()).getTime() > Date.parse(snapshot.deadlineAt)
  ) throw new Error("The Windows app update candidate lineage is invalid.");
  const candidateExecutable = await appUpdateArtifactIdentity(
    options.executablePath,
  );
  if (
    snapshot.candidateExecutableIdentityDigest
      !== windowsAppUpdateExecutableLineageDigest({
        artifactDigest: snapshot.candidateArtifactDigest,
        candidateExecutableDigest: candidateExecutable.artifactDigest,
        executablePath: options.executablePath,
        version: options.version,
      })
  ) throw new Error("The Windows app update candidate lineage is invalid.");
  return Object.freeze({
    snapshot,
    handoffDirectory: options.handoffDirectory,
    profileDirectory: options.profileDirectory,
    dataDirectory: options.dataDirectory,
    executablePath: options.executablePath,
  });
}

/**
 * Claims and authenticates the durable Windows receipt only after the caller
 * owns the singleton lock. It performs no normal bootstrap or provider work.
 */
export async function runRestrictedWindowsAppUpdateCandidate(
  request: AppUpdateWindowsCandidateBootstrapRequest,
  validateBootstrap: (operationId: string) => Promise<void>,
): Promise<AppUpdateWindowsCandidateAdmission> {
  const journal = new AppUpdateHandoffJournal(request.handoffDirectory);
  let current = journal.current();
  if (
    !current
    || current.operationId !== request.snapshot.operationId
    || current.checksum !== request.snapshot.checksum
    || !WINDOWS_RESUMABLE_CANDIDATE_PHASES.has(current.phase)
  ) throw new Error("The Windows app update admission authority changed.");
  const vault = new AppUpdateHandoffTokenVault(request.handoffDirectory);
  const claim = vault.claim(current, { recoverAbandonedClaim: true });
  if (!claim) throw new Error("The Windows app update token could not be claimed.");
  try {
    if (current.phase === "ownership-transfer-committed") {
      const launched = journal.transition(
        appUpdateHandoffOwner(current),
        "candidate-launched",
      );
      if (!launched) throw new Error("The Windows candidate launch was not recorded.");
      current = launched;
    }
    await validateBootstrap(current.operationId);
    if (current.phase === "candidate-launched") {
      const acknowledged = journal.acknowledgeCandidateBootstrap(
        appUpdateHandoffOwner(current),
        {
          operationId: current.operationId,
          platform: current.platform,
          channel: current.channel,
          oldVersion: current.oldVersion,
          newVersion: current.newVersion,
          oldRuntimeGenerationId: current.oldRuntimeGenerationId,
          candidateArtifactDigest: current.candidateArtifactDigest,
          candidateExecutableIdentityDigest:
            current.candidateExecutableIdentityDigest,
          profileIdentityDigest: current.profileIdentityDigest,
          dataIdentityDigest: current.dataIdentityDigest,
          handoffToken: claim.token,
        },
      );
      if (!acknowledged) {
        throw new Error("The Windows candidate acknowledgement was rejected.");
      }
      current = acknowledged;
    }
    if (
      current.phase !== "candidate-bootstrap-validated"
      && current.phase !== "candidate-admitted"
    ) throw new Error("The Windows candidate bootstrap phase is invalid.");
    return Object.freeze({
      platform: "win32",
      snapshot: current,
      handoffToken: claim.token,
      tokenClaim: claim,
    });
  } catch (error) {
    if (!claim.rollback()) {
      throw new AggregateError(
        [error],
        "The rejected Windows candidate retained its token claim.",
      );
    }
    throw error;
  }
}

function parseCandidateSecret(value: unknown): CandidateSecretPacket | null {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["handoffToken", "operationId", "schemaVersion"])
  ) return null;
  const candidate = value as Partial<CandidateSecretPacket>;
  return candidate.schemaVersion === 1
    && typeof candidate.operationId === "string"
    && UUID_PATTERN.test(candidate.operationId)
    && typeof candidate.handoffToken === "string"
    && TOKEN_PATTERN.test(candidate.handoffToken)
    ? candidate as CandidateSecretPacket
    : null;
}

function parseCandidateAck(value: unknown): CandidateAckPacket | null {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["checksum", "operationId", "revision", "schemaVersion"])
  ) return null;
  const candidate = value as Partial<CandidateAckPacket>;
  return candidate.schemaVersion === 1
    && typeof candidate.operationId === "string"
    && UUID_PATTERN.test(candidate.operationId)
    && typeof candidate.revision === "number"
    && Number.isSafeInteger(candidate.revision)
    && candidate.revision > 0
    && typeof candidate.checksum === "string"
    && DIGEST_PATTERN.test(candidate.checksum)
    ? candidate as CandidateAckPacket
    : null;
}

function boundedJsonFromStream(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      if (error) reject(error);
      else {
        try {
          resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
        } catch {
          reject(new Error("The app update bootstrap packet is invalid."));
        }
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_PACKET_BYTES) {
        finish(new Error("The app update bootstrap packet is oversized."));
        return;
      }
      chunks.push(value);
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(
      new Error("The app update bootstrap channel failed."),
    );
    const timeout = setTimeout(() => finish(
      new Error("The app update bootstrap acknowledgement timed out."),
    ), timeoutMs);
    timeout.unref?.();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function candidateRequest(
  environment: NodeJS.ProcessEnv,
): AppUpdateCandidateBootstrapRequest | null {
  if (environment[APP_UPDATE_CANDIDATE_ENV.mode] !== CANDIDATE_MODE) return null;
  const operationId = environment[APP_UPDATE_CANDIDATE_ENV.operationId];
  const handoffDirectory = environment[APP_UPDATE_CANDIDATE_ENV.handoffDirectory];
  const profileDirectory = environment[APP_UPDATE_CANDIDATE_ENV.profileDirectory];
  const dataDirectory = environment[APP_UPDATE_CANDIDATE_ENV.dataDirectory];
  if (
    typeof operationId !== "string"
    || !UUID_PATTERN.test(operationId)
    || !boundedAbsolutePath(handoffDirectory)
    || !boundedAbsolutePath(profileDirectory)
    || !boundedAbsolutePath(dataDirectory)
  ) throw new Error("The app update candidate environment is invalid.");
  return Object.freeze({
    operationId,
    handoffDirectory,
    profileDirectory,
    dataDirectory,
  });
}

export function appUpdateCandidateBootstrapRequest(
  environment: NodeJS.ProcessEnv,
): AppUpdateCandidateBootstrapRequest | null {
  return candidateRequest(environment);
}

function waitForLifetimeEnd(deadlineAt: string): Promise<void> {
  const remaining = Math.min(
    MAX_BOOTSTRAP_WAIT_MS,
    Math.max(1, Date.parse(deadlineAt) - Date.now()),
  );
  const lifetime = createReadStream("", { fd: 3, autoClose: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lifetime.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(
      new Error("The prior application did not transfer update ownership."),
    ), remaining);
    timeout.unref?.();
    lifetime.once("end", () => finish());
    lifetime.once("error", () => finish(
      new Error("The app update lifetime channel failed."),
    ));
    lifetime.resume();
  });
}

export async function runRestrictedAppUpdateCandidate(options: {
  readonly request: AppUpdateCandidateBootstrapRequest;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly channel: AppUpdateHandoffChannel;
  readonly version: string;
  readonly stdin?: NodeJS.ReadableStream;
  readonly writeAcknowledgement?: (packet: string) => Promise<void>;
  readonly waitForTransfer?: (deadlineAt: string) => Promise<void>;
  readonly validateBootstrap: (operationId: string) => Promise<void>;
}): Promise<AppUpdateLinuxCandidateAdmission> {
  const secretValue = await boundedJsonFromStream(
    options.stdin ?? process.stdin,
    10_000,
  );
  const secret = parseCandidateSecret(secretValue);
  if (!secret || secret.operationId !== options.request.operationId) {
    throw new Error("The app update candidate secret is invalid.");
  }
  const journal = new AppUpdateHandoffJournal(options.request.handoffDirectory);
  const launched = journal.current();
  if (
    !launched
    || launched.operationId !== options.request.operationId
    || launched.phase !== "candidate-launched"
    || launched.platform !== options.platform
    || launched.channel !== options.channel
    || launched.newVersion !== options.version
    || launched.profileIdentityDigest !== appUpdateDirectoryIdentityDigest(
      options.request.profileDirectory,
      "profile",
    )
    || launched.dataIdentityDigest !== appUpdateDirectoryIdentityDigest(
      options.request.dataDirectory,
      "data",
    )
  ) throw new Error("The app update candidate lineage is invalid.");
  const candidatePath = options.environment.APPIMAGE;
  if (!candidatePath) {
    throw new Error("The staged AppImage candidate path is unavailable.");
  }
  const staged = await validateStagedAppImageUpdate({
    channel: options.channel,
    operationId: launched.operationId,
    candidatePath,
    artifactDigest: launched.candidateArtifactDigest,
    executableIdentityDigest: launched.candidateExecutableIdentityDigest,
  });
  if (!appUpdateHandoffTokenMatches(launched, secret.handoffToken)) {
    throw new Error("The app update candidate acknowledgement was rejected.");
  }
  await options.validateBootstrap(launched.operationId);
  const acknowledged = journal.acknowledgeCandidateBootstrap(
    appUpdateHandoffOwner(launched),
    {
      operationId: launched.operationId,
      platform: launched.platform,
      channel: launched.channel,
      oldVersion: launched.oldVersion,
      newVersion: launched.newVersion,
      oldRuntimeGenerationId: launched.oldRuntimeGenerationId,
      candidateArtifactDigest: launched.candidateArtifactDigest,
      candidateExecutableIdentityDigest:
        launched.candidateExecutableIdentityDigest,
      profileIdentityDigest: launched.profileIdentityDigest,
      dataIdentityDigest: launched.dataIdentityDigest,
      handoffToken: secret.handoffToken,
    },
  );
  if (!acknowledged) {
    throw new Error("The app update candidate acknowledgement was rejected.");
  }
  const packet = JSON.stringify({
    schemaVersion: 1,
    operationId: acknowledged.operationId,
    revision: acknowledged.revision,
    checksum: acknowledged.checksum,
  } satisfies CandidateAckPacket);
  await (options.writeAcknowledgement
    ? options.writeAcknowledgement(packet)
    : new Promise<void>((resolve, reject) => {
        const onError = (): void => reject(
          new Error("The app update acknowledgement channel failed."),
        );
        process.stdout.once("error", onError);
        process.stdout.end(packet, () => {
          process.stdout.removeListener("error", onError);
          resolve();
        });
      }));
  await (options.waitForTransfer ?? waitForLifetimeEnd)(
    acknowledged.deadlineAt,
  );
  const committed = journal.current();
  if (
    !committed
    || committed.operationId !== acknowledged.operationId
    || committed.phase !== "ownership-transfer-committed"
  ) throw new Error("The app update ownership transfer was not committed.");
  await validateCommittedAppImageUpdate({
    channel: options.channel,
    operationId: committed.operationId,
    stablePath: staged.stablePath,
    artifactDigest: committed.candidateArtifactDigest,
    executableIdentityDigest: committed.candidateExecutableIdentityDigest,
  });
  return Object.freeze({
    platform: "linux",
    snapshot: committed,
    handoffToken: secret.handoffToken,
    stableAppImagePath: staged.stablePath,
  });
}

async function stopCandidate(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || pid <= 1) {
    throw new Error("The app update candidate process identity is unavailable.");
  }
  // The candidate is created as a detached session/process-group leader.
  // Its direct exit is not sufficient: a restricted bootstrap can fail after
  // forking a descendant that inherited the candidate's authority.
  if (exactProcessGroupTerminal(pid, "linux") === true) return;
  const terminated = await forceKillRuntimeProcessTree(pid, {
    rootProcessGroup: true,
  });
  if (
    !terminated
    && exactProcessGroupTerminal(pid, "linux") !== true
  ) {
    throw new Error(
      "The app update candidate process-tree cleanup could not be confirmed.",
    );
  }
}

export async function launchRestrictedAppUpdateCandidate(options: {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly operationId: string;
  readonly handoffToken: string;
  readonly handoffDirectory: string;
  readonly profileDirectory: string;
  readonly dataDirectory: string;
  readonly journal: AppUpdateHandoffJournal;
  readonly timeoutMs?: number;
}): Promise<AppUpdateCandidateProcess> {
  const child = spawn(options.executablePath, [], {
    detached: true,
    shell: false,
    env: {
      ...options.environment,
      APPIMAGE: options.executablePath,
      APPIMAGE_SILENT_INSTALL: "true",
      APPIMAGE_EXIT_AFTER_INSTALL: undefined,
      [APP_UPDATE_CANDIDATE_ENV.mode]: CANDIDATE_MODE,
      [APP_UPDATE_CANDIDATE_ENV.operationId]: options.operationId,
      [APP_UPDATE_CANDIDATE_ENV.handoffDirectory]: options.handoffDirectory,
      [APP_UPDATE_CANDIDATE_ENV.profileDirectory]: options.profileDirectory,
      [APP_UPDATE_CANDIDATE_ENV.dataDirectory]: options.dataDirectory,
    },
    stdio: ["pipe", "pipe", "ignore", "pipe"],
  });
  let cleanup: Promise<void> | null = null;
  const abort = (): Promise<void> => {
    cleanup ??= stopCandidate(child);
    return cleanup;
  };
  const input = child.stdin;
  const output = child.stdout;
  const lifetime = child.stdio[3];
  if (!input || !output || !lifetime || child.pid === undefined) {
    await abort();
    throw new Error("The app update candidate channels are unavailable.");
  }
  const secret = JSON.stringify({
    schemaVersion: 1,
    operationId: options.operationId,
    handoffToken: options.handoffToken,
  } satisfies CandidateSecretPacket);
  input.end(secret);
  try {
    const ackValue = await boundedJsonFromStream(
      output,
      Math.min(MAX_BOOTSTRAP_WAIT_MS, Math.max(1, options.timeoutMs ?? 15_000)),
    );
    const ack = parseCandidateAck(ackValue);
    const snapshot = options.journal.current();
    if (
      !ack
      || !snapshot
      || ack.operationId !== options.operationId
      || snapshot.operationId !== options.operationId
      || snapshot.phase !== "candidate-bootstrap-validated"
      || ack.revision !== snapshot.revision
      || ack.checksum !== snapshot.checksum
      || child.exitCode !== null
      || child.signalCode !== null
    ) throw new Error("The app update candidate acknowledgement is invalid.");
    input.destroy();
    output.destroy();
    child.unref();
    (lifetime as { unref?: () => void }).unref?.();
    return Object.freeze({
      pid: child.pid,
      acknowledgement: snapshot,
      alive: () => child.exitCode === null && child.signalCode === null,
      abort,
    });
  } catch (error) {
    await abort();
    throw error;
  }
}

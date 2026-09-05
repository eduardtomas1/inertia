import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  opendirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, normalize } from "node:path";

import Database from "better-sqlite3";

import {
  directRuntimeJournalRootIsEmpty,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
} from "../node/direct-runtime-journal.js";
import {
  parseRuntimeGenerationLeaseLeaf,
  type RuntimeGenerationLease,
} from
  "../node/runtime-generation-leases.js";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "../node/runtime-identity-protocol.js";
import { parseModernDarwinRecoveryAuthorityLeaf } from
  "../node/runtime-modern-recovery-authorities.js";
import {
  parseRuntimeOwnedProcessContainmentLeaf,
  parseRuntimeOwnedProcessRecordLeaf,
  type RuntimeOwnedProcessRecord,
} from "../node/runtime-owned-process-journal.js";
import {
  parseRuntimeOwnedProcessSessionLeaf,
  RuntimeOwnedProcessSessionJournal,
  runtimeOwnedProcessRetiringWriterName,
  runtimeOwnedProcessWriterName,
  type RuntimeOwnedProcessSession,
  type StoredRuntimeOwnedProcessSessionLeaf,
} from
  "../node/runtime-owned-process-session-journal.js";
import {
  appUpdateCandidateViabilityResult,
  parseAppUpdateCandidateViabilityRequest,
  parseAppUpdateCandidateViabilityResultAck,
  type AppUpdateCandidateViabilityCode,
  type AppUpdateCandidateViabilityRequest,
} from "../node/app-update-candidate-viability-protocol.js";
import { migrateRuntimeDatabase, runtimeMigrationCatalog } from
  "./persistence/migrations/runtime-catalog.js";
import { validateProviderMaintenanceJournalStorage } from
  "./provider/maintenance-journal.js";

const MAX_RECOVERY_JOURNALS = 1_024;
const MAX_RECOVERY_JOURNAL_BYTES = 2 * 1_024 * 1_024;
const MAX_DATABASE_CLONE_BYTES = 256 * 1_024 * 1_024;
const DATABASE_NAME = "inertia.sqlite";
const RESULT_ACK_TIMEOUT_MS = 2_000;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class CandidateViabilityError extends Error {
  constructor(readonly code: AppUpdateCandidateViabilityCode) {
    super(code);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameFile(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

function ownedRegularFile(path: string): Stats {
  const metadata = lstatSync(path);
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (uid !== null && metadata.uid !== uid)
  ) throw new CandidateViabilityError("database-incompatible");
  return metadata;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function parsedObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCleanupReceipt(bytes: Buffer, expectedHash: string): boolean {
  const receipt = parsedObject(bytes);
  return !!receipt
    && exactKeys(receipt, ["confirmedAt", "runtimeGenerationId", "version"])
    && receipt.version === 1
    && validRuntimeGenerationId(receipt.runtimeGenerationId)
    && validTimestamp(receipt.confirmedAt)
    && generationHash(receipt.runtimeGenerationId) === expectedHash;
}

function validLegacyRecoveryAuthority(
  bytes: Buffer,
  expectedHash: string,
): boolean {
  const authority = parsedObject(bytes);
  const runtimeGenerationIds = authority?.runtimeGenerationIds;
  if (
    !authority
    || !exactKeys(authority, [
      "operationId",
      "platform",
      "runtimeGenerationId",
      "runtimeGenerationIds",
      "snapshotDigest",
      "systemBootId",
      "version",
    ])
    || authority.version !== 2
    || !validRuntimeGenerationId(authority.runtimeGenerationId)
    || !Array.isArray(runtimeGenerationIds)
    || runtimeGenerationIds.length < 1
    || runtimeGenerationIds.length > 32
    || runtimeGenerationIds.some((runtimeGenerationId) =>
      !validRuntimeGenerationId(runtimeGenerationId))
    || new Set(runtimeGenerationIds).size !== runtimeGenerationIds.length
    || !runtimeGenerationIds.includes(authority.runtimeGenerationId)
    || [...runtimeGenerationIds]
      .sort((left, right) => left.localeCompare(right))
      .some((runtimeGenerationId, index) => (
        runtimeGenerationId !== runtimeGenerationIds[index]
      ))
    || (
      authority.platform !== "darwin"
      && authority.platform !== "linux"
      && authority.platform !== "win32"
    )
    || !validSystemBootId(authority.systemBootId)
    || typeof authority.operationId !== "string"
    || !UUID_PATTERN.test(authority.operationId)
    || typeof authority.snapshotDigest !== "string"
    || !SHA256_PATTERN.test(authority.snapshotDigest)
    || generationHash(authority.runtimeGenerationId) !== expectedHash
  ) return false;
  return createHash("sha256").update(JSON.stringify({
    operationId: authority.operationId,
    platform: authority.platform,
    systemBootId: authority.systemBootId,
    runtimeGenerationIds,
  })).digest("hex") === authority.snapshotDigest;
}

type ValidatedRuntimeRecoveryJournal =
  | { readonly kind: "lease"; readonly value: RuntimeGenerationLease }
  | { readonly kind: "session"; readonly value: RuntimeOwnedProcessSession }
  | { readonly kind: "record"; readonly value: RuntimeOwnedProcessRecord }
  | {
    readonly kind: "containment";
    readonly value: {
      readonly runtimeGenerationId: string;
      readonly systemBootId: string;
    };
  }
  | { readonly kind: "other" };

function validateRuntimeRecoveryJournal(
  name: string,
  bytes: Buffer,
): ValidatedRuntimeRecoveryJournal {
  let match = name.match(
    /^\.runtime-generation-lease-([0-9a-f]{64})\.json$/u,
  );
  if (match) {
    const lease = parseRuntimeGenerationLeaseLeaf(bytes, match[1]!);
    if (!lease) {
      throw new Error("A runtime generation lease is invalid.");
    }
    return { kind: "lease", value: lease };
  }
  match = name.match(/^\.runtime-cleanup-receipt-([0-9a-f]{64})\.json$/u);
  if (match) {
    if (!validCleanupReceipt(bytes, match[1]!)) {
      throw new Error("A runtime cleanup receipt is invalid.");
    }
    return { kind: "other" };
  }
  match = name.match(
    /^\.runtime-legacy-recovery-authority-([0-9a-f]{64})\.json$/u,
  );
  if (match) {
    if (!validLegacyRecoveryAuthority(bytes, match[1]!)) {
      throw new Error("A legacy runtime recovery authority is invalid.");
    }
    return { kind: "other" };
  }
  if (name === ".runtime-modern-darwin-recovery-authority.json") {
    if (!parseModernDarwinRecoveryAuthorityLeaf(bytes)) {
      throw new Error("A modern runtime recovery authority is invalid.");
    }
    return { kind: "other" };
  }
  match = name.match(
    /^\.runtime-owned-process-session-([0-9a-f]{64})\.json$/u,
  );
  if (match) {
    const session = parseRuntimeOwnedProcessSessionLeaf(bytes, match[1]!);
    if (!session) {
      throw new Error("A runtime process ownership session is invalid.");
    }
    return { kind: "session", value: session };
  }
  match = name.match(
    /^\.runtime-owned-child-([0-9a-f-]{36})\.json$/iu,
  );
  if (match) {
    const record = parseRuntimeOwnedProcessRecordLeaf(bytes, match[1]!);
    if (!record) {
      throw new Error("A runtime owned-process record is invalid.");
    }
    return { kind: "record", value: record };
  }
  match = name.match(
    /^\.runtime-owned-process-containment-([0-9a-f]{64})\.json$/u,
  );
  if (match) {
    const containment = parseRuntimeOwnedProcessContainmentLeaf(
      bytes,
      match[1]!,
    );
    if (!containment) {
      throw new Error("A runtime process containment record is invalid.");
    }
    return { kind: "containment", value: containment };
  }
  throw new Error("Runtime recovery storage contains an incomplete or foreign entry.");
}

interface RuntimeProcessSessionTopology {
  readonly sessions: readonly StoredRuntimeOwnedProcessSessionLeaf[];
  readonly writerNames: ReadonlySet<string>;
  readonly identity: string;
}

function runtimeProcessSessionTopology(
  root: DirectRuntimeJournalRoot,
): RuntimeProcessSessionTopology {
  const sessions = new RuntimeOwnedProcessSessionJournal(root).all();
  const writerNames = new Set<string>();
  const identities = sessions.map((entry) => {
    const writerName = entry.writerRoot
      ? entry.state === "active"
        ? runtimeOwnedProcessWriterName(entry.session.runtimeGenerationId)
        : runtimeOwnedProcessRetiringWriterName(
            entry.session.runtimeGenerationId,
          )
      : null;
    if (entry.writerRoot) {
      if (!directRuntimeJournalRootIsEmpty(entry.writerRoot)) {
        throw new Error("A runtime process ownership writer is not quiescent.");
      }
      writerNames.add(writerName!);
    }
    return [
      entry.session.runtimeGenerationId,
      entry.session.systemBootId,
      entry.state,
      String(entry.identity.device),
      String(entry.identity.inode),
      writerName,
      entry.writerRoot ? String(entry.writerRoot.device) : null,
      entry.writerRoot ? String(entry.writerRoot.inode) : null,
    ];
  }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return {
    sessions,
    writerNames,
    identity: JSON.stringify(identities),
  };
}

function validateRuntimeProcessRelationships(
  topology: RuntimeProcessSessionTopology,
  journals: readonly ValidatedRuntimeRecoveryJournal[],
  expectedActiveRuntimeOwner:
    AppUpdateCandidateViabilityRequest["expectedActiveRuntimeOwner"],
): void {
  const sessions = new Map(topology.sessions.map(({ session }) => [
    session.runtimeGenerationId,
    session,
  ]));
  const leases = new Map<string, RuntimeGenerationLease>();
  const parsedSessions = new Set<string>();
  for (const journal of journals) {
    if (journal.kind === "lease") {
      if (leases.has(journal.value.runtimeGenerationId)) {
        throw new Error("A runtime generation lease is duplicated.");
      }
      leases.set(journal.value.runtimeGenerationId, journal.value);
      continue;
    }
    if (journal.kind === "session") {
      const session = sessions.get(journal.value.runtimeGenerationId);
      if (
        !session
        || session.systemBootId !== journal.value.systemBootId
      ) throw new Error("A runtime process ownership session changed.");
      if (parsedSessions.has(journal.value.runtimeGenerationId)) {
        throw new Error("A runtime process ownership session is duplicated.");
      }
      parsedSessions.add(journal.value.runtimeGenerationId);
      continue;
    }
    if (journal.kind === "record" || journal.kind === "containment") {
      const session = sessions.get(journal.value.runtimeGenerationId);
      if (
        !session
        || session.systemBootId !== journal.value.systemBootId
      ) throw new Error("Runtime process ownership is not session-bound.");
    }
  }
  if (
    parsedSessions.size !== sessions.size
    || [...sessions.keys()].some((runtimeGenerationId) => (
      !parsedSessions.has(runtimeGenerationId)
    ))
  ) throw new Error("A runtime process ownership session disappeared.");
  const activeSessions = topology.sessions.filter(({ state }) => (
    state === "active"
  ));
  if (activeSessions.length > 1) {
    throw new Error("More than one runtime process ownership session is active.");
  }
  if (
    expectedActiveRuntimeOwner === null
      ? activeSessions.length !== 0
      : activeSessions.length !== 1
        || activeSessions[0]!.session.runtimeGenerationId
          !== expectedActiveRuntimeOwner.runtimeGenerationId
        || activeSessions[0]!.session.systemBootId
          !== expectedActiveRuntimeOwner.systemBootId
  ) throw new Error("The active runtime ownership session is unexpected.");
  for (const { session } of activeSessions) {
    const lease = leases.get(session.runtimeGenerationId);
    if (!lease || lease.systemBootId !== session.systemBootId) {
      throw new Error("The active runtime ownership session is not leased.");
    }
  }
}

function inspectRecoveryStorage(
  dataDirectory: string,
  expectedActiveRuntimeOwner:
    AppUpdateCandidateViabilityRequest["expectedActiveRuntimeOwner"],
): void {
  try {
    const root = pinDirectRuntimeJournalRoot(dataDirectory);
    const topology = runtimeProcessSessionTopology(root);
    const names = listDirectRuntimeJournalLeaves(
      root,
      ".runtime-",
      MAX_RECOVERY_JOURNALS,
    );
    const journals: ValidatedRuntimeRecoveryJournal[] = [];
    for (const name of names) {
      if (topology.writerNames.has(name)) continue;
      const leaf = readDirectRuntimeJournalLeaf(
        root,
        name,
        MAX_RECOVERY_JOURNAL_BYTES,
      );
      if (!leaf) throw new Error("A recovery journal disappeared.");
      journals.push(validateRuntimeRecoveryJournal(name, leaf.bytes));
    }
    validateRuntimeProcessRelationships(
      topology,
      journals,
      expectedActiveRuntimeOwner,
    );
    const confirmedTopology = runtimeProcessSessionTopology(root);
    if (confirmedTopology.identity !== topology.identity) {
      throw new Error("Runtime process ownership changed during validation.");
    }
    validateProviderMaintenanceJournalStorage(dataDirectory);
  } catch {
    throw new CandidateViabilityError("recovery-storage-invalid");
  }
}

function directoryHasEntries(path: string): boolean {
  if (!existsSync(path)) return false;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new CandidateViabilityError("database-incompatible");
  }
  const directory = opendirSync(path);
  try {
    return directory.readSync() !== null;
  } finally {
    directory.closeSync();
  }
}

function databaseIntegrityIsValid(database: Database.Database): boolean {
  const quickCheck = database.pragma("quick_check") as Array<
    Record<string, unknown>
  >;
  return quickCheck.length === 1
    && Object.values(quickCheck[0] ?? {})[0] === "ok";
}

function migrationVersionsAreKnown(database: Database.Database): boolean {
  const catalog = runtimeMigrationCatalog();
  const known = new Set(catalog.map(({ version }) => version));
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  const applicationTables = database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).get() as { readonly count: number };
  if (!table) return applicationTables.count === 0;
  const versions = database.prepare(
    "SELECT version FROM schema_migrations ORDER BY version ASC",
  ).all() as Array<{ readonly version: unknown }>;
  return versions.every(({ version }, index) => (
    typeof version === "number"
    && Number.isSafeInteger(version)
    && version === index + 1
    && known.has(version)
  ));
}

function safeIntegerPragma(
  database: Database.Database,
  name: "page_count" | "page_size",
  minimum: 0 | 1,
): number {
  const value = database.pragma(name, { simple: true });
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) throw new CandidateViabilityError("database-incompatible");
  return value;
}

function constrainCloneSize(clone: Database.Database): void {
  const pageSize = safeIntegerPragma(clone, "page_size", 1);
  const maximumPages = Math.floor(MAX_DATABASE_CLONE_BYTES / pageSize);
  const appliedMaximum = clone.pragma(
    `max_page_count = ${maximumPages}`,
    { simple: true },
  );
  if (appliedMaximum !== maximumPages) {
    throw new CandidateViabilityError("database-incompatible");
  }
}

/**
 * Serializes the read-only live snapshot into a bounded, process-local clone.
 * This includes committed WAL pages but cannot strand profile data in a temp
 * file if the validation worker is killed. BetterSqlite3 copies the supplied
 * buffer; the source copy is erased immediately and the native copy is freed
 * when the returned database closes.
 */
function isolatedDatabaseClone(database: Database.Database): Database.Database {
  const pageSize = safeIntegerPragma(database, "page_size", 1);
  const pageCount = safeIntegerPragma(database, "page_count", 0);
  const expectedBytes = pageSize * pageCount;
  if (
    !Number.isSafeInteger(expectedBytes)
    || expectedBytes > MAX_DATABASE_CLONE_BYTES
  ) throw new CandidateViabilityError("database-incompatible");
  if (expectedBytes === 0) {
    const clone = new Database(":memory:");
    try {
      constrainCloneSize(clone);
      return clone;
    } catch (error) {
      clone.close();
      if (error instanceof CandidateViabilityError) throw error;
      throw new CandidateViabilityError("database-incompatible");
    }
  }
  const serialized = database.serialize();
  let clone: Database.Database | null = null;
  try {
    if (
      serialized.byteLength !== expectedBytes
      || serialized.byteLength < 100
      || !serialized.subarray(0, SQLITE_HEADER.byteLength).equals(SQLITE_HEADER)
    ) throw new CandidateViabilityError("database-incompatible");
    // sqlite3_deserialize cannot operate a WAL-format image. Serialization
    // already folded the connection's coherent WAL snapshot into this image;
    // mark only the private copy as rollback-format before deserializing it.
    serialized[18] = 1;
    serialized[19] = 1;
    clone = new Database(serialized);
    constrainCloneSize(clone);
    return clone;
  } catch (error) {
    clone?.close();
    if (error instanceof CandidateViabilityError) throw error;
    throw new CandidateViabilityError("database-incompatible");
  } finally {
    serialized.fill(0);
  }
}

function validateMigrationsOnClone(clone: Database.Database): void {
  try {
    clone.pragma("foreign_keys = ON");
    migrateRuntimeDatabase(clone);
    if (
      !databaseIntegrityIsValid(clone)
      || (clone.pragma("foreign_key_check") as unknown[]).length > 0
    ) throw new Error("The migrated database clone is invalid.");
  } catch {
    throw new CandidateViabilityError("database-incompatible");
  } finally {
    clone.close();
  }
}

function validateDatabase(dataDirectory: string): void {
  const databasePath = join(dataDirectory, DATABASE_NAME);
  if (!existsSync(databasePath)) {
    if (
      existsSync(`${databasePath}-wal`)
      || existsSync(`${databasePath}-shm`)
      || existsSync(`${databasePath}.restore.partial`)
      || directoryHasEntries(join(dataDirectory, "backups"))
    ) throw new CandidateViabilityError("database-incompatible");
    validateMigrationsOnClone(new Database(":memory:"));
    return;
  }
  const named = ownedRegularFile(databasePath);
  const actualPath = realpathSync(databasePath);
  if (!samePath(actualPath, databasePath)) {
    throw new CandidateViabilityError("database-incompatible");
  }
  const actual = ownedRegularFile(actualPath);
  if (!sameFile(named, actual)) {
    throw new CandidateViabilityError("database-incompatible");
  }
  const database = new Database(actualPath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    database.pragma("query_only = ON");
    database.pragma("busy_timeout = 5000");
    database.exec("BEGIN");
    if (
      !databaseIntegrityIsValid(database)
      || !migrationVersionsAreKnown(database)
      || (database.pragma("foreign_key_check") as unknown[]).length > 0
    ) throw new CandidateViabilityError("database-incompatible");
    validateMigrationsOnClone(isolatedDatabaseClone(database));
    const confirmed = ownedRegularFile(databasePath);
    if (!sameFile(named, confirmed)) {
      throw new CandidateViabilityError("database-incompatible");
    }
  } catch (error) {
    if (error instanceof CandidateViabilityError) throw error;
    throw new CandidateViabilityError("database-incompatible");
  } finally {
    database.close();
  }
}

export function validateAppUpdateCandidateViability(
  request: AppUpdateCandidateViabilityRequest,
): void {
  inspectRecoveryStorage(
    request.dataDirectory,
    request.expectedActiveRuntimeOwner,
  );
  validateDatabase(request.dataDirectory);
}

function safeFailureCode(error: unknown): AppUpdateCandidateViabilityCode {
  return error instanceof CandidateViabilityError
    ? error.code
    : "validation-failed";
}

const parentPort = process.parentPort;
if (parentPort) {
  let pending: {
    readonly operationId: string;
    readonly exitCode: number;
    readonly timeout: NodeJS.Timeout;
  } | null = null;
  const publish = (
    operationId: string,
    status: "validated" | "rejected",
    code?: AppUpdateCandidateViabilityCode,
  ): void => {
    parentPort.postMessage(appUpdateCandidateViabilityResult({
      operationId,
      status,
      ...(code ? { code } : {}),
    }));
    const timeout = setTimeout(() => process.exit(1), RESULT_ACK_TIMEOUT_MS);
    timeout.unref();
    pending = {
      operationId,
      exitCode: status === "validated" ? 0 : 1,
      timeout,
    };
  };
  parentPort.on("message", (value: unknown) => {
    if (pending) {
      const acknowledgement = parseAppUpdateCandidateViabilityResultAck(value);
      if (
        !acknowledgement
        || acknowledgement.operationId !== pending.operationId
      ) process.exit(1);
      clearTimeout(pending.timeout);
      process.exit(pending.exitCode);
    }
    const request = parseAppUpdateCandidateViabilityRequest(value);
    if (!request) {
      publish(
        "00000000-0000-4000-8000-000000000000",
        "rejected",
        "invalid-request",
      );
      return;
    }
    try {
      validateAppUpdateCandidateViability(request);
      publish(request.operationId, "validated");
    } catch (error) {
      publish(request.operationId, "rejected", safeFailureCode(error));
    }
  });
}

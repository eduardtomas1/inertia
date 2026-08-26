import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  discardDirectRuntimeJournalLeaf,
  directRuntimeJournalRootIsPinned,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  renameDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
  type DirectRuntimeJournalTestHooks,
} from "./direct-runtime-journal.js";
import {
  RuntimeGenerationLeaseJournal,
  type RuntimeGenerationLease,
} from "./runtime-generation-leases.js";
import { RuntimeOwnedProcessJournal } from "./runtime-owned-processes.js";
import {
  readDarwinProcessIdentity,
  type DarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "./runtime-process-protocol.js";

const AUTHORITY_SCHEMA_VERSION = 1;
const AUTHORITY_PREFIX = ".runtime-modern-darwin-recovery-authority";
const CANONICAL_NAME = `${AUTHORITY_PREFIX}.json`;
const PUBLISH_NAME = `${AUTHORITY_PREFIX}.publish.tmp`;
const RETIRE_NAME = `${AUTHORITY_PREFIX}.retire.tmp`;
const CANCEL_NAME = `${AUTHORITY_PREFIX}.cancel.tmp`;
const MAX_AUTHORITY_BYTES = 256 * 1024;
const MAX_GENERATIONS = 32;
const MAX_RECORDS = 256;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ModernDarwinRecoveryGenerationSnapshot {
  readonly lease: RuntimeGenerationLease;
  readonly containment: null;
  readonly records: readonly Readonly<Record<string, unknown>>[];
}

export interface ModernDarwinRecoverySnapshot {
  readonly platform: "darwin";
  // The boot identity observed by the recovering Inertia launch. Every
  // generation below retains its separately recorded boot identity so a
  // temporarily unavailable probe cannot rewrite or reinterpret old state.
  readonly systemBootId: string;
  readonly generations: readonly ModernDarwinRecoveryGenerationSnapshot[];
}

export interface ModernDarwinRecoveryAuthority {
  readonly operationId: string;
  readonly snapshotDigest: string;
  readonly snapshot: ModernDarwinRecoverySnapshot;
}

interface StoredModernDarwinRecoveryAuthority
  extends ModernDarwinRecoveryAuthority {
  readonly version: typeof AUTHORITY_SCHEMA_VERSION;
}

export interface ModernDarwinRecoveryAuthorityDescriptor {
  readonly operationId: string;
  readonly snapshotDigest: string;
  readonly runtimeGenerationIds: readonly string[];
}

export interface ModernDarwinRecoveryRootObservation {
  readonly guardianPath: string;
  readonly deadlineAt?: number;
  readonly platform?: NodeJS.Platform;
  readonly readDarwinIdentity?: (pid: number) => DarwinProcessIdentity | null;
  readonly pidExists?: (pid: number) => boolean;
}

type AuthorityState = "pending" | "retiring";

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1;
}

function validTicks(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,30}$/u.test(value);
}

function validCreatedAt(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDarwinRecord(
  value: unknown,
  runtimeGenerationId: string,
  systemBootId: string,
): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || record.runtimeGenerationId !== runtimeGenerationId
    || record.systemBootId !== systemBootId
    || typeof record.ownershipId !== "string"
    || !UUID_PATTERN.test(record.ownershipId)
  ) return false;
  if (record.state === "pending") {
    return exactKeys(record, [
      "containment",
      "ownershipId",
      "runtimeGenerationId",
      "runtimeParentPid",
      "state",
      "systemBootId",
      "version",
    ])
      && record.containment === "darwin-parent-watchdog-v1"
      && validPid(record.runtimeParentPid);
  }
  if (
    record.state !== "owned"
    || !exactKeys(record, [
      "ownershipId",
      "process",
      "runtimeGenerationId",
      "state",
      "systemBootId",
      "version",
    ])
    || !record.process
    || typeof record.process !== "object"
  ) return false;
  const process = record.process as Record<string, unknown>;
  return exactKeys(process, [
    "parentPid",
    "pid",
    "platform",
    "processGroupId",
    "sessionId",
    "startTimeMicroseconds",
    "startTimeSeconds",
  ])
    && process.platform === "darwin"
    && validPid(process.pid)
    && Number.isSafeInteger(process.parentPid)
    && Number(process.parentPid) >= 1
    && process.processGroupId === process.pid
    && process.sessionId === process.pid
    && validTicks(process.startTimeSeconds)
    && Number.isSafeInteger(process.startTimeMicroseconds)
    && Number(process.startTimeMicroseconds) >= 0
    && Number(process.startTimeMicroseconds) < 1_000_000;
}

function normalizeRecord(
  value: unknown,
  runtimeGenerationId: string,
  systemBootId: string,
): Readonly<Record<string, unknown>> | null {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
  return validDarwinRecord(cloned, runtimeGenerationId, systemBootId)
    ? cloned
    : null;
}

function parseSnapshot(value: unknown): ModernDarwinRecoverySnapshot | null {
  if (
    !value
    || typeof value !== "object"
    || !exactKeys(value, ["generations", "platform", "systemBootId"])
  ) return null;
  const candidate = value as Partial<ModernDarwinRecoverySnapshot>;
  if (
    candidate.platform !== "darwin"
    || !validSystemBootId(candidate.systemBootId)
    || !Array.isArray(candidate.generations)
    || candidate.generations.length < 1
    || candidate.generations.length > MAX_GENERATIONS
  ) return null;
  const generations: ModernDarwinRecoveryGenerationSnapshot[] = [];
  let recordCount = 0;
  for (const valueGeneration of candidate.generations) {
    if (
      !valueGeneration
      || typeof valueGeneration !== "object"
      || !exactKeys(valueGeneration, ["containment", "lease", "records"])
    ) return null;
    const generation = valueGeneration as Partial<ModernDarwinRecoveryGenerationSnapshot>;
    if (
      generation.containment !== null
      || !generation.lease
      || typeof generation.lease !== "object"
      || !exactKeys(generation.lease, [
        "createdAt",
        "runtimeGenerationId",
        "systemBootId",
      ])
      || !validRuntimeGenerationId(generation.lease.runtimeGenerationId)
      || !validSystemBootId(generation.lease.systemBootId)
      || !validCreatedAt(generation.lease.createdAt)
      || !Array.isArray(generation.records)
    ) return null;
    recordCount += generation.records.length;
    if (recordCount > MAX_RECORDS) return null;
    const records = generation.records.map((record) => normalizeRecord(
      record,
      generation.lease!.runtimeGenerationId,
      generation.lease!.systemBootId,
    ));
    if (records.some((record) => record === null)) return null;
    const sortedRecords = (records as Readonly<Record<string, unknown>>[])
      .sort((left, right) => String(left.ownershipId)
        .localeCompare(String(right.ownershipId)));
    if (new Set(sortedRecords.map((record) => record.ownershipId)).size
      !== sortedRecords.length) return null;
    generations.push({
      lease: {
        runtimeGenerationId: generation.lease.runtimeGenerationId,
        systemBootId: generation.lease.systemBootId,
        createdAt: generation.lease.createdAt,
      },
      containment: null,
      records: sortedRecords,
    });
  }
  generations.sort((left, right) => left.lease.runtimeGenerationId
    .localeCompare(right.lease.runtimeGenerationId));
  if (new Set(generations.map(({ lease }) => lease.runtimeGenerationId)).size
    !== generations.length) return null;
  return {
    platform: "darwin",
    systemBootId: candidate.systemBootId,
    generations,
  };
}

function authorityDigest(
  operationId: string,
  snapshot: ModernDarwinRecoverySnapshot,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ operationId, snapshot }))
    .digest("hex");
}

function parseAuthority(bytes: Buffer): ModernDarwinRecoveryAuthority | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !value
      || typeof value !== "object"
      || !exactKeys(value, [
        "operationId",
        "snapshot",
        "snapshotDigest",
        "version",
      ])
    ) return null;
    const candidate = value as Partial<StoredModernDarwinRecoveryAuthority>;
    const snapshot = parseSnapshot(candidate.snapshot);
    if (
      candidate.version !== AUTHORITY_SCHEMA_VERSION
      || typeof candidate.operationId !== "string"
      || !UUID_PATTERN.test(candidate.operationId)
      || typeof candidate.snapshotDigest !== "string"
      || !SHA256_PATTERN.test(candidate.snapshotDigest)
      || !snapshot
      || authorityDigest(candidate.operationId, snapshot)
        !== candidate.snapshotDigest
    ) return null;
    return {
      operationId: candidate.operationId,
      snapshotDigest: candidate.snapshotDigest,
      snapshot,
    };
  } catch {
    return null;
  }
}

function storedAuthority(authority: ModernDarwinRecoveryAuthority): Buffer {
  return Buffer.from(JSON.stringify({
    version: AUTHORITY_SCHEMA_VERSION,
    operationId: authority.operationId,
    snapshotDigest: authority.snapshotDigest,
    snapshot: authority.snapshot,
  }), "utf8");
}

function sameAuthority(
  left: ModernDarwinRecoveryAuthority,
  right: ModernDarwinRecoveryAuthority,
): boolean {
  return left.operationId === right.operationId
    && left.snapshotDigest === right.snapshotDigest;
}

function descriptor(
  authority: ModernDarwinRecoveryAuthority,
): ModernDarwinRecoveryAuthorityDescriptor {
  return {
    operationId: authority.operationId,
    snapshotDigest: authority.snapshotDigest,
    runtimeGenerationIds: authority.snapshot.generations.map(
      ({ lease }) => lease.runtimeGenerationId,
    ),
  };
}

function readAuthorityLeaf(
  root: DirectRuntimeJournalRoot,
  name: string,
  hooks?: DirectRuntimeJournalTestHooks,
): { leaf: DirectRuntimeJournalLeaf; authority: ModernDarwinRecoveryAuthority } | null {
  const leaf = readDirectRuntimeJournalLeaf(
    root,
    name,
    MAX_AUTHORITY_BYTES,
    hooks,
  );
  if (!leaf) return null;
  const authority = parseAuthority(leaf.bytes);
  if (!authority) {
    throw new Error("The modern macOS runtime recovery authority is invalid.");
  }
  return { leaf, authority };
}

function captureTargetSnapshot(
  dataDirectory: string,
  systemBootId: string,
  runtimeGenerationIds?: ReadonlySet<string>,
): ModernDarwinRecoverySnapshot | null {
  if (!validSystemBootId(systemBootId)) {
    return null;
  }
  const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
  if (!leases.isValid()) return null;
  const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
    platform: "darwin",
  });
  // A failed boot probe writes the literal unavailable marker for both new
  // sessions and v0.0.44 compatibility leases. Only a durable owned-session
  // leaf distinguishes the modern unscoped batch. Do not require its recorded
  // marker to equal the current observation: a probe may become available or
  // temporarily fail across launches without proving that the machine booted.
  const selected = leases.all().filter((lease) => (
    (!runtimeGenerationIds || runtimeGenerationIds.has(
      lease.runtimeGenerationId,
    ))
    && owned.records(lease.runtimeGenerationId) !== null
  ));
  if (
    selected.length < 1
    || selected.length > MAX_GENERATIONS
    || (runtimeGenerationIds && selected.length !== runtimeGenerationIds.size)
  ) return null;
  const generations: ModernDarwinRecoveryGenerationSnapshot[] = [];
  let recordCount = 0;
  for (const lease of selected) {
    const currentRecords = owned.records(lease.runtimeGenerationId);
    const containment = owned.containment(lease.runtimeGenerationId);
    if (currentRecords === null || containment !== null) return null;
    recordCount += currentRecords.length;
    if (recordCount > MAX_RECORDS) return null;
    const records = currentRecords.map((record) => normalizeRecord(
      record,
      lease.runtimeGenerationId,
      lease.systemBootId,
    ));
    if (records.some((record) => record === null)) return null;
    generations.push({
      lease: { ...lease },
      containment: null,
      records: (records as Readonly<Record<string, unknown>>[])
        .sort((left, right) => String(left.ownershipId)
          .localeCompare(String(right.ownershipId))),
    });
  }
  return parseSnapshot({ platform: "darwin", systemBootId, generations });
}

export function captureModernDarwinRecoverySnapshot(
  dataDirectory: string,
  systemBootId: string,
): ModernDarwinRecoverySnapshot | null {
  return captureTargetSnapshot(dataDirectory, systemBootId);
}

export function modernDarwinRecoveryJournalMatches(
  dataDirectory: string,
  authority: ModernDarwinRecoveryAuthority,
  allowedCurrentRuntimeGenerationId?: string,
): boolean {
  const targetIds = new Set(authority.snapshot.generations.map(
    ({ lease }) => lease.runtimeGenerationId,
  ));
  const current = captureTargetSnapshot(
    dataDirectory,
    authority.snapshot.systemBootId,
    targetIds,
  );
  if (!current) return false;
  const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
  if (!leases.isValid()) return false;
  const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
    platform: "darwin",
  });
  if (
    allowedCurrentRuntimeGenerationId
    && owned.records(allowedCurrentRuntimeGenerationId) === null
  ) return false;
  // Ignore only no-session v0.0.44 leases that are authorized independently.
  // Every session-backed lease is modern regardless of whether its recorded
  // boot probe and the recovering launch's observation differ. The newly
  // reserved current generation is named explicitly.
  const currentBootIds = leases.all()
    .filter(({ runtimeGenerationId }) => (
      targetIds.has(runtimeGenerationId)
      || runtimeGenerationId === allowedCurrentRuntimeGenerationId
      || owned.records(runtimeGenerationId) !== null
    ))
    .map(({ runtimeGenerationId }) => runtimeGenerationId)
    .sort();
  const expectedIds = [
    ...targetIds,
    ...(allowedCurrentRuntimeGenerationId
      ? [allowedCurrentRuntimeGenerationId]
      : []),
  ].sort();
  return currentBootIds.length === expectedIds.length
    && currentBootIds.every((generationId, index) => (
      generationId === expectedIds[index]
    ))
    && authorityDigest(authority.operationId, current)
      === authority.snapshotDigest;
}

function defaultPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error
      && "code" in error
      && error.code === "ESRCH");
  }
}

export function modernDarwinRecoverySnapshotRootsAbsent(
  snapshot: ModernDarwinRecoverySnapshot,
  observation: ModernDarwinRecoveryRootObservation,
): boolean {
  if (
    (observation.platform ?? process.platform) !== "darwin"
    || !isAbsolute(observation.guardianPath)
  ) return false;
  const deadlineAt = observation.deadlineAt ?? Date.now() + 2_000;
  const readIdentity = observation.readDarwinIdentity
    ?? ((pid: number) => readDarwinProcessIdentity(
      pid,
      observation.guardianPath,
      { platform: "darwin", deadlineAt },
    ));
  const pidExists = observation.pidExists ?? defaultPidExists;
  try {
    for (const generation of snapshot.generations) {
      for (const record of generation.records) {
        if (Date.now() >= deadlineAt) return false;
        if (record.state === "pending") {
          // Pending records predate a durable guardian identity. Any process at
          // the recorded runtime-parent PID (including a reused PID) must keep
          // recovery locked because absence cannot be proven exactly.
          if (pidExists(Number(record.runtimeParentPid))) return false;
          continue;
        }
        const expected = record.process as unknown as DarwinProcessIdentity;
        const observed = readIdentity(expected.pid);
        if (observed && JSON.stringify(observed) === JSON.stringify(expected)) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function modernDarwinRecoveryAuthorityMatches(
  dataDirectory: string,
  authority: ModernDarwinRecoveryAuthority,
  observation: ModernDarwinRecoveryRootObservation,
  allowedCurrentRuntimeGenerationId?: string,
): boolean {
  return modernDarwinRecoveryJournalMatches(
    dataDirectory,
    authority,
    allowedCurrentRuntimeGenerationId,
  ) && modernDarwinRecoverySnapshotRootsAbsent(
    authority.snapshot,
    observation,
  );
}

export function modernDarwinRecoveryDescriptorMatches(
  descriptorValue: ModernDarwinRecoveryAuthorityDescriptor,
  authority: ModernDarwinRecoveryAuthority,
): boolean {
  return descriptorValue.operationId === authority.operationId
    && descriptorValue.snapshotDigest === authority.snapshotDigest
    && descriptorValue.runtimeGenerationIds.length
      === authority.snapshot.generations.length
    && descriptorValue.runtimeGenerationIds.every((generationId, index) => (
      generationId
        === authority.snapshot.generations[index]?.lease.runtimeGenerationId
    ));
}

function clearRetiringSnapshot(
  dataDirectory: string,
  authority: ModernDarwinRecoveryAuthority,
): boolean {
  const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
  const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
    platform: "darwin",
  });
  if (!leases.isValid()) return false;
  for (const generation of authority.snapshot.generations) {
    leases.refresh();
    if (!leases.isValid()) return false;
    const currentLease = leases.all().find(({ runtimeGenerationId }) => (
      runtimeGenerationId === generation.lease.runtimeGenerationId
    ));
    const currentRecords = owned.records(generation.lease.runtimeGenerationId);
    if (!currentLease) {
      if (currentRecords !== null) return false;
      continue;
    }
    if (JSON.stringify(currentLease) !== JSON.stringify(generation.lease)) {
      return false;
    }
    // Retirement is deliberately ordered records -> session -> lease. A crash
    // after finishSession() can therefore leave the exact lease behind with no
    // session leaf. The durable retire authority proves that the database
    // transition was already acknowledged, so this one exact partial state is
    // safe to resume by clearing only the snapshot-bound lease.
    if (!currentRecords) {
      if (!leases.clearRuntimeGeneration(generation.lease.runtimeGenerationId)) {
        return false;
      }
      continue;
    }
    const expectedRecords = new Map(generation.records.map((record) => [
      String(record.ownershipId),
      JSON.stringify(record),
    ]));
    const normalized = currentRecords.map((record) => normalizeRecord(
      record,
      generation.lease.runtimeGenerationId,
      generation.lease.systemBootId,
    ));
    if (normalized.some((record) => record === null)) return false;
    for (const record of normalized as Readonly<Record<string, unknown>>[]) {
      if (expectedRecords.get(String(record.ownershipId))
        !== JSON.stringify(record)) return false;
    }
    for (const record of normalized as Readonly<Record<string, unknown>>[]) {
      if (!owned.release(String(record.ownershipId))) return false;
    }
    if (
      !owned.finishSession(generation.lease.runtimeGenerationId)
      || !leases.clearRuntimeGeneration(generation.lease.runtimeGenerationId)
    ) return false;
  }
  return authority.snapshot.generations.every(({ lease }) => {
    leases.refresh();
    return leases.isValid()
      && !leases.all().some(({ runtimeGenerationId }) => (
        runtimeGenerationId === lease.runtimeGenerationId
      ))
      && owned.records(lease.runtimeGenerationId) === null;
  });
}

export class ModernDarwinRecoveryAuthorityJournal {
  private readonly root: DirectRuntimeJournalRoot;

  constructor(
    dataDirectory: string,
    private readonly testHooks?: DirectRuntimeJournalTestHooks,
  ) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
    this.repairPublication();
    this.finishCancellation();
    this.assertSingleAuthority();
  }

  private repairPublication(): void {
    let published: ReturnType<typeof readAuthorityLeaf>;
    try {
      published = readAuthorityLeaf(this.root, PUBLISH_NAME, this.testHooks);
    } catch (error) {
      // A publish leaf is not authority yet. Discard only this exact transient
      // so the user can be prompted again; malformed canonical/retire leaves
      // remain fail-closed and are never deleted automatically.
      if (discardDirectRuntimeJournalLeaf(
        this.root,
        PUBLISH_NAME,
        this.testHooks,
      )) return;
      throw error;
    }
    if (!published) return;
    const canonical = readAuthorityLeaf(
      this.root,
      CANONICAL_NAME,
      this.testHooks,
    );
    if (canonical) {
      if (!sameAuthority(published.authority, canonical.authority)
        || !unlinkDirectRuntimeJournalLeaf(
          this.root,
          PUBLISH_NAME,
          published.leaf.identity,
          this.testHooks,
        )) throw new Error("The modern macOS recovery publication conflicts.");
      return;
    }
    if (!renameDirectRuntimeJournalLeaf(
      this.root,
      PUBLISH_NAME,
      CANONICAL_NAME,
      published.leaf.identity,
      this.testHooks,
    )) throw new Error("The modern macOS recovery publication is incomplete.");
  }

  private finishCancellation(): void {
    const cancelled = readAuthorityLeaf(this.root, CANCEL_NAME, this.testHooks);
    if (!cancelled) return;
    if (!unlinkDirectRuntimeJournalLeaf(
      this.root,
      CANCEL_NAME,
      cancelled.leaf.identity,
      this.testHooks,
    )) throw new Error("The modern macOS recovery cancellation is incomplete.");
  }

  private assertSingleAuthority(): void {
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      AUTHORITY_PREFIX,
      4,
    );
    if (names.some((name) => ![
      CANONICAL_NAME,
      RETIRE_NAME,
    ].includes(name))) {
      throw new Error("Modern macOS recovery authority storage is invalid.");
    }
    if (names.includes(CANONICAL_NAME) && names.includes(RETIRE_NAME)) {
      throw new Error("Modern macOS recovery authority storage conflicts.");
    }
  }

  private stored(
    state: AuthorityState,
  ): { leaf: DirectRuntimeJournalLeaf; authority: ModernDarwinRecoveryAuthority } | null {
    return readAuthorityLeaf(
      this.root,
      state === "pending" ? CANONICAL_NAME : RETIRE_NAME,
      this.testHooks,
    );
  }

  pending(): ModernDarwinRecoveryAuthority | null {
    return this.stored("pending")?.authority ?? null;
  }

  retiring(): ModernDarwinRecoveryAuthority | null {
    return this.stored("retiring")?.authority ?? null;
  }

  publish(
    snapshotValue: ModernDarwinRecoverySnapshot,
    operationId: string = randomUUID(),
  ): ModernDarwinRecoveryAuthorityDescriptor | null {
    if (
      !directRuntimeJournalRootIsPinned(this.root)
      || !UUID_PATTERN.test(operationId)
      || this.retiring()
    ) return null;
    const snapshot = parseSnapshot(snapshotValue);
    if (!snapshot) return null;
    const authority: ModernDarwinRecoveryAuthority = {
      operationId,
      snapshotDigest: authorityDigest(operationId, snapshot),
      snapshot,
    };
    const existing = this.pending();
    if (existing) return sameAuthority(existing, authority)
      ? descriptor(existing)
      : null;
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      PUBLISH_NAME,
      CANONICAL_NAME,
      storedAuthority(authority),
      this.testHooks,
    )) return null;
    const persisted = this.pending();
    return persisted && sameAuthority(persisted, authority)
      ? descriptor(persisted)
      : null;
  }

  cancelPending(authority: ModernDarwinRecoveryAuthority): boolean {
    const current = this.stored("pending");
    if (!current || !sameAuthority(current.authority, authority)) return false;
    return renameDirectRuntimeJournalLeaf(
      this.root,
      CANONICAL_NAME,
      CANCEL_NAME,
      current.leaf.identity,
      this.testHooks,
    ) && this.finishCancellationSafely();
  }

  private finishCancellationSafely(): boolean {
    try {
      this.finishCancellation();
      return true;
    } catch {
      return false;
    }
  }

  beginRetirement(
    authority: ModernDarwinRecoveryAuthority,
    dataDirectory: string,
    currentRuntimeGenerationId: string,
    observation: ModernDarwinRecoveryRootObservation,
  ): boolean {
    const current = this.stored("pending");
    if (
      !current
      || !sameAuthority(current.authority, authority)
      || !modernDarwinRecoveryAuthorityMatches(
        dataDirectory,
        current.authority,
        observation,
        currentRuntimeGenerationId,
      )
    ) return false;
    return renameDirectRuntimeJournalLeaf(
      this.root,
      CANONICAL_NAME,
      RETIRE_NAME,
      current.leaf.identity,
      this.testHooks,
    );
  }

  completeRetirement(
    dataDirectory: string,
    expected?: ModernDarwinRecoveryAuthority,
  ): boolean {
    const current = this.stored("retiring");
    if (!current || (expected && !sameAuthority(current.authority, expected))) {
      return false;
    }
    if (!clearRetiringSnapshot(dataDirectory, current.authority)) return false;
    const refreshed = this.stored("retiring");
    return !!refreshed
      && sameAuthority(refreshed.authority, current.authority)
      && unlinkDirectRuntimeJournalLeaf(
        this.root,
        RETIRE_NAME,
        refreshed.leaf.identity,
        this.testHooks,
      );
  }
}

export function descriptorForModernDarwinRecoveryAuthority(
  authority: ModernDarwinRecoveryAuthority,
): ModernDarwinRecoveryAuthorityDescriptor {
  return descriptor(authority);
}

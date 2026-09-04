import { createHash } from "node:crypto";

import {
  discardDirectRuntimeJournalLeaf,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalIdentity,
  type DirectRuntimeJournalRoot,
  type DirectRuntimeJournalTestHooks,
} from "../../node/direct-runtime-journal";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "../../node/runtime-identity-protocol";
import type {
  ProviderInstallationIdentity,
} from "./installation-lease";

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_PREFIX = ".provider-maintenance-";
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_RECORDS = 32;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type ProviderMaintenanceJournalPhase = "owning" | "verified";

interface ProviderMaintenanceJournalPayload {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  phase: ProviderMaintenanceJournalPhase;
  operationId: string;
  providerId: ProviderInstallationIdentity["providerId"];
  boundaryId: string;
  scopeId: string;
  fingerprint: string;
  observedBoundaryId: string | null;
  observedScopeId: string | null;
  observedFingerprint: string | null;
  runtimeGenerationId: string;
  systemBootId: string;
  createdAt: string;
}

interface StoredProviderMaintenanceJournalRecord
  extends ProviderMaintenanceJournalPayload {
  integrity: string;
}

interface ReadProviderMaintenanceJournalRecord {
  record: StoredProviderMaintenanceJournalRecord;
  name: string;
  identity: DirectRuntimeJournalIdentity;
}

interface ReadProviderMaintenanceJournalOptions {
  readonly discardTransients: boolean;
  readonly testHooks?: DirectRuntimeJournalTestHooks;
}

export interface ProviderMaintenanceRecoveryRecord {
  operationId: string;
  installationIdentity: ProviderInstallationIdentity;
  runtimeGenerationId: string;
  systemBootId: string;
  verifiedIdentity: ProviderInstallationIdentity | null;
}

export interface ProviderMaintenanceJournalAuthority {
  begin(
    operationId: string,
    identity: ProviderInstallationIdentity,
  ): boolean;
  markVerified(
    operationId: string,
    observedIdentity: ProviderInstallationIdentity,
  ): boolean;
  retireVerified(
    operationId: string,
    observedIdentity: ProviderInstallationIdentity,
  ): boolean;
  abandonUnadmitted(
    operationId: string,
    identity: ProviderInstallationIdentity,
  ): boolean;
  pending(): readonly ProviderMaintenanceRecoveryRecord[];
}

export interface ProviderMaintenanceJournalOptions {
  runtimeGenerationId: string;
  systemBootId: string;
  testHooks?: DirectRuntimeJournalTestHooks;
}

export interface ProviderMaintenanceJournalReconciliation {
  confirmedRuntimeGenerationIds: ReadonlySet<string>;
  currentSystemBootId: string;
  priorBootCleanupConfirmed: boolean;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("\0");
}

function validProviderId(
  value: unknown,
): value is ProviderInstallationIdentity["providerId"] {
  return value === "codex"
    || value === "claude"
    || value === "cursor"
    || value === "kimi"
    || value === "opencode";
}

function payloadDigest(payload: ProviderMaintenanceJournalPayload): string {
  return createHash("sha256").update(JSON.stringify([
    payload.schemaVersion,
    payload.phase,
    payload.operationId,
    payload.providerId,
    payload.boundaryId,
    payload.scopeId,
    payload.fingerprint,
    payload.observedBoundaryId,
    payload.observedScopeId,
    payload.observedFingerprint,
    payload.runtimeGenerationId,
    payload.systemBootId,
    payload.createdAt,
  ])).digest("hex");
}

function parseRecord(
  bytes: Buffer,
  expectedOperationHash: string,
  expectedPhase: ProviderMaintenanceJournalPhase,
): StoredProviderMaintenanceJournalRecord | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || !exactKeys(value, [
      "createdAt",
      "boundaryId",
      "fingerprint",
      "integrity",
      "observedFingerprint",
      "observedBoundaryId",
      "observedScopeId",
      "operationId",
      "phase",
      "providerId",
      "runtimeGenerationId",
      "schemaVersion",
      "scopeId",
      "systemBootId",
    ])) return null;
    const record = value as Partial<StoredProviderMaintenanceJournalRecord>;
    if (
      record.schemaVersion !== JOURNAL_SCHEMA_VERSION
      || record.phase !== expectedPhase
      || !validOperationId(record.operationId)
      || operationHash(record.operationId) !== expectedOperationHash
      || !validProviderId(record.providerId)
      || typeof record.boundaryId !== "string"
      || !record.boundaryId.startsWith(`${record.providerId}:`)
      || !SHA256_PATTERN.test(
        record.boundaryId.slice(record.providerId.length + 1),
      )
      || typeof record.scopeId !== "string"
      || !record.scopeId.startsWith(`${record.providerId}:`)
      || !SHA256_PATTERN.test(record.scopeId.slice(record.providerId.length + 1))
      || typeof record.fingerprint !== "string"
      || !SHA256_PATTERN.test(record.fingerprint)
      || !validRuntimeGenerationId(record.runtimeGenerationId)
      || !validSystemBootId(record.systemBootId)
      || typeof record.createdAt !== "string"
      || !Number.isFinite(Date.parse(record.createdAt))
      || typeof record.integrity !== "string"
      || !SHA256_PATTERN.test(record.integrity)
    ) return null;
    const observedFieldsValid = record.phase === "owning"
      ? record.observedBoundaryId === null
        && record.observedScopeId === null
        && record.observedFingerprint === null
      : typeof record.observedBoundaryId === "string"
        && record.observedBoundaryId.startsWith(`${record.providerId}:`)
        && SHA256_PATTERN.test(
          record.observedBoundaryId.slice(record.providerId.length + 1),
        )
        && typeof record.observedScopeId === "string"
        && record.observedScopeId.startsWith(`${record.providerId}:`)
        && SHA256_PATTERN.test(
          record.observedScopeId.slice(record.providerId.length + 1),
        )
        && typeof record.observedFingerprint === "string"
        && SHA256_PATTERN.test(record.observedFingerprint);
    if (!observedFieldsValid) return null;
    const parsed = record as StoredProviderMaintenanceJournalRecord;
    return payloadDigest(parsed) === parsed.integrity ? parsed : null;
  } catch {
    return null;
  }
}

function operationHash(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}

function recordName(
  operationId: string,
  phase: ProviderMaintenanceJournalPhase,
): string {
  return `${JOURNAL_PREFIX}${operationHash(operationId)}.${phase}.json`;
}

function temporaryName(
  operationId: string,
  phase: ProviderMaintenanceJournalPhase,
): string {
  return `${JOURNAL_PREFIX}${operationHash(operationId)}.${phase}.publish.tmp`;
}

function storedRecord(payload: ProviderMaintenanceJournalPayload): Buffer {
  return Buffer.from(JSON.stringify({
    ...payload,
    integrity: payloadDigest(payload),
  }), "utf8");
}

function maintenanceIdentity(
  record: StoredProviderMaintenanceJournalRecord,
): ProviderInstallationIdentity {
  return {
    providerId: record.providerId,
    boundaryId: record.boundaryId,
    scopeId: record.scopeId,
    fingerprint: record.fingerprint,
  };
}

function readProviderMaintenanceJournalRecords(
  root: DirectRuntimeJournalRoot,
  options: ReadProviderMaintenanceJournalOptions,
): ReadProviderMaintenanceJournalRecord[] {
  const names = listDirectRuntimeJournalLeaves(
    root,
    JOURNAL_PREFIX,
    MAX_RECORDS * 3,
  );
  const records: ReadProviderMaintenanceJournalRecord[] = [];
  for (const name of names) {
    const match = name.match(
      /^\.provider-maintenance-([0-9a-f]{64})\.(owning|verified)\.(json|publish\.tmp)$/u,
    );
    if (!match) {
      throw new Error("Provider maintenance journal storage contains a foreign entry.");
    }
    const leaf = readDirectRuntimeJournalLeaf(
      root,
      name,
      MAX_RECORD_BYTES,
    );
    if (!leaf) throw new Error("A provider maintenance journal record disappeared.");
    const phase = match[2] as ProviderMaintenanceJournalPhase;
    const record = parseRecord(leaf.bytes, match[1]!, phase);
    if (!record) {
      throw new Error("A provider maintenance journal record is invalid.");
    }
    if (match[3] === "publish.tmp") {
      if (
        !options.discardTransients
        || !discardDirectRuntimeJournalLeaf(root, name, options.testHooks)
      ) {
        throw new Error(
          options.discardTransients
            ? "A provider maintenance transient could not be retired."
            : "Provider maintenance journal storage is incomplete.",
        );
      }
      continue;
    }
    records.push({ record, name, identity: leaf.identity });
    if (records.length > MAX_RECORDS) {
      throw new Error("Provider maintenance journal bound was exceeded.");
    }
  }
  return records;
}

function maintenanceRecoveryRecords(
  records: readonly ReadProviderMaintenanceJournalRecord[],
): ProviderMaintenanceRecoveryRecord[] {
  const grouped = new Map<string, {
    owning?: ReadProviderMaintenanceJournalRecord;
    verified?: ReadProviderMaintenanceJournalRecord;
  }>();
  for (const record of records) {
    const current = grouped.get(record.record.operationId) ?? {};
    if (current[record.record.phase]) {
      throw new Error("A provider maintenance journal phase is duplicated.");
    }
    current[record.record.phase] = record;
    grouped.set(record.record.operationId, current);
  }
  return [...grouped].map(([operationId, pair]) => {
    if (!pair.owning) {
      throw new Error("A provider maintenance verification has no owning record.");
    }
    if (
      pair.verified
      && (
        pair.verified.record.providerId !== pair.owning.record.providerId
        || pair.verified.record.boundaryId !== pair.owning.record.boundaryId
        || pair.verified.record.scopeId !== pair.owning.record.scopeId
        || pair.verified.record.fingerprint !== pair.owning.record.fingerprint
        || pair.verified.record.runtimeGenerationId
          !== pair.owning.record.runtimeGenerationId
        || pair.verified.record.systemBootId !== pair.owning.record.systemBootId
      )
    ) throw new Error("Provider maintenance journal phases conflict.");
    return {
      operationId,
      installationIdentity: maintenanceIdentity(pair.owning.record),
      runtimeGenerationId: pair.owning.record.runtimeGenerationId,
      systemBootId: pair.owning.record.systemBootId,
      verifiedIdentity: pair.verified
        ? {
            providerId: pair.verified.record.providerId,
            boundaryId: pair.verified.record.observedBoundaryId!,
            scopeId: pair.verified.record.observedScopeId!,
            fingerprint: pair.verified.record.observedFingerprint!,
          }
        : null,
    };
  });
}

/**
 * Candidate bootstrap may authenticate recovery state, but it must not repair
 * or consume it. Incomplete publication therefore remains a fail-closed
 * blocker for the old version (or ordinary startup recovery) to reconcile.
 */
export function validateProviderMaintenanceJournalStorage(
  dataDirectory: string,
): void {
  const root = pinDirectRuntimeJournalRoot(dataDirectory);
  maintenanceRecoveryRecords(readProviderMaintenanceJournalRecords(root, {
    discardTransients: false,
  }));
}

export class ProviderMaintenanceJournal
implements ProviderMaintenanceJournalAuthority {
  private readonly root: DirectRuntimeJournalRoot;

  constructor(
    dataDirectory: string,
    private readonly options: ProviderMaintenanceJournalOptions,
  ) {
    if (
      !validRuntimeGenerationId(options.runtimeGenerationId)
      || !validSystemBootId(options.systemBootId)
    ) throw new Error("Provider maintenance journal runtime identity is invalid.");
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
  }

  begin(
    operationId: string,
    identity: ProviderInstallationIdentity,
  ): boolean {
    if (!validOperationId(operationId)) return false;
    const pending = this.pending();
    if (pending.some((record) => (
      record.operationId === operationId
      || record.installationIdentity.providerId === identity.providerId
    ))) return false;
    return this.publish({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      phase: "owning",
      operationId,
      providerId: identity.providerId,
      boundaryId: identity.boundaryId,
      scopeId: identity.scopeId,
      fingerprint: identity.fingerprint,
      observedBoundaryId: null,
      observedScopeId: null,
      observedFingerprint: null,
      runtimeGenerationId: this.options.runtimeGenerationId,
      systemBootId: this.options.systemBootId,
      createdAt: new Date().toISOString(),
    });
  }

  markVerified(
    operationId: string,
    observedIdentity: ProviderInstallationIdentity,
  ): boolean {
    const owning = this.exactOperation(operationId)?.owning;
    if (
      !owning
      || owning.record.providerId !== observedIdentity.providerId
      || owning.record.boundaryId !== observedIdentity.boundaryId
    ) return false;
    const existing = this.exactOperation(operationId)?.verified;
    if (existing) {
      return existing.record.observedScopeId === observedIdentity.scopeId
        && existing.record.observedBoundaryId === observedIdentity.boundaryId
        && existing.record.observedFingerprint === observedIdentity.fingerprint;
    }
    return this.publish({
      ...this.payload(owning.record),
      phase: "verified",
      observedBoundaryId: observedIdentity.boundaryId,
      observedScopeId: observedIdentity.scopeId,
      observedFingerprint: observedIdentity.fingerprint,
    });
  }

  retireVerified(
    operationId: string,
    observedIdentity: ProviderInstallationIdentity,
  ): boolean {
    const pair = this.exactOperation(operationId);
    if (
      !pair?.owning
      || !pair.verified
      || pair.verified.record.providerId !== observedIdentity.providerId
      || pair.verified.record.observedBoundaryId !== observedIdentity.boundaryId
      || pair.verified.record.observedScopeId !== observedIdentity.scopeId
      || pair.verified.record.observedFingerprint !== observedIdentity.fingerprint
    ) return false;
    return this.retire([pair.verified, pair.owning]);
  }

  abandonUnadmitted(
    operationId: string,
    identity: ProviderInstallationIdentity,
  ): boolean {
    const pair = this.exactOperation(operationId);
    if (
      !pair?.owning
      || pair.verified
      || pair.owning.record.providerId !== identity.providerId
      || pair.owning.record.boundaryId !== identity.boundaryId
      || pair.owning.record.scopeId !== identity.scopeId
      || pair.owning.record.fingerprint !== identity.fingerprint
    ) return false;
    return this.retire([pair.owning]);
  }

  pending(): readonly ProviderMaintenanceRecoveryRecord[] {
    return maintenanceRecoveryRecords(this.readRecords());
  }

  reconcile(
    reconciliation: ProviderMaintenanceJournalReconciliation,
  ): readonly ProviderMaintenanceRecoveryRecord[] {
    // Runtime cleanup proves only that the old process tree stopped. It cannot
    // prove whether an update command replaced half of an installation. Keep
    // every record until a recovery owner re-resolves and attests it exactly.
    void reconciliation;
    return this.pending();
  }

  private publish(payload: ProviderMaintenanceJournalPayload): boolean {
    return writeDirectRuntimeJournalLeaf(
      this.root,
      temporaryName(payload.operationId, payload.phase),
      recordName(payload.operationId, payload.phase),
      storedRecord(payload),
      this.options.testHooks,
    );
  }

  private exactOperation(operationId: string): {
    owning?: ReadProviderMaintenanceJournalRecord;
    verified?: ReadProviderMaintenanceJournalRecord;
  } | null {
    if (!validOperationId(operationId)) return null;
    const records = this.readRecords().filter((candidate) =>
      candidate.record.operationId === operationId);
    const pair: {
      owning?: ReadProviderMaintenanceJournalRecord;
      verified?: ReadProviderMaintenanceJournalRecord;
    } = {};
    for (const record of records) {
      if (pair[record.record.phase]) {
        throw new Error("A provider maintenance journal phase is duplicated.");
      }
      pair[record.record.phase] = record;
    }
    return records.length > 0 ? pair : null;
  }

  private readRecords(): ReadProviderMaintenanceJournalRecord[] {
    return readProviderMaintenanceJournalRecords(this.root, {
      discardTransients: true,
      testHooks: this.options.testHooks,
    });
  }

  private retire(records: readonly ReadProviderMaintenanceJournalRecord[]): boolean {
    for (const record of records) {
      if (!unlinkDirectRuntimeJournalLeaf(
        this.root,
        record.name,
        record.identity,
        this.options.testHooks,
      )) return false;
    }
    return true;
  }

  private payload(
    record: StoredProviderMaintenanceJournalRecord,
  ): ProviderMaintenanceJournalPayload {
    const { integrity: _integrity, ...payload } = record;
    return payload;
  }

}

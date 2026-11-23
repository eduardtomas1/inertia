export const AUTO_COMPACT_MIN_RECLAIMABLE_BYTES = 64 * 1024 * 1024;
export const AUTO_COMPACT_MAX_FULL_VACUUM_BYTES = 512 * 1024 * 1024;
export const AUTO_COMPACT_MIN_RECLAIMABLE_RATIO = 0.2;
export const INCREMENTAL_VACUUM_PAGES_PER_STEP = 256;
export const FULL_VACUUM_DISK_MARGIN_BYTES = 64 * 1024 * 1024;
export const DATABASE_VACUUM_UNINTERRUPTIBLE_MESSAGE = "A running VACUUM can't be cancelled and will finish.";

export const DATABASE_AUTO_VACUUM_MODES = ["none", "full", "incremental"] as const;
export type DatabaseAutoVacuumMode = (typeof DATABASE_AUTO_VACUUM_MODES)[number];

export const DATABASE_COMPACTION_STATES = [
  "idle",
  "backing-up",
  "checkpointing",
  "vacuuming",
  "reclaiming",
] as const;
export type DatabaseCompactionState = (typeof DATABASE_COMPACTION_STATES)[number];

export const DATABASE_COMPACTION_MODES = [
  "full-vacuum",
  "incremental",
  "noop",
] as const;
export type DatabaseCompactionMode = (typeof DATABASE_COMPACTION_MODES)[number];

export interface DatabaseStorageStatus {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  databaseBytes: number;
  reclaimableBytes: number;
  walBytes: number;
  backupCount: number;
  backupBytes: number;
  autoVacuum: DatabaseAutoVacuumMode;
  compactionState: DatabaseCompactionState;
  busy: boolean;
  blockedReason: string | null;
}

export interface DatabaseCompactionSummary {
  mode: DatabaseCompactionMode;
  bytesBefore: number;
  bytesAfter: number;
  reclaimedBytes: number;
  walBytesBefore: number;
  walBytesAfter: number;
  autoVacuumBefore: DatabaseAutoVacuumMode;
  autoVacuumAfter: DatabaseAutoVacuumMode;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isDatabaseStorageStatus(value: unknown): value is DatabaseStorageStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (
    !nonNegativeSafeInteger(entry.pageSize)
    || !nonNegativeSafeInteger(entry.pageCount)
    || !nonNegativeSafeInteger(entry.freelistCount)
    || !nonNegativeSafeInteger(entry.databaseBytes)
    || !nonNegativeSafeInteger(entry.reclaimableBytes)
    || !nonNegativeSafeInteger(entry.walBytes)
    || !nonNegativeSafeInteger(entry.backupCount)
    || !nonNegativeSafeInteger(entry.backupBytes)
  ) return false;
  if (entry.freelistCount > entry.pageCount) return false;
  if (entry.databaseBytes !== entry.pageCount * entry.pageSize) return false;
  if (entry.reclaimableBytes !== entry.freelistCount * entry.pageSize) return false;
  if (!DATABASE_AUTO_VACUUM_MODES.includes(entry.autoVacuum as DatabaseAutoVacuumMode)) return false;
  if (!DATABASE_COMPACTION_STATES.includes(entry.compactionState as DatabaseCompactionState)) return false;
  if (typeof entry.busy !== "boolean" || entry.busy !== (entry.compactionState !== "idle")) return false;
  if (
    entry.blockedReason !== null
    && (typeof entry.blockedReason !== "string"
      || entry.blockedReason.length === 0
      || entry.blockedReason.length > 256)
  ) return false;
  return true;
}

export function isDatabaseCompactionSummary(value: unknown): value is DatabaseCompactionSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return DATABASE_COMPACTION_MODES.includes(entry.mode as DatabaseCompactionMode)
    && nonNegativeSafeInteger(entry.bytesBefore)
    && nonNegativeSafeInteger(entry.bytesAfter)
    && nonNegativeSafeInteger(entry.reclaimedBytes)
    && nonNegativeSafeInteger(entry.walBytesBefore)
    && nonNegativeSafeInteger(entry.walBytesAfter)
    && DATABASE_AUTO_VACUUM_MODES.includes(entry.autoVacuumBefore as DatabaseAutoVacuumMode)
    && DATABASE_AUTO_VACUUM_MODES.includes(entry.autoVacuumAfter as DatabaseAutoVacuumMode);
}

export function isDatabaseStorageResult(value: Record<string, unknown>): boolean {
  if (!isDatabaseStorageStatus(value.storage)) return false;
  if (value.compaction === undefined) return true;
  return isDatabaseCompactionSummary(value.compaction);
}

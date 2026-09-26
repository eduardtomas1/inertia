/** Retained originals on disk, shared by every chat in this app profile. */
export const ATTACHMENT_STORAGE_GIB_OPTIONS = [2, 4, 8, 16, 32, 64] as const;
export type AttachmentStorageGiB = (typeof ATTACHMENT_STORAGE_GIB_OPTIONS)[number];
export const DEFAULT_ATTACHMENT_STORAGE_GIB: AttachmentStorageGiB = 16;
export const ATTACHMENT_STORAGE_GIB_BYTES = 1024 ** 3;
export const MAX_RETAINED_ATTACHMENTS = 65_536;
export const ATTACHMENT_DISK_RESERVE_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_CLEANUP_BATCH_RECORDS = 64;

export function parseAttachmentStorageGiB(value: unknown): AttachmentStorageGiB {
  return ATTACHMENT_STORAGE_GIB_OPTIONS.includes(value as AttachmentStorageGiB)
    ? value as AttachmentStorageGiB : DEFAULT_ATTACHMENT_STORAGE_GIB;
}

export interface AttachmentStorageStatus {
  bytes: number | null;
  records: number | null;
  maxBytes: number;
  maxRecords: number;
  availableDiskBytes: number | null;
  state: "ready" | "reconciling" | "unavailable";
  removableRecords: number;
  removableBytes: number;
}

export function isAttachmentStorageStatus(value: unknown): value is AttachmentStorageStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const count = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return ["ready", "reconciling", "unavailable"].includes(entry.state as string)
    && (entry.bytes === null || count(entry.bytes))
    && (entry.records === null || count(entry.records))
    && count(entry.maxBytes) && count(entry.maxRecords)
    && count(entry.removableBytes) && count(entry.removableRecords)
    && (entry.availableDiskBytes === null || count(entry.availableDiskBytes))
    && (entry.state !== "ready" || (entry.bytes !== null && entry.records !== null));
}

export function isAttachmentStorageResult(value: Record<string, unknown>): boolean {
  if (!isAttachmentStorageStatus(value.storage)) return false;
  if (value.removed === undefined) return true;
  if (typeof value.removed !== "object" || value.removed === null) return false;
  const removed = value.removed as Record<string, unknown>;
  return typeof removed.records === "number" && Number.isSafeInteger(removed.records)
    && removed.records >= 0 && removed.records <= ATTACHMENT_CLEANUP_BATCH_RECORDS
    && typeof removed.bytes === "number" && Number.isSafeInteger(removed.bytes) && removed.bytes >= 0;
}

export function validAttachmentStorageSettings(value: Record<string, unknown>): boolean {
  return (value.attachmentStorageGiB === undefined || ATTACHMENT_STORAGE_GIB_OPTIONS.some((limit) => limit === value.attachmentStorageGiB))
    && (value.autoRemoveOldAttachments === undefined || typeof value.autoRemoveOldAttachments === "boolean");
}

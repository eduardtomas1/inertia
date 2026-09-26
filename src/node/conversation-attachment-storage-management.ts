import { statfs } from "node:fs/promises";
import { ATTACHMENT_CLEANUP_BATCH_RECORDS, type AttachmentStorageStatus } from "../shared/attachment-storage.js";
import type { ConversationAttachmentEvictionOrder, ConversationAttachmentUsage } from "./conversation-attachment-store-capacity.js";

export interface AttachmentStorageManagement {
  state: AttachmentStorageStatus["state"];
  maxBytes: number;
  maxRecords: number;
  records: Map<string, number>;
  authoritative: Set<string>;
  retained: ReadonlyMap<string, unknown>;
  pending: ReadonlyMap<string, unknown>;
  availableDiskBytes(): Promise<number>;
  removeRecord(id: string, signal: AbortSignal): Promise<void>;
}

export async function availableAttachmentDiskBytes(directory: string): Promise<number> {
  const disk = await statfs(directory, { bigint: true });
  return Number(disk.bavail * disk.bsize);
}

function candidates(store: AttachmentStorageManagement, order: readonly string[]): string[] {
  return [...new Set(order)].filter((id) => store.records.has(id)
    && store.authoritative.has(id) && !store.retained.has(id)
    && !store.pending.has(id)).slice(0, ATTACHMENT_CLEANUP_BATCH_RECORDS);
}

export async function describeAttachmentStorage(store: AttachmentStorageManagement, order: ConversationAttachmentEvictionOrder): Promise<AttachmentStorageStatus> {
  const removable = store.state === "ready" ? candidates(store, order()) : [];
  return {
    state: store.state, maxBytes: store.maxBytes, maxRecords: store.maxRecords,
    bytes: store.state === "ready" ? [...store.records.values()].reduce((total, size) => total + size, 0) : null,
    records: store.state === "ready" ? store.records.size : null,
    availableDiskBytes: await store.availableDiskBytes().catch(() => null),
    removableRecords: removable.length,
    removableBytes: removable.reduce((total, id) => total + (store.records.get(id) ?? 0), 0),
  };
}

/** Called under retention's mutation queue; recheck eligibility before each unlink. */
export async function cleanupOldestAttachments(store: AttachmentStorageManagement, order: ConversationAttachmentEvictionOrder): Promise<ConversationAttachmentUsage> {
  const signal = AbortSignal.timeout(30_000);
  let records = 0;
  let bytes = 0;
  for (const id of candidates(store, order())) {
    signal.throwIfAborted();
    if (!candidates(store, order()).includes(id)) continue;
    const size = store.records.get(id) ?? 0;
    await store.removeRecord(id, signal);
    store.records.delete(id);
    store.authoritative.delete(id);
    records += 1;
    bytes += size;
  }
  return { records, bytes };
}

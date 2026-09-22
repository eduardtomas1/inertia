export const CONVERSATION_ATTACHMENT_STORAGE_FULL_MESSAGE =
  "Attachment storage is full and every stored attachment still belongs to a running chat. Try again after it finishes.";

export class ConversationAttachmentStorageFullError extends Error {
  constructor() { super(CONVERSATION_ATTACHMENT_STORAGE_FULL_MESSAGE); }
}

export type ConversationAttachmentEvictionOrder = () => readonly string[];

export interface ConversationAttachmentUsage {
  readonly bytes: number;
  readonly records: number;
}

export function attachmentUsage(
  sizes: ReadonlyMap<string, number> | null,
): ConversationAttachmentUsage {
  let bytes = 0;
  for (const size of sizes?.values() ?? []) bytes += size;
  return { bytes, records: sizes?.size ?? 0 };
}

export function conversationAttachmentEvictions(options: {
  readonly order: readonly string[];
  readonly sizes: ReadonlyMap<string, number>;
  readonly evictable: (id: string) => boolean;
  readonly excessRecords: number;
  readonly excessBytes: number;
}): string[] | null {
  const victims: string[] = [];
  const seen = new Set<string>();
  let records = 0;
  let bytes = 0;
  for (const id of options.order) {
    if (records >= options.excessRecords && bytes >= options.excessBytes) break;
    const size = options.sizes.get(id);
    if (size === undefined || seen.has(id) || !options.evictable(id)) continue;
    seen.add(id);
    victims.push(id);
    records += 1;
    bytes += size;
  }
  return records >= options.excessRecords && bytes >= options.excessBytes
    ? victims
    : null;
}

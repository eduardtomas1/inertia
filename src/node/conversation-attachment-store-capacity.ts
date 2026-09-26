export const CONVERSATION_ATTACHMENT_STORAGE_FULL_MESSAGE =
  "Attachment storage is full. Increase the global disk budget or remove old stored files in Settings → Archive & data. Attachments used by running chats are protected.";

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

export class ConversationAttachmentDiskFullError extends Error {
  constructor() {
    super("Not enough free disk space to keep these attachments. Free disk space or remove stored attachments in Settings → Archive & data.");
  }
}

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { CHAT_ATTACHMENT_MIME_TYPES, MAX_CHAT_ATTACHMENT_BYTES,
  safeChatAttachmentMimeTypeForName as chatAttachmentMimeTypeForName, chatAttachmentStorageExtension,
  type ChatAttachmentMimeType } from "../shared/attachments.js";
import type { ChatAttachment } from "../shared/contracts.js";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface PersistedAttachmentMetadata {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly mimeType: ChatAttachmentMimeType;
  readonly size: number;
  readonly digest: string;
  readonly extension: string;
}

export function metadataFromUnknown(value: unknown): PersistedAttachmentMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<PersistedAttachmentMetadata>;
  const keys = Object.keys(value);
  if (
    keys.length !== 7
    || !keys.every((key) => [
      "version",
      "id",
      "name",
      "mimeType",
      "size",
      "digest",
      "extension",
    ].includes(key))
    || candidate.version !== 1
    || typeof candidate.id !== "string"
    || !UUID_PATTERN.test(candidate.id)
    || typeof candidate.name !== "string"
    || candidate.name.length < 1
    || candidate.name.length > 255
    || /[\0-\x1f\x7f]/u.test(candidate.name)
    || /[\\/]/u.test(candidate.name)
    || basename(candidate.name) !== candidate.name
    || typeof candidate.mimeType !== "string"
    || !(CHAT_ATTACHMENT_MIME_TYPES as readonly string[])
      .includes(candidate.mimeType)
    || chatAttachmentMimeTypeForName(candidate.name) !== candidate.mimeType
    || !Number.isSafeInteger(candidate.size)
    || (candidate.size ?? 0) < 1
    || (candidate.size ?? 0) > MAX_CHAT_ATTACHMENT_BYTES
    || typeof candidate.digest !== "string"
    || !DIGEST_PATTERN.test(candidate.digest)
    || typeof candidate.extension !== "string"
    || chatAttachmentStorageExtension(
      candidate.mimeType as ChatAttachmentMimeType,
    )
      !== candidate.extension
  ) return null;
  return candidate as PersistedAttachmentMetadata;
}

export function metadataFor(payload: { readonly attachment: ChatAttachment; readonly bytes: Uint8Array }): PersistedAttachmentMetadata {
  const { attachment, bytes } = payload;
  if (
    !UUID_PATTERN.test(attachment.id)
    || attachment.name.length < 1
    || attachment.name.length > 255
    || /[\0-\x1f\x7f]/u.test(attachment.name)
    || /[\\/]/u.test(attachment.name)
    || basename(attachment.name) !== attachment.name
    || bytes.byteLength !== attachment.size
    || attachment.size < 1
    || attachment.size > MAX_CHAT_ATTACHMENT_BYTES
    || chatAttachmentMimeTypeForName(attachment.name) !== attachment.mimeType
  ) {
    throw new Error("The retained conversation attachment is invalid.");
  }
  return {
    version: 1,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    digest: createHash("sha256").update(bytes).digest("hex"),
    extension: chatAttachmentStorageExtension(attachment.mimeType),
  };
}


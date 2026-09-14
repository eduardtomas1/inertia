import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  type ChatAttachmentMimeType,
} from "../shared/attachments";

export const DOCUMENT_PREPARATION_TIMEOUT_MS = 43_000;
export const DOCUMENT_PREPARATION_CONTEXT_BYTES = 96 * 1024;

/** Decoder input carries bytes and display metadata, never filesystem authority. */
export interface DocumentPreparationPayload {
  id: string;
  name: string;
  mimeType: ChatAttachmentMimeType;
  bytes: Uint8Array;
}

export interface DocumentPreparationOperation {
  payloads: DocumentPreparationPayload[];
  deadlineAt: number;
}

export interface DocumentPreparationResult {
  contexts: Array<{ attachmentId: string; label: string; content: string; truncated: boolean }>;
  images: Array<{ id: string; bytes: Uint8Array }>;
  imageOrder: Array<{ sourceId: string } | { generatedId: string }>;
}

export interface DocumentPreparationExecution {
  result: Promise<DocumentPreparationResult>;
  /** Resolves only after observed exit, or rejects when bounded cleanup is unconfirmed. */
  stopped: Promise<void>;
  /** Remains pending until the actual process exits, including after an unconfirmed stop. */
  termination: Promise<void>;
}

export type DocumentPreparationRunner = (
  operation: DocumentPreparationOperation,
  signal?: AbortSignal,
) => DocumentPreparationExecution;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const bytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array
  && value.byteLength > 0 && value.byteLength <= MAX_CHAT_ATTACHMENT_BYTES;

export function parseDocumentPreparationOperation(value: unknown): DocumentPreparationOperation | null {
  if (!record(value) || !keys(value, ["payloads", "deadlineAt"])
    || !Number.isSafeInteger(value.deadlineAt) || (value.deadlineAt as number) < 1
    || !Array.isArray(value.payloads) || value.payloads.length < 1
    || value.payloads.length > MAX_CHAT_ATTACHMENTS) return null;
  const seen = new Set<string>();
  let total = 0;
  for (const payload of value.payloads) {
    if (!record(payload) || !keys(payload, ["id", "name", "mimeType", "bytes"])
      || !id(payload.id) || seen.has(payload.id)
      || typeof payload.name !== "string" || payload.name.length < 1 || payload.name.length > 512
      || typeof payload.mimeType !== "string"
      || !CHAT_ATTACHMENT_MIME_TYPES.includes(payload.mimeType as ChatAttachmentMimeType)
      || !bytes(payload.bytes)) return null;
    seen.add(payload.id);
    total += payload.bytes.byteLength;
    if (total > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) return null;
  }
  return value as unknown as DocumentPreparationOperation;
}

export function parseDocumentPreparationResult(value: unknown): DocumentPreparationResult | null {
  if (!record(value) || !keys(value, ["contexts", "images", "imageOrder"])
    || !Array.isArray(value.contexts) || value.contexts.length > MAX_CHAT_ATTACHMENTS
    || !Array.isArray(value.images) || value.images.length > MAX_CHAT_ATTACHMENTS
    || !Array.isArray(value.imageOrder) || value.imageOrder.length > MAX_CHAT_ATTACHMENTS) return null;
  const contextIds = new Set<string>();
  let contextBytes = 0;
  for (const context of value.contexts) {
    if (!record(context) || !keys(context, ["attachmentId", "label", "content", "truncated"])
      || !id(context.attachmentId) || contextIds.has(context.attachmentId)
      || typeof context.label !== "string" || context.label.length > 1_024
      || typeof context.content !== "string" || typeof context.truncated !== "boolean") return null;
    contextIds.add(context.attachmentId);
    contextBytes += Buffer.byteLength(JSON.stringify(context.content), "utf8") - 2;
    if (contextBytes > DOCUMENT_PREPARATION_CONTEXT_BYTES) return null;
  }
  const imageIds = new Set<string>();
  let imageBytes = 0;
  for (const image of value.images) {
    if (!record(image) || !keys(image, ["id", "bytes"])
      || !id(image.id) || imageIds.has(image.id) || !bytes(image.bytes)
      || image.bytes.length < 4 || image.bytes[0] !== 0xff || image.bytes[1] !== 0xd8
      || image.bytes.at(-2) !== 0xff || image.bytes.at(-1) !== 0xd9) return null;
    imageIds.add(image.id);
    imageBytes += image.bytes.byteLength;
    if (imageBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) return null;
  }
  const seen = new Set<string>();
  for (const entry of value.imageOrder) {
    if (!record(entry)) return null;
    const source = keys(entry, ["sourceId"]) && id(entry.sourceId);
    const generated = keys(entry, ["generatedId"]) && id(entry.generatedId) && imageIds.has(entry.generatedId);
    if (!source && !generated) return null;
    const key = source ? `source:${entry.sourceId as string}` : `generated:${entry.generatedId as string}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  if ([...imageIds].some((id) => !seen.has(`generated:${id}`))) return null;
  return value as unknown as DocumentPreparationResult;
}

export function documentPreparationResultMatches(
  operation: DocumentPreparationOperation,
  result: DocumentPreparationResult,
): boolean {
  const documents = operation.payloads.filter((payload) => !payload.mimeType.startsWith("image/"));
  const images = operation.payloads.filter((payload) => payload.mimeType.startsWith("image/"));
  return result.contexts.length === documents.length
    && documents.every((payload) => result.contexts.some((context) => context.attachmentId === payload.id))
    && result.imageOrder.filter((entry) => "sourceId" in entry).length === images.length
    && images.every((payload) => result.imageOrder.some((entry) => "sourceId" in entry && entry.sourceId === payload.id))
    && images.reduce((total, payload) => total + payload.bytes.byteLength, 0)
      + result.images.reduce((total, image) => total + image.bytes.byteLength, 0) <= MAX_CHAT_ATTACHMENT_TOTAL_BYTES;
}

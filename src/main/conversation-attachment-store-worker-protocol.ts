const MAX_ENCODED_OPERATION_BYTES = 16 * 1024 * 1024;

export interface ConversationAttachmentStoreWorkerRequest {
  readonly type: "conversation-attachment-store.perform";
  readonly encodedOperation: string;
}

export type ConversationAttachmentStoreWorkerEvent = {
  readonly type: "conversation-attachment-store.ready";
} | {
  readonly type: "conversation-attachment-store.result";
  readonly ok: boolean;
  readonly receipt?: unknown;
};

export function parseConversationAttachmentStoreWorkerRequest(
  value: unknown,
): ConversationAttachmentStoreWorkerRequest | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 2
  ) return null;
  const request = value as Record<string, unknown>;
  if (
    request.type !== "conversation-attachment-store.perform"
    || typeof request.encodedOperation !== "string"
    || Buffer.byteLength(request.encodedOperation, "utf8")
      > MAX_ENCODED_OPERATION_BYTES
  ) return null;
  return {
    type: request.type,
    encodedOperation: request.encodedOperation,
  };
}

export function parseConversationAttachmentStoreWorkerEvent(
  value: unknown,
): ConversationAttachmentStoreWorkerEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (
    event.type === "conversation-attachment-store.ready"
    && Object.keys(event).length === 1
  ) return { type: event.type };
  if (
    event.type !== "conversation-attachment-store.result"
    || typeof event.ok !== "boolean"
    || !Object.keys(event).every((key) => ["type", "ok", "receipt"].includes(key))
    || (event.ok === false && "receipt" in event)
  ) return null;
  return {
    type: event.type,
    ok: event.ok,
    ...(event.ok ? { receipt: event.receipt } : {}),
  };
}

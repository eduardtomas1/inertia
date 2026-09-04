const MAX_ENCODED_OPERATION_BYTES = 16 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ConversationAttachmentStoreWorkerRequest = {
  readonly type: "conversation-attachment-store.perform";
  readonly operationId: string;
  readonly encodedOperation: string;
} | {
  readonly type: "conversation-attachment-store.result-ack";
  readonly operationId: string;
};

export type ConversationAttachmentStoreWorkerEvent = {
  readonly type: "conversation-attachment-store.ready";
  readonly operationId: string;
} | {
  readonly type: "conversation-attachment-store.result";
  readonly operationId: string;
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
  ) return null;
  const request = value as Record<string, unknown>;
  if (
    request.type === "conversation-attachment-store.result-ack"
    && Object.keys(request).length === 2
    && typeof request.operationId === "string"
    && UUID_PATTERN.test(request.operationId)
  ) {
    return { type: request.type, operationId: request.operationId };
  }
  if (
    request.type !== "conversation-attachment-store.perform"
    || Object.keys(request).length !== 3
    || typeof request.operationId !== "string"
    || !UUID_PATTERN.test(request.operationId)
    || typeof request.encodedOperation !== "string"
    || Buffer.byteLength(request.encodedOperation, "utf8")
      > MAX_ENCODED_OPERATION_BYTES
  ) return null;
  return {
    type: request.type,
    operationId: request.operationId,
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
    && Object.keys(event).length === 2
    && typeof event.operationId === "string"
    && UUID_PATTERN.test(event.operationId)
  ) return { type: event.type, operationId: event.operationId };
  if (
    event.type !== "conversation-attachment-store.result"
    || typeof event.operationId !== "string"
    || !UUID_PATTERN.test(event.operationId)
    || typeof event.ok !== "boolean"
    || !Object.keys(event).every((key) => [
      "type",
      "operationId",
      "ok",
      "receipt",
    ].includes(key))
    || (event.ok === false && "receipt" in event)
  ) return null;
  return {
    type: event.type,
    operationId: event.operationId,
    ok: event.ok,
    ...(event.ok ? { receipt: event.receipt } : {}),
  };
}

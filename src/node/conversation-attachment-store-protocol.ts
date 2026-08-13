import {
  MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES,
} from "./conversation-attachment-store-child.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type RuntimeConversationAttachmentStoreResult = {
  type: "runtime.conversation-attachment-store-result";
  requestId: string;
  ok: true;
  shutdownConfirmed: true;
  encodedReceipt: string | null;
} | {
  type: "runtime.conversation-attachment-store-result";
  requestId: string;
  ok: false;
  shutdownConfirmed: boolean;
  message: string;
};

export type RuntimeConversationAttachmentStoreEvent = {
  type: "runtime.conversation-attachment-store-request";
  requestId: string;
  encodedOperation: string;
} | {
  type: "runtime.conversation-attachment-store-cancel";
  requestId: string;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRuntimeConversationAttachmentStoreResult(
  value: unknown,
): RuntimeConversationAttachmentStoreResult | null {
  if (
    !plainObject(value)
    || value.type !== "runtime.conversation-attachment-store-result"
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || typeof value.ok !== "boolean"
  ) return null;
  if (value.ok) {
    if (
      Object.keys(value).length !== 5
      || value.shutdownConfirmed !== true
      || !(
        value.encodedReceipt === null
        || (
          typeof value.encodedReceipt === "string"
          && Buffer.byteLength(value.encodedReceipt, "utf8")
            <= MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES
        )
      )
    ) return null;
    return {
      type: value.type,
      requestId: value.requestId,
      ok: true,
      shutdownConfirmed: true,
      encodedReceipt: value.encodedReceipt,
    };
  }
  if (
    Object.keys(value).length !== 5
    || typeof value.shutdownConfirmed !== "boolean"
    || typeof value.message !== "string"
    || value.message.length < 1
    || value.message.length > 1_000
  ) return null;
  return {
    type: value.type,
    requestId: value.requestId,
    ok: false,
    shutdownConfirmed: value.shutdownConfirmed,
    message: value.message,
  };
}

export function parseRuntimeConversationAttachmentStoreEvent(
  value: unknown,
): RuntimeConversationAttachmentStoreEvent | null {
  if (!plainObject(value) || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)) return null;
  if (
    value.type === "runtime.conversation-attachment-store-request"
    && Object.keys(value).length === 3
    && typeof value.encodedOperation === "string"
    && Buffer.byteLength(value.encodedOperation, "utf8")
      <= MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES
  ) return {
    type: value.type,
    requestId: value.requestId,
    encodedOperation: value.encodedOperation,
  };
  if (
    value.type === "runtime.conversation-attachment-store-cancel"
    && Object.keys(value).length === 2
  ) return { type: value.type, requestId: value.requestId };
  return null;
}

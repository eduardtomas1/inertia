import { CHAT_ATTACHMENT_MIME_TYPES } from "../attachments";
import type { ChatMessage } from "./agent";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function recordWithStrings(value: unknown, ...keys: string[]): value is UnknownRecord {
  return record(value) && keys.every((key) => stringField(value, key));
}

function attachment(value: unknown): boolean {
  return recordWithStrings(value, "id", "name", "path", "mimeType")
    && CHAT_ATTACHMENT_MIME_TYPES.includes(
      value.mimeType as (typeof CHAT_ATTACHMENT_MIME_TYPES)[number],
    )
    && typeof value.size === "number"
    && Number.isFinite(value.size)
    && value.size >= 0;
}

export function chatMessageSchema(value: unknown): value is ChatMessage {
  if (!recordWithStrings(
    value,
    "id",
    "conversationId",
    "role",
    "content",
    "createdAt",
  )) return false;

  return (value.turnId === null || stringField(value, "turnId"))
    && ["user", "assistant", "system"].includes(value.role as string)
    && Array.isArray(value.attachments)
    && value.attachments.every(attachment)
    && new Set(value.attachments.map(({ id }) => id)).size
      === value.attachments.length;
}

export function optionalTerminalAssistantMessageSchema(value: unknown): boolean {
  if (!record(value)) return false;
  const message = value.terminalAssistantMessage;
  if (message === undefined || message === null) return true;

  return chatMessageSchema(message)
    && message.role === "assistant"
    && message.conversationId === value.conversationId
    && message.turnId === value.turnId
    && typeof value.terminalAssistantMessageId === "string"
    && value.terminalAssistantMessageId === message.id;
}

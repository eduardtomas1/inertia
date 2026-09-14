import { snapshotSourceSchema } from "../snapshots";
import { isContextCompaction } from "../context-compaction";
import { CHAT_ATTACHMENT_MIME_TYPES } from "../attachments";
import type { ChatMessage } from "./agent";

type UnknownRecord = Record<string, unknown>;

export function isMessageOriginDeviceId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

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
    && (value.snapshot === undefined || snapshotSourceSchema.safeParse(value.snapshot).success)
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

  return (value.compaction === undefined || (value.role === "system" && value.turnId === null && isContextCompaction(value.compaction)))
    && (value.privateConnectDeviceId === undefined
      || (value.role === "user" && isMessageOriginDeviceId(value.privateConnectDeviceId)))
    && (value.turnId === null || stringField(value, "turnId"))
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

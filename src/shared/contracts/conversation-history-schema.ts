import { queuedMessageSchema } from "../message-queue";

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const cursor = (value: unknown): boolean => value === null || (typeof value === "string" && value.length > 0 && value.length <= 2048);
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;

function queuedMessages(value: unknown, conversationId: string): boolean {
  return Array.isArray(value) && value.length <= 10
    && value.every((entry) => queuedMessageSchema.safeParse(entry).success && entry.conversationId === conversationId);
}

export function conversationDetailExtensions(value: UnknownRecord, conversationId: string): boolean {
  return (value.history === undefined || (isRecord(value.history)
    && cursor(value.history.olderCursor) && cursor(value.history.newerCursor)
    && integer(value.history.recordCount) && value.history.recordCount <= 24))
    && (value.deferredContent === undefined || (Array.isArray(value.deferredContent)
      && value.deferredContent.length <= 96 && value.deferredContent.every((entry: unknown) =>
        isRecord(entry) && typeof entry.id === "string" && typeof entry.label === "string"
        && typeof entry.cursor === "string" && cursor(entry.cursor)
        && ["message", "reasoning", "activity"].includes(entry.kind as string) && integer(entry.totalBytes, 1))))
    && (value.queuedMessages === undefined || queuedMessages(value.queuedMessages, conversationId));
}

export function conversationContentResult(value: UnknownRecord): boolean {
  return typeof value.conversationId === "string" && typeof value.text === "string"
    && value.text.length <= 65536 && new TextEncoder().encode(value.text).byteLength <= 65536
    && integer(value.offsetBytes) && integer(value.totalBytes, value.offsetBytes)
    && cursor(value.nextCursor);
}

export function messageQueueResult(value: UnknownRecord): boolean {
  return typeof value.conversationId === "string" && queuedMessages(value.items, value.conversationId);
}

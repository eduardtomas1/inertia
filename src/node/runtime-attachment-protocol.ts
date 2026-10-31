import { isAbsolute } from "node:path";

import { ACCEPTED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import type { TrustedRuntimeAttachment } from "../shared/runtime-attachments";
import { snapshotSourceSchema } from "../shared/snapshots";

export type RuntimeAttachmentFailureCode = "not-found" | "unavailable" | "invalid";

interface RuntimeAttachmentFailure<Type extends string> {
  type: Type;
  requestId: string;
  ok: false;
  code: RuntimeAttachmentFailureCode;
  message: string;
}

export type RuntimeAttachmentResult =
  | { type: "runtime.attachment-result"; requestId: string; ok: true; attachment: TrustedRuntimeAttachment }
  | RuntimeAttachmentFailure<"runtime.attachment-result">;

export type RuntimeAttachmentReleaseResult =
  | { type: "runtime.attachment-release-result"; requestId: string; ok: true; released: boolean }
  | RuntimeAttachmentFailure<"runtime.attachment-release-result">;

export type RuntimeAttachmentRelinquishResult =
  | { type: "runtime.attachment-relinquish-result"; requestId: string; ok: true; relinquished: boolean }
  | RuntimeAttachmentFailure<"runtime.attachment-relinquish-result">;

/**
 * Main asks the runtime which chats sent a stored attachment before it lets a
 * chat window re-attach that file. The runtime owns the database.
 */
export interface RuntimeAttachmentConversationsQuery {
  type: "runtime.attachment-conversations";
  requestId: string;
  attachmentId: string;
}

/** More owners than this is answered as unavailable rather than cut short. */
export const MAX_RUNTIME_ATTACHMENT_CONVERSATIONS = 4_096;

export type RuntimeAttachmentConversationsEvent =
  | { type: "runtime.attachment-conversations-resolved"; requestId: string; conversationIds: string[] }
  | { type: "runtime.attachment-conversations-rejected"; requestId: string; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") && isAbsolute(value);
}

function identified(value: Record<string, unknown>): value is Record<string, unknown> & { requestId: string } {
  return typeof value.requestId === "string" && UUID_PATTERN.test(value.requestId);
}

function parseFailure<Type extends string>(
  type: Type,
  value: Record<string, unknown> & { requestId: string },
): RuntimeAttachmentFailure<Type> | null {
  if (
    Object.keys(value).length !== 5
    || (value.code !== "not-found" && value.code !== "unavailable" && value.code !== "invalid")
    || typeof value.message !== "string"
  ) return null;
  const message = value.message.trim();
  return message.length > 0 && message.length <= 300
    ? { type, requestId: value.requestId, ok: false, code: value.code, message }
    : null;
}

export function parseRuntimeAttachmentRelinquishResult(
  value: Record<string, unknown>,
): RuntimeAttachmentRelinquishResult | null {
  if (!identified(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) return parseFailure("runtime.attachment-relinquish-result", value);
  return Object.keys(value).length === 4 && typeof value.relinquished === "boolean"
    ? { type: "runtime.attachment-relinquish-result", requestId: value.requestId, ok: true, relinquished: value.relinquished }
    : null;
}

export function parseRuntimeAttachmentReleaseResult(
  value: Record<string, unknown>,
): RuntimeAttachmentReleaseResult | null {
  if (!identified(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) return parseFailure("runtime.attachment-release-result", value);
  return Object.keys(value).length === 4 && typeof value.released === "boolean"
    ? { type: "runtime.attachment-release-result", requestId: value.requestId, ok: true, released: value.released }
    : null;
}

export function parseRuntimeAttachmentResult(
  value: Record<string, unknown>,
): RuntimeAttachmentResult | null {
  if (!identified(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) return parseFailure("runtime.attachment-result", value);
  if (
    Object.keys(value).length !== 4
    || !plainObject(value.attachment)
  ) return null;
  const attachment = value.attachment;
  if (
    Object.keys(attachment).length !== (attachment.snapshot === undefined ? 6 : 7)
    || (attachment.snapshot !== undefined && !snapshotSourceSchema.safeParse(attachment.snapshot).success)
    || typeof attachment.id !== "string"
    || !UUID_PATTERN.test(attachment.id)
    || typeof attachment.name !== "string"
    || attachment.name.length < 1
    || attachment.name.length > 255
    || /[\0-\x1f\x7f]/u.test(attachment.name)
    || !runtimePath(attachment.path)
    || !(ACCEPTED_ATTACHMENT_MIME_TYPES as readonly unknown[]).includes(
      attachment.mimeType,
    )
    || typeof attachment.size !== "number"
    || !Number.isInteger(attachment.size)
    || attachment.size < 1
    || attachment.size > MAX_ATTACHMENT_BYTES
    || typeof attachment.digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(attachment.digest)
  ) return null;
  return {
    type: "runtime.attachment-result",
    requestId: value.requestId,
    ok: true,
    attachment: {
      id: attachment.id,
      name: attachment.name,
      path: attachment.path,
      mimeType: attachment.mimeType as TrustedRuntimeAttachment["mimeType"],
      size: attachment.size,
      digest: attachment.digest,
      ...(attachment.snapshot ? { snapshot: snapshotSourceSchema.parse(attachment.snapshot) } : {}),
    },
  };
}

export function parseRuntimeAttachmentConversationsQuery(
  value: unknown,
): RuntimeAttachmentConversationsQuery | null {
  if (
    !plainObject(value)
    || value.type !== "runtime.attachment-conversations"
    || Object.keys(value).length !== 3
    || !identified(value)
    || typeof value.attachmentId !== "string"
    || !UUID_PATTERN.test(value.attachmentId)
  ) return null;
  return { type: "runtime.attachment-conversations", requestId: value.requestId, attachmentId: value.attachmentId };
}

export function parseRuntimeAttachmentConversationsEvent(
  value: unknown,
): RuntimeAttachmentConversationsEvent | null {
  if (!plainObject(value) || Object.keys(value).length !== 3 || !identified(value)) return null;
  if (value.type === "runtime.attachment-conversations-resolved") {
    const ids = value.conversationIds;
    if (
      !Array.isArray(ids)
      || ids.length > MAX_RUNTIME_ATTACHMENT_CONVERSATIONS
      || !ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id))
    ) return null;
    return { type: "runtime.attachment-conversations-resolved", requestId: value.requestId, conversationIds: [...ids] as string[] };
  }
  if (value.type === "runtime.attachment-conversations-rejected" && typeof value.message === "string") {
    const message = value.message.trim();
    return message && message.length <= 1_000
      ? { type: "runtime.attachment-conversations-rejected", requestId: value.requestId, message }
      : null;
  }
  return null;
}

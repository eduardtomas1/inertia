import {
  MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE,
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_TOTAL_BYTES,
  type ConversationContextExcerpt,
  type ConversationContextSupplement,
} from "../../shared/conversation-context";
import { byteLength } from "./bounded-message-text";
import { MAX_PROVIDER_HANDOFF_FILES } from "./provider-handoff-files";
import { MAX_TURN_AGENT_LABEL_LENGTH } from "./turn-context-facts";

export interface StoredPacketExcerpts {
  excerpts_json: string;
  message_count: number;
  character_count: number;
  transport_version: 1 | 2 | 3;
}

const UNFINISHED_TURN_STATES = new Set(["failed", "cancelled", "running"]);
const MAX_SUPPLEMENT_COMMANDS = 3;
const MAX_SUPPLEMENT_LINE_LENGTH = 4_200;

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength;
}

function boundedLines(value: unknown, maximumCount: number): boolean {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= maximumCount
    && value.every((line) => boundedString(line, MAX_SUPPLEMENT_LINE_LENGTH));
}

const ATTACHMENT_REFERENCE_KEYS = ["id", "mimeType", "name", "size"]
  .sort()
  .join("\0");

function isAttachmentReferenceList(value: unknown): boolean {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE
  ) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const attachment = entry as Record<string, unknown>;
    if (
      Object.keys(attachment).sort().join("\0") !== ATTACHMENT_REFERENCE_KEYS
      || typeof attachment.id !== "string"
      || attachment.id.length < 1
      || ids.has(attachment.id)
      || typeof attachment.name !== "string"
      || attachment.name.length < 1
      || typeof attachment.mimeType !== "string"
      || attachment.mimeType.length < 1
      || typeof attachment.size !== "number"
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 1
    ) return false;
    ids.add(attachment.id);
  }
  return true;
}

export function parseExcerpts(row: StoredPacketExcerpts): ConversationContextExcerpt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.excerpts_json);
  } catch {
    throw new Error("The saved chat context is malformed.");
  }
  if (!Array.isArray(parsed) || parsed.length !== row.message_count) {
    throw new Error("The saved chat context no longer matches its provenance.");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  let totalBytes = 0;
  let totalCharacters = 0;
  const messageIds = new Set<string>();
  for (const value of parsed) {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
    ) {
      throw new Error("The saved chat context contains a malformed excerpt.");
    }
    const excerpt = value as Record<string, unknown>;
    const keys = Object.keys(excerpt).sort();
    const expectedKeys = [
      "content",
      "createdAt",
      "role",
      "sourceMessageId",
      "sourceTurnId",
      "truncated",
      ...(excerpt.attachments === undefined ? [] : ["attachments"]),
      ...(excerpt.agent === undefined ? [] : ["agent"]),
      ...(excerpt.turn === undefined ? [] : ["turn"]),
    ];
    if (
      keys.join("\0") !== expectedKeys.sort().join("\0")
      || (
        (excerpt.agent !== undefined || excerpt.turn !== undefined)
        && row.transport_version !== 3
      )
      || (
        excerpt.agent !== undefined
        && (excerpt.role !== "assistant" || !boundedString(excerpt.agent, MAX_TURN_AGENT_LABEL_LENGTH))
      )
      || (excerpt.turn !== undefined && !UNFINISHED_TURN_STATES.has(excerpt.turn as string))
      || (
        excerpt.attachments !== undefined
        && !isAttachmentReferenceList(excerpt.attachments)
      )
      || typeof excerpt.sourceMessageId !== "string"
      || !uuid.test(excerpt.sourceMessageId)
      || messageIds.has(excerpt.sourceMessageId)
      || (
        excerpt.sourceTurnId !== null
        && (typeof excerpt.sourceTurnId !== "string" || !uuid.test(excerpt.sourceTurnId))
      )
      || (excerpt.role !== "user" && excerpt.role !== "assistant")
      || typeof excerpt.content !== "string"
      || excerpt.content.length < 1
      || typeof excerpt.truncated !== "boolean"
      || typeof excerpt.createdAt !== "string"
      || !Number.isFinite(Date.parse(excerpt.createdAt))
    ) {
      throw new Error("The saved chat context contains a malformed excerpt.");
    }
    const excerptBytes = byteLength(excerpt.content);
    if (excerptBytes > MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES) {
      throw new Error("The saved chat context exceeds the excerpt size limit.");
    }
    messageIds.add(excerpt.sourceMessageId);
    totalBytes += excerptBytes;
    totalCharacters += excerpt.content.length;
  }
  if (
    totalBytes > MAX_CONVERSATION_CONTEXT_TOTAL_BYTES
    || totalCharacters !== row.character_count
  ) {
    throw new Error("The saved chat context no longer matches its size provenance.");
  }
  return parsed as ConversationContextExcerpt[];
}

export function parseSupplement(row: {
  supplement_json: string | null;
  transport_version: 1 | 2 | 3;
}): ConversationContextSupplement | undefined {
  if (row.supplement_json === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.supplement_json);
  } catch {
    throw new Error("The saved chat context is malformed.");
  }
  const supplement = parsed as Record<string, unknown>;
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.keys(supplement)
    : [];
  if (
    row.transport_version !== 3
    || keys.length === 0
    || keys.some((key) => key !== "files" && key !== "omittedFiles" && key !== "commands")
    || (supplement.files !== undefined && !boundedLines(supplement.files, MAX_PROVIDER_HANDOFF_FILES))
    || (supplement.commands !== undefined && !boundedLines(supplement.commands, MAX_SUPPLEMENT_COMMANDS))
    || (
      supplement.omittedFiles !== undefined
      && (
        supplement.files === undefined
        || typeof supplement.omittedFiles !== "number"
        || !Number.isSafeInteger(supplement.omittedFiles)
        || supplement.omittedFiles < 1
      )
    )
  ) {
    throw new Error("The saved chat context contains a malformed supplement.");
  }
  return supplement as ConversationContextSupplement;
}

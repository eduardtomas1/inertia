import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentKind,
} from "@shared/attachments";
import type { ChatAttachment } from "@shared/contracts";

import type { ComposerQueuedPrompt } from "./types";
import {
  composerMediaQueueConversationId,
  composerMediaQueueKey,
} from "./composerQueuedMediaOwnership";

export { composerMediaQueueKey } from "./composerQueuedMediaOwnership";

export const MAX_COMPOSER_QUEUED_PROMPTS = 3;
export const QUEUED_PROMPTS_CHANGED_EVENT = "inertia:queued-prompts-changed";

const QUEUE_STORAGE_VERSION = "v2";
const QUEUE_KEY_PREFIX = `inertia:queued-prompts:${QUEUE_STORAGE_VERSION}:`;
const LEGACY_QUEUE_KEY_PREFIX = "inertia:queued-prompts:";
const MAX_STORED_QUEUE_ENTRIES = 10;
const MAX_QUEUED_CONTENT_CHARS = 20_000;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const MAX_PROMPT_ID_CHARS = 256;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function composerQueueKey(conversationId: string): string {
  return `${QUEUE_KEY_PREFIX}${conversationId}`;
}

function legacyQueueKey(conversationId: string): string {
  return `${LEGACY_QUEUE_KEY_PREFIX}${conversationId}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function queuedAttachment(value: unknown): ChatAttachment | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.id !== "string"
    || !UUID_PATTERN.test(candidate.id)
    || typeof candidate.name !== "string"
    || candidate.name.trim().length === 0
    || candidate.name.length > MAX_ATTACHMENT_NAME_CHARS
    || typeof candidate.path !== "string"
    || candidate.path !== candidate.id
    || typeof candidate.mimeType !== "string"
    || !(CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
      candidate.mimeType,
    )
    || typeof candidate.size !== "number"
    || !Number.isSafeInteger(candidate.size)
    || candidate.size <= 0
    || candidate.size > MAX_CHAT_ATTACHMENT_BYTES
  ) return null;
  const attachment = candidate as unknown as ChatAttachment;
  return chatAttachmentKind(attachment.mimeType) === "image"
    ? attachment
    : null;
}

function queuedAttachments(value: unknown): ChatAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) return null;
  const attachments: ChatAttachment[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const valueAttachment of value) {
    const attachment = queuedAttachment(valueAttachment);
    if (!attachment || ids.has(attachment.id)) return null;
    totalBytes += attachment.size;
    if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) return null;
    ids.add(attachment.id);
    attachments.push(attachment);
  }
  return attachments;
}

function queuedPrompt(
  value: unknown,
  expected: "text" | "media",
): ComposerQueuedPrompt | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.id !== "string"
    || candidate.id.length === 0
    || candidate.id.length > MAX_PROMPT_ID_CHARS
    || typeof candidate.content !== "string"
    || candidate.content.trim().length === 0
    || candidate.content.length > MAX_QUEUED_CONTENT_CHARS
    || typeof candidate.createdAt !== "string"
    || !Number.isFinite(Date.parse(candidate.createdAt))
  ) return null;
  const attachments = queuedAttachments(candidate.attachments);
  if (
    !attachments
    || (expected === "text" && attachments.length !== 0)
    || (expected === "media" && attachments.length === 0)
  ) return null;
  return {
    id: candidate.id,
    content: candidate.content,
    createdAt: candidate.createdAt,
    attachments,
  };
}

function parseQueue(
  value: string | null,
  expected: "text" | "media",
): ComposerQueuedPrompt[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  const prompts: ComposerQueuedPrompt[] = [];
  const ids = new Set<string>();
  for (const entry of parsed) {
    const prompt = queuedPrompt(entry, expected);
    if (!prompt || ids.has(prompt.id)) continue;
    ids.add(prompt.id);
    prompts.push(prompt);
    // Older builds allowed ten text entries. Preserve those drafts so an
    // upgrade drains them instead of silently deleting entries four to ten.
    if (prompts.length === MAX_STORED_QUEUE_ENTRIES) break;
  }
  return prompts;
}

function orderedUniqueQueue(
  textPrompts: readonly ComposerQueuedPrompt[],
  mediaPrompts: readonly ComposerQueuedPrompt[],
): ComposerQueuedPrompt[] {
  const promptIds = new Set<string>();
  const attachmentIds = new Set<string>();
  return [...textPrompts, ...mediaPrompts]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .filter((prompt) => {
      if (
        promptIds.has(prompt.id)
        || prompt.attachments.some(({ id }) => attachmentIds.has(id))
      ) return false;
      promptIds.add(prompt.id);
      for (const attachment of prompt.attachments) attachmentIds.add(attachment.id);
      return true;
    });
}

function setStoredQueue(
  storage: Storage,
  key: string,
  prompts: readonly ComposerQueuedPrompt[],
): void {
  if (prompts.length > 0) storage.setItem(key, JSON.stringify(prompts));
  else storage.removeItem(key);
}

function storeQueue(
  conversationId: string,
  prompts: readonly ComposerQueuedPrompt[],
  notify: boolean,
): void {
  const mediaPrompts = prompts.filter(({ attachments }) => attachments.length > 0);
  setStoredQueue(
    window.localStorage,
    composerQueueKey(conversationId),
    prompts.filter(({ attachments }) => attachments.length === 0),
  );
  setStoredQueue(
    window.sessionStorage,
    composerMediaQueueKey(conversationId),
    mediaPrompts,
  );
  if (notify) window.dispatchEvent(new Event(QUEUED_PROMPTS_CHANGED_EVENT));
}

export function readComposerQueue(
  conversationId: string,
): ComposerQueuedPrompt[] {
  try {
    const textKey = composerQueueKey(conversationId);
    let storedText = window.localStorage.getItem(textKey);
    if (storedText === null) {
      const legacyKey = legacyQueueKey(conversationId);
      const legacy = window.localStorage.getItem(legacyKey);
      if (legacy !== null) {
        const migrated = parseQueue(legacy, "text");
        setStoredQueue(window.localStorage, textKey, migrated);
        window.localStorage.removeItem(legacyKey);
        storedText = JSON.stringify(migrated);
      }
    }
    const mediaKey = composerMediaQueueKey(conversationId);
    const storedMedia = window.sessionStorage.getItem(mediaKey);
    const textPrompts = parseQueue(storedText, "text");
    const mediaPrompts = parseQueue(storedMedia, "media");
    const prompts = orderedUniqueQueue(textPrompts, mediaPrompts);
    const normalizedText = prompts.filter(({ attachments }) => attachments.length === 0);
    const normalizedMedia = prompts.filter(({ attachments }) => attachments.length > 0);
    if ((storedText ?? null) !== (normalizedText.length > 0
      ? JSON.stringify(normalizedText)
      : null)) {
      setStoredQueue(window.localStorage, textKey, normalizedText);
    }
    if ((storedMedia ?? null) !== (normalizedMedia.length > 0
      ? JSON.stringify(normalizedMedia)
      : null)) {
      setStoredQueue(window.sessionStorage, mediaKey, normalizedMedia);
    }
    return prompts;
  } catch {
    return [];
  }
}

export function composerQueueHasCapacity(conversationId: string): boolean {
  return readComposerQueue(conversationId).length
    < MAX_COMPOSER_QUEUED_PROMPTS;
}

export function composerQueuedAttachmentCount(conversationId: string): number {
  return readComposerQueue(conversationId).reduce(
    (total, prompt) => total + prompt.attachments.length,
    0,
  );
}

export function enqueueComposerPrompt(
  conversationId: string,
  content: string,
  attachments: readonly ChatAttachment[] = [],
): boolean {
  try {
    const current = readComposerQueue(conversationId);
    if (current.length >= MAX_COMPOSER_QUEUED_PROMPTS) return false;
    const createdAtMs = Math.max(
      Date.now(),
      ...current.map(({ createdAt }) => Date.parse(createdAt) + 1),
    );
    const candidate = queuedPrompt({
      id: window.crypto.randomUUID(),
      content,
      createdAt: new Date(createdAtMs).toISOString(),
      attachments,
    }, attachments.length > 0 ? "media" : "text");
    if (!candidate) return false;
    const attachmentIds = new Set(
      current.flatMap((prompt) => prompt.attachments.map(({ id }) => id)),
    );
    if (candidate.attachments.some(({ id }) => attachmentIds.has(id))) {
      return false;
    }
    storeQueue(conversationId, [...current, candidate], true);
    return true;
  } catch {
    return false;
  }
}

export function removeComposerQueuedPrompt(
  conversationId: string,
  promptId: string,
): ComposerQueuedPrompt | null {
  try {
    const current = readComposerQueue(conversationId);
    const removed = current.find(({ id }) => id === promptId) ?? null;
    if (!removed) return null;
    storeQueue(
      conversationId,
      current.filter(({ id }) => id !== promptId),
      true,
    );
    return removed;
  } catch {
    return null;
  }
}

export function takeAllSessionQueuedMedia(): ComposerQueuedPrompt[] {
  const removed: ComposerQueuedPrompt[] = [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key && composerMediaQueueConversationId(key) !== null) keys.push(key);
    }
    for (const key of keys) {
      removed.push(...parseQueue(window.sessionStorage.getItem(key), "media"));
      window.sessionStorage.removeItem(key);
    }
  } catch {
    return removed;
  }
  return removed;
}

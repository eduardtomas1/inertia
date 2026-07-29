import { clientCommandSchema } from "@shared/contracts";
import type {
  ClientCommand,
  Conversation,
} from "@shared/contracts";

import { buildDraftConversation } from "../lib/newConversation";

type ConversationCreatePayload = Extract<
  ClientCommand,
  { type: "conversation.create" }
>["payload"];

export interface PersistedDraftConversation {
  conversation: Conversation;
  payload: ConversationCreatePayload;
}

const STORAGE_KEY = "inertia:new-project-conversation-draft:v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export function readPersistedDraftConversation():
  PersistedDraftConversation | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const candidate = JSON.parse(raw) as {
      version?: unknown;
      conversationId?: unknown;
      createdAt?: unknown;
      payload?: unknown;
    };
    if (
      candidate.version !== 1
      || typeof candidate.conversationId !== "string"
      || !UUID_PATTERN.test(candidate.conversationId)
      || typeof candidate.createdAt !== "string"
      || !Number.isFinite(Date.parse(candidate.createdAt))
    ) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    const parsed = clientCommandSchema.safeParse({
      requestId: crypto.randomUUID(),
      type: "conversation.create",
      payload: candidate.payload,
    });
    if (!parsed.success || parsed.data.type !== "conversation.create") {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return {
      payload: parsed.data.payload,
      conversation: buildDraftConversation(parsed.data.payload, {
        id: candidate.conversationId,
        now: candidate.createdAt,
      }),
    };
  } catch {
    return null;
  }
}

export function writePersistedDraftConversation(
  draft: PersistedDraftConversation,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        conversationId: draft.conversation.id,
        createdAt: draft.conversation.createdAt,
        payload: draft.payload,
      }),
    );
  } catch {
    // The in-memory draft remains usable when browser storage is unavailable.
  }
}

export function forgetPersistedDraftConversation(
  conversationId: string,
): void {
  const stored = readPersistedDraftConversation();
  if (stored?.conversation.id !== conversationId) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // An inaccessible storage area cannot expose a recoverable draft either.
  }
}

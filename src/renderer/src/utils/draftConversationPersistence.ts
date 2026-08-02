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

export interface PersistedMaterializedDraftConversation {
  acceptedTurnId: string | null;
  acceptedUserMessageId: string | null;
  draftConversationId: string;
  materializedConversationId: string;
  conversation: Conversation;
  payload: ConversationCreatePayload;
}

const STORAGE_KEY = "inertia:new-project-conversation-draft:v1";
const MATERIALIZED_STORAGE_KEY =
  "inertia:new-project-conversation-materialized:v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const MAX_ACCEPTED_ID_LENGTH = 200;

function isAcceptedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ACCEPTED_ID_LENGTH
    && !value.includes("\0");
}

function readPersistedDraftRecord(): PersistedDraftConversation | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const candidate = JSON.parse(raw) as {
    version?: unknown;
    state?: unknown;
    conversationId?: unknown;
    createdAt?: unknown;
    payload?: unknown;
  };
  if (
    (candidate.version !== 1 && candidate.version !== 2)
    || (
      candidate.version === 2
      && candidate.state !== "draft"
    )
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
}

export function readPersistedDraftConversation():
  PersistedDraftConversation | null {
  try {
    const draft = readPersistedDraftRecord();
    const materialized = readPersistedMaterializedDraftConversation();
    return (
      draft
      && materialized?.draftConversationId !== draft.conversation.id
    )
      ? draft
      : null;
  } catch {
    return null;
  }
}

export function readPersistedMaterializedDraftConversation():
  PersistedMaterializedDraftConversation | null {
  try {
    const raw = window.localStorage.getItem(MATERIALIZED_STORAGE_KEY);
    if (!raw) return null;
    const candidate = JSON.parse(raw) as {
      version?: unknown;
      acceptedTurnId?: unknown;
      acceptedUserMessageId?: unknown;
      draftConversationId?: unknown;
      conversationId?: unknown;
      projectId?: unknown;
      createdAt?: unknown;
      payload?: unknown;
    };
    if (
      candidate.version !== 1
      && candidate.version !== 2
    ) {
      window.localStorage.removeItem(MATERIALIZED_STORAGE_KEY);
      return null;
    }
    const acceptedTurnId = candidate.version === 2
      ? candidate.acceptedTurnId
      : null;
    const acceptedUserMessageId = candidate.version === 2
      ? candidate.acceptedUserMessageId
      : null;
    if (
      (
        acceptedTurnId !== null
        && !isAcceptedId(acceptedTurnId)
      )
      || (
        acceptedUserMessageId !== null
        && !isAcceptedId(acceptedUserMessageId)
      )
      || (acceptedTurnId === null) !== (acceptedUserMessageId === null)
      || typeof candidate.draftConversationId !== "string"
      || !UUID_PATTERN.test(candidate.draftConversationId)
      || typeof candidate.conversationId !== "string"
      || !UUID_PATTERN.test(candidate.conversationId)
      || typeof candidate.projectId !== "string"
      || !UUID_PATTERN.test(candidate.projectId)
      || typeof candidate.createdAt !== "string"
      || !Number.isFinite(Date.parse(candidate.createdAt))
    ) {
      window.localStorage.removeItem(MATERIALIZED_STORAGE_KEY);
      return null;
    }
    const parsed = clientCommandSchema.safeParse({
      requestId: crypto.randomUUID(),
      type: "conversation.create",
      payload: candidate.payload,
    });
    if (
      !parsed.success
      || parsed.data.type !== "conversation.create"
      || parsed.data.payload.projectId !== candidate.projectId
    ) {
      window.localStorage.removeItem(MATERIALIZED_STORAGE_KEY);
      return null;
    }
    return {
      acceptedTurnId,
      acceptedUserMessageId,
      draftConversationId: candidate.draftConversationId,
      materializedConversationId: candidate.conversationId,
      payload: parsed.data.payload,
      conversation: buildDraftConversation(parsed.data.payload, {
        id: candidate.draftConversationId,
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
        version: 2,
        state: "draft",
        conversationId: draft.conversation.id,
        createdAt: draft.conversation.createdAt,
        payload: draft.payload,
      }),
    );
  } catch {
    // The in-memory draft remains usable when browser storage is unavailable.
  }
}

export function markPersistedDraftConversationMaterialized(
  materialized: PersistedMaterializedDraftConversation,
): void {
  try {
    window.localStorage.setItem(
      MATERIALIZED_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        acceptedTurnId: materialized.acceptedTurnId,
        acceptedUserMessageId: materialized.acceptedUserMessageId,
        draftConversationId: materialized.draftConversationId,
        conversationId: materialized.materializedConversationId,
        projectId: materialized.conversation.projectId,
        createdAt: materialized.conversation.createdAt,
        payload: materialized.payload,
      }),
    );
  } catch {
    // The server-owned conversation remains authoritative without storage.
  }
}

export function markPersistedMaterializedDraftConversationAccepted(
  conversationId: string,
  turnId: string,
  userMessageId: string,
): void {
  try {
    const stored = readPersistedMaterializedDraftConversation();
    if (
      stored?.materializedConversationId !== conversationId
      || !isAcceptedId(turnId)
      || !isAcceptedId(userMessageId)
    ) return;
    markPersistedDraftConversationMaterialized({
      ...stored,
      acceptedTurnId: turnId,
      acceptedUserMessageId: userMessageId,
    });
  } catch {
    // The in-memory acceptance still prevents a duplicate first send.
  }
}

export function forgetPersistedDraftConversation(
  conversationId: string,
): void {
  try {
    const stored = readPersistedDraftRecord();
    if (stored?.conversation.id !== conversationId) return;
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // An inaccessible storage area cannot expose a recoverable draft either.
  }
}

export function forgetPersistedMaterializedDraftConversation(
  conversationId: string,
): void {
  try {
    const stored = readPersistedMaterializedDraftConversation();
    if (stored?.materializedConversationId !== conversationId) return;
    forgetPersistedDraftConversation(stored.draftConversationId);
    window.localStorage.removeItem(
      `inertia:draft:${stored.draftConversationId}`,
    );
    window.localStorage.removeItem(MATERIALIZED_STORAGE_KEY);
  } catch {
    // Reconciliation can retry after the next authoritative snapshot.
  }
}

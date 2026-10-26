import {
  COMPACT_ON_RETURN_SETTINGS,
  CONVERSATION_COMPACTION_STATES,
  PROMPT_CACHE_FACT_SOURCES,
  type ConversationCompactionState,
  type PromptCacheFacts,
} from "../compact-on-return";
import { CONTEXT_COMPACTION_TRIGGERS, isContextCompaction } from "../context-compaction";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function includes(options: readonly string[], value: unknown): boolean {
  return typeof value === "string" && options.includes(value);
}

export function isPromptCacheFacts(value: unknown): value is PromptCacheFacts {
  return record(value)
    && (value.lastRequestStartedAt === null || timestamp(value.lastRequestStartedAt))
    && (value.lifetimeMs === null
      || (Number.isSafeInteger(value.lifetimeMs) && Number(value.lifetimeMs) > 0))
    && includes(PROMPT_CACHE_FACT_SOURCES, value.source);
}

export function isConversationCompactionState(value: unknown): value is ConversationCompactionState {
  if (!record(value) || !includes(CONVERSATION_COMPACTION_STATES, value.state)) return false;
  return value.state === "idle"
    ? value.trigger === null && value.startedAt === null
    : includes(CONTEXT_COMPACTION_TRIGGERS, value.trigger) && timestamp(value.startedAt);
}

export function validCompactOnReturnSetting(settings: UnknownRecord): boolean {
  return settings.compactOnReturn === undefined
    || includes(COMPACT_ON_RETURN_SETTINGS, settings.compactOnReturn);
}

function compactAndSendResult(value: UnknownRecord): boolean {
  if (typeof value.conversationId !== "string") return false;
  if (value.outcome === "compaction-failed") return typeof value.message === "string";
  return value.outcome === "sent"
    && typeof value.turnId === "string"
    && typeof value.userMessageId === "string"
    && includes(["new-turn", "follow-up"], value.disposition)
    && isContextCompaction(value.compaction)
    && value.compaction.trigger === "on-return";
}

export const compactOnReturnResultValidators = {
  "conversation.compact-and-send": compactAndSendResult,
} as const;

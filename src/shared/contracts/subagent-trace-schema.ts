import type { ProviderId } from "../provider";
import type { SubagentTaskUsage } from "./agent";
import { SERVER_EVENT_OPTIONS } from "./server-event-discriminants";

type UnknownRecord = Record<string, unknown>;

const PROVIDER_IDS: readonly string[] = Object.keys({
  codex: true,
  claude: true,
  cursor: true,
  kimi: true,
  opencode: true,
  antigravity: true,
} satisfies Record<ProviderId, true>);

const SUBAGENT_STATUSES: readonly string[] = SERVER_EVENT_OPTIONS.subagentStatuses;

const REQUIRED_STRINGS = [
  "id", "conversationId", "runId", "turnId", "providerId", "status",
  "createdAt", "updatedAt",
] as const;

const NULLABLE_STRINGS = [
  "providerTaskId", "providerAgentId", "parentTraceId",
  "parentProviderAgentId", "parentProviderToolUseId", "providerToolUseId",
  "providerRole", "providerName", "providerStatus", "description",
  "progress", "result",
] as const;

const USAGE_KEYS = Object.keys({
  totalTokens: true,
  inputTokens: true,
  cachedInputTokens: true,
  cacheWriteInputTokens: true,
  outputTokens: true,
  reasoningOutputTokens: true,
  contextTokens: true,
  maxContextTokens: true,
} satisfies Record<keyof SubagentTaskUsage, true>);

const MAX_LABEL_CHARS = 200;
const MAX_TOKEN_COUNT = 1_000_000_000_000;
const MAX_TOOL_USE_COUNT = 1_000_000;
const MAX_DURATION_MS = 31 * 24 * 60 * 60 * 1_000;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function nullableInteger(value: unknown, minimum: number, maximum: number): boolean {
  return value === null || boundedInteger(value, minimum, maximum);
}

function nullableLabel(value: unknown): boolean {
  return value === null || (typeof value === "string"
    && value.length > 0
    && value.length <= MAX_LABEL_CHARS);
}

function subagentTaskUsage(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== USAGE_KEYS.length || !USAGE_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  const { contextTokens, maxContextTokens } = value;
  return USAGE_KEYS.every((key) => key === "maxContextTokens"
    ? nullableInteger(value[key], 1, MAX_TOKEN_COUNT)
    : nullableInteger(value[key], 0, MAX_TOKEN_COUNT))
    && (typeof contextTokens !== "number"
      || typeof maxContextTokens !== "number"
      || contextTokens <= maxContextTokens);
}

export function subagentTrace(value: unknown): boolean {
  if (!record(value)) return false;
  return REQUIRED_STRINGS.every((key) => typeof value[key] === "string")
    && NULLABLE_STRINGS.every((key) => value[key] === null || typeof value[key] === "string")
    && PROVIDER_IDS.includes(value.providerId as string)
    && SUBAGENT_STATUSES.includes(value.status as string)
    && typeof value.isLive === "boolean"
    && Number.isSafeInteger(value.sequence)
    && nullableLabel(value.model)
    && nullableLabel(value.activity)
    && subagentTaskUsage(value.usage)
    && nullableInteger(value.toolUseCount, 0, MAX_TOOL_USE_COUNT)
    && nullableInteger(value.durationMs, 0, MAX_DURATION_MS);
}

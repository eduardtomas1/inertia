import type { ProviderId } from "../provider";
import {
  MAX_SUBAGENT_ACTIVITY_ID_CHARS,
  MAX_SUBAGENT_COMMAND_CHARS,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_LABEL_CHARS,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_STEP_LABEL_CHARS,
  MAX_SUBAGENT_STEPS,
} from "../subagent-task-limits";
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
  grok: true,
} satisfies Record<ProviderId, true>);

const SUBAGENT_STATUSES: readonly string[] = SERVER_EVENT_OPTIONS.subagentStatuses;
const SUBAGENT_TASK_KINDS: readonly string[] = SERVER_EVENT_OPTIONS.subagentTaskKinds;
const SUBAGENT_TASK_EFFORTS: readonly string[] = SERVER_EVENT_OPTIONS.subagentTaskEfforts;
const SUBAGENT_STEP_STATUSES: readonly string[] = SERVER_EVENT_OPTIONS.subagentStepStatuses;
const SUBAGENT_MODEL_SOURCES: readonly string[] = SERVER_EVENT_OPTIONS.subagentModelSources;

const REQUIRED_STRINGS = [
  "id", "conversationId", "runId", "turnId", "providerId", "status",
  "createdAt", "updatedAt",
] as const;

const NULLABLE_STRINGS = [
  "providerTaskId", "providerAgentId", "parentTraceId",
  "parentProviderAgentId", "parentProviderToolUseId", "providerToolUseId",
  "providerRole", "providerName", "providerStatus",
] as const;

const BOUNDED_TEXTS = [
  ["description", MAX_SUBAGENT_DESCRIPTION_CHARS],
  ["progress", MAX_SUBAGENT_PROGRESS_CHARS],
  ["result", MAX_SUBAGENT_RESULT_CHARS],
  ["command", MAX_SUBAGENT_COMMAND_CHARS],
  ["activityId", MAX_SUBAGENT_ACTIVITY_ID_CHARS],
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
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

function nullableText(value: unknown, maxChars: number): boolean {
  return value === null || (typeof value === "string"
    && value.length > 0
    && value.length <= maxChars);
}

function nullableLabel(value: unknown): boolean {
  return nullableText(value, MAX_SUBAGENT_LABEL_CHARS);
}

function subagentTaskSteps(value: unknown): boolean {
  if (value === null) return true;
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_SUBAGENT_STEPS
    && value.every((step) => record(step)
      && Object.keys(step).length === 2
      && typeof step.label === "string"
      && step.label.length > 0
      && step.label.length <= MAX_SUBAGENT_STEP_LABEL_CHARS
      && SUBAGENT_STEP_STATUSES.includes(step.status as string));
}

function subagentTaskUsage(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value)) return false;
  const { contextTokens, maxContextTokens } = value;
  return USAGE_KEYS.every((key) =>
    nullableInteger(value[key], key === "maxContextTokens" ? 1 : 0, MAX_TOKEN_COUNT))
    && (typeof contextTokens !== "number"
      || typeof maxContextTokens !== "number"
      || contextTokens <= maxContextTokens);
}

export function subagentTrace(value: unknown): boolean {
  if (!record(value)) return false;
  return REQUIRED_STRINGS.every((key) => typeof value[key] === "string")
    && NULLABLE_STRINGS.every((key) => value[key] === null || typeof value[key] === "string")
    && BOUNDED_TEXTS.every(([key, maxChars]) => nullableText(value[key], maxChars))
    && PROVIDER_IDS.includes(value.providerId as string)
    && SUBAGENT_STATUSES.includes(value.status as string)
    && typeof value.isLive === "boolean"
    && Number.isSafeInteger(value.sequence)
    && nullableLabel(value.model)
    && nullableLabel(value.activity)
    && subagentTaskUsage(value.usage)
    && nullableInteger(value.toolUseCount, 0, MAX_TOOL_USE_COUNT)
    && nullableInteger(value.durationMs, 0, MAX_DURATION_MS)
    && SUBAGENT_TASK_KINDS.includes(value.taskKind as string)
    && (value.background === null || typeof value.background === "boolean")
    && (value.effort === null || SUBAGENT_TASK_EFFORTS.includes(value.effort as string))
    && (value.modelSource === null || SUBAGENT_MODEL_SOURCES.includes(value.modelSource as string))
    && subagentTaskSteps(value.steps)
    && (value.customAgentId === undefined || value.customAgentId === null
      || (typeof value.customAgentId === "string" && UUID.test(value.customAgentId)));
}

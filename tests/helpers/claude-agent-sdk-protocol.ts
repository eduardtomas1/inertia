import type { UUID } from "node:crypto";

import type {
  ModelUsage,
  NonNullableUsage,
  Query,
  SDKMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultError,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";

type ClaudeIterationUsage = NonNullable<NonNullableUsage["iterations"]>[number];

export const CLAUDE_PROTOCOL_SESSION_ID =
  "47474747-4747-4747-8747-474747474747";

let fixtureSequence = 0;

function claudeFixtureUuid(): UUID {
  fixtureSequence += 1;
  return `00000000-0000-4000-8000-${fixtureSequence.toString(16).padStart(12, "0")}`;
}

export function claudeUsage(
  overrides: Partial<NonNullableUsage> = {},
): NonNullableUsage {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: null,
    inference_geo: "",
    input_tokens: 1,
    iterations: [],
    output_tokens: 1,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
    ...overrides,
  };
}

export function claudeIterationUsage(
  type: ClaudeIterationUsage["type"],
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
): ClaudeIterationUsage {
  const tokens = {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheReadInputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  return type === "compaction"
    ? { ...tokens, type }
    : { ...tokens, model: "claude-test", type };
}

export function claudeModelUsage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    ...overrides,
  };
}

export function claudeBackgroundTasks(
  taskIds: readonly string[],
): SDKMessage {
  return claudeSystem("background_tasks_changed", {
    tasks: taskIds.map((taskId) => ({
      task_id: taskId,
      task_type: "local_agent",
      description: `Delegate ${taskId}`,
    })),
  });
}

export function claudeSessionState(
  state: "idle" | "running" | "requires_action",
): SDKMessage {
  return claudeSystem("session_state_changed", { state });
}

export function claudeSystem(
  subtype: string,
  fields: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: "system",
    subtype,
    uuid: claudeFixtureUuid(),
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    ...fields,
  } as unknown as SDKMessage;
}

export function claudeSuccessResult(
  result: string,
  terminalReason?: "background_requested" | "completed",
): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    uuid: claudeFixtureUuid(),
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    result,
    ...(terminalReason ? { terminal_reason: terminalReason } : {}),
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: claudeUsage(),
    modelUsage: {},
    permission_denials: [],
  };
}

export function claudeErrorResult(
  subtype: SDKResultError["subtype"],
  errors: string[],
): SDKResultError {
  return {
    type: "result",
    subtype,
    uuid: claudeFixtureUuid(),
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    errors,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: claudeUsage(),
    modelUsage: {},
    permission_denials: [],
  };
}

export function claudeRateLimitEvent(
  rateLimitInfo: SDKRateLimitInfo,
): SDKRateLimitEvent {
  return {
    type: "rate_limit_event",
    uuid: claudeFixtureUuid(),
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    rate_limit_info: rateLimitInfo,
  };
}

export function fixtureClaudeQuery(
  stream: AsyncGenerator<SDKMessage>,
  methods: Partial<Query> = {},
): Query {
  return Object.assign(stream, {
    supportedModels: async () => [],
    interrupt: async () => undefined,
    close: () => undefined,
    ...methods,
  }) as unknown as Query;
}

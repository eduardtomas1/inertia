import type {
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_PROTOCOL_SESSION_ID =
  "47474747-4747-4747-8747-474747474747";

let fixtureSequence = 0;

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
  fixtureSequence += 1;
  return {
    type: "system",
    subtype,
    uuid: `fixture-${fixtureSequence}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    ...fields,
  } as unknown as SDKMessage;
}

export function claudeSuccessResult(
  result: string,
  terminalReason?: "background_requested" | "completed",
): SDKMessage {
  fixtureSequence += 1;
  return {
    type: "result",
    subtype: "success",
    uuid: `fixture-${fixtureSequence}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    result,
    terminal_reason: terminalReason,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
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

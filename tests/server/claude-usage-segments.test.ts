// @inertia-test-suite portable
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import type { AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import type { ClaudeUsageSnapshot } from "../../src/server/provider/claude-usage";
import {
  CLAUDE_PROTOCOL_SESSION_ID as original,
  claudeBackgroundTasks,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

const replacement = "58585858-5858-4858-8858-585858585858";

function cumulativeResult(
  total: number | null,
  fields: Record<string, unknown> = {},
): SDKMessage {
  return {
    ...claudeSuccessResult("Done", "completed"),
    num_turns: 2,
    usage: { input_tokens: 300, output_tokens: 20 },
    modelUsage: total === null ? {} : {
      "claude-sonnet": {
        inputTokens: total - 1_500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 500,
        contextWindow: 200_000,
      },
      "claude-haiku": {
        inputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 100,
        contextWindow: 200_000,
      },
    },
    ...fields,
  } as unknown as SDKMessage;
}

const reset = {
  type: "conversation_reset",
  uuid: "99999999-9999-4999-8999-999999999999",
  session_id: original,
  new_conversation_id: "78787878-7878-4878-8878-787878787878",
} as unknown as SDKMessage;

async function usageSnapshots(
  messages: readonly SDKMessage[],
  sessionId?: string,
): Promise<ClaudeUsageSnapshot[]> {
  const events: AgentHarnessEvent[] = [];
  const harness = createClaudeAgentSdkHarness({
    createQuery: () => fixtureClaudeQuery((async function* () { yield* messages; })()),
  });
  const result = await harness.start({
    input: nativeProviderRunInput({
      providerId: "claude", conversationId: "claude-usage-segments", cwd: process.cwd(),
      prompt: "Account for usage", access: "supervised", interactionMode: "build",
      ...(sessionId ? { sessionId } : {}),
    }),
    executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    callbacks: { onEvent: (event) => events.push(event) },
  }).result;
  expect(result.status).toBe("completed");
  return events.flatMap((event) =>
    event.type === "extension" && event.event.type === "usage" ? [event.event.usage] : []);
}

describe("Claude cumulative usage segments", () => {
  it("labels subagent-inclusive cumulative totals as session usage without adding the main loop", async () => {
    const snapshots = await usageSnapshots(
      [claudeSystem("init"), cumulativeResult(15_000)],
      original,
    );
    expect(snapshots.at(-1)).toMatchObject({
      totalProcessedTokens: 15_000,
      totalProcessedScope: "session",
      inputTokens: 14_400,
      outputTokens: 600,
    });
  });

  it("keeps a verified cumulative total when a later result reports missing or zero counters", async () => {
    const snapshots = await usageSnapshots([
      claudeSystem("init"),
      claudeBackgroundTasks(["agent-1"]),
      cumulativeResult(9_000),
      claudeBackgroundTasks([]),
      claudeSystem("task_notification", { task_id: "agent-1", status: "completed" }),
      cumulativeResult(null, { usage: { input_tokens: 0, output_tokens: 0 } }),
    ], original);
    expect(snapshots.at(-1)).toMatchObject({
      totalProcessedTokens: 9_000,
      totalProcessedScope: "session",
      outputTokens: 600,
    });
  });

  it("starts a new cumulative segment after a provider session reset", async () => {
    const snapshots = await usageSnapshots([
      claudeSystem("init"),
      claudeBackgroundTasks(["agent-1"]),
      cumulativeResult(12_000),
      claudeBackgroundTasks([]),
      claudeSystem("task_notification", { task_id: "agent-1", status: "completed" }),
      reset,
      cumulativeResult(2_000, { session_id: replacement }),
    ], original);
    expect(snapshots.at(-1)).toMatchObject({
      totalProcessedTokens: 2_000,
      totalProcessedScope: "session",
    });
  });

  it("keeps a fresh run's total unknown when a reset discards its earlier segment", async () => {
    const snapshots = await usageSnapshots([
      claudeSystem("init"),
      reset,
      cumulativeResult(2_000, { session_id: replacement }),
    ]);
    expect(snapshots.at(-1)).toMatchObject({
      totalProcessedTokens: null,
      totalProcessedScope: null,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("keeps main-loop-only usage run-local", async () => {
    const snapshots = await usageSnapshots(
      [claudeSystem("init"), cumulativeResult(null)],
      original,
    );
    expect(snapshots.at(-1)).toMatchObject({
      totalProcessedTokens: 320,
      totalProcessedScope: "run",
    });
  });
});

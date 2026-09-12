import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import type { AgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { ClaudeMessageProjector } from "../../src/server/provider/claude-message-projector";

const rateLimitEvent = {
  type: "rate_limit_event",
  session_id: "33333333-3333-4333-8333-333333333333",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "five_hour",
    utilization: 30,
    resetsAt: 1_893_456_000,
  },
} as unknown as SDKMessage;

function projector(usesNativeAnthropic: boolean): { calls: string[]; projector: ClaudeMessageProjector } {
  const calls: string[] = [];
  const emitter = {
    capability: (capabilityId: string, available: boolean) => {
      calls.push(`capability:${capabilityId}:${available}`);
    },
    rich: (event: { type: string }) => {
      calls.push(`rich:${event.type}`);
    },
  } as unknown as AgentHarnessEmitter;
  return {
    calls,
    projector: new ClaudeMessageProjector({
      emitter,
      text: {} as never,
      usesNativeAnthropic,
      contextUsage: () => null,
      acceptContextUsage: () => undefined,
      refreshContextUsage: () => undefined,
    }),
  };
}

describe("Claude rate-limit negotiation", () => {
  it("announces rate limits before every rate-limit metadata", () => {
    const { calls, projector: claude } = projector(true);
    claude.observe(rateLimitEvent, false);
    claude.observe(rateLimitEvent, false);
    // Re-announcing is idempotent for the run coordinator's negotiated set.
    expect(calls).toEqual([
      "capability:rate-limits:true",
      "rich:metadata",
      "capability:rate-limits:true",
      "rich:metadata",
    ]);
  });

  it("neither announces nor reports rate limits for a non-native backend", () => {
    const { calls, projector: claude } = projector(false);
    claude.observe(rateLimitEvent, false);
    expect(calls).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import type { SubagentTrace } from "../../src/shared/contracts";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";

const usage = {
  totalTokens: 1_200,
  inputTokens: 1_000,
  cachedInputTokens: 400,
  cacheWriteInputTokens: 0,
  outputTokens: 200,
  reasoningOutputTokens: 50,
  contextTokens: 9_000,
  maxContextTokens: 200_000,
};

const trace: SubagentTrace = {
  id: "trace-1",
  conversationId: "conversation-1",
  runId: "run-1",
  turnId: "turn-1",
  providerId: "codex",
  providerTaskId: null,
  providerAgentId: "agent-1",
  parentTraceId: null,
  parentProviderAgentId: null,
  parentProviderToolUseId: null,
  providerToolUseId: null,
  providerRole: null,
  providerName: "Reviewer",
  providerStatus: null,
  status: "running",
  isLive: true,
  description: null,
  progress: null,
  result: null,
  model: "gpt-5.4-mini",
  activity: "Reading files",
  usage,
  toolUseCount: 3,
  durationMs: 1_500,
  sequence: 1,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:01.000Z",
};

const accepts = (value: unknown) => {
  try {
    parseServerEvent({ type: "agent.subagent.updated", trace: value });
    return true;
  } catch {
    return false;
  }
};

describe("subagent trace wire validation", () => {
  it("accepts reported and unreported task telemetry", () => {
    expect(accepts(trace)).toBe(true);
    expect(accepts({
      ...trace,
      model: null,
      activity: null,
      usage: null,
      toolUseCount: null,
      durationMs: null,
    })).toBe(true);
    expect(accepts({
      ...trace,
      model: "m".repeat(200),
      activity: "a".repeat(200),
      usage: { ...usage, totalTokens: 1_000_000_000_000, contextTokens: null, maxContextTokens: null },
      toolUseCount: 1_000_000,
      durationMs: 31 * 24 * 60 * 60 * 1_000,
    })).toBe(true);
  });

  it.each([
    ["missing model", { model: undefined }],
    ["missing usage", { usage: undefined }],
    ["empty model", { model: "" }],
    ["long model", { model: "m".repeat(201) }],
    ["numeric activity", { activity: 7 }],
    ["long activity", { activity: "a".repeat(201) }],
    ["usage array", { usage: [] }],
    ["usage missing a field", { usage: { ...usage, reasoningOutputTokens: undefined } }],
    ["usage extra field", { usage: { ...usage, costUsd: 1 } }],
    ["negative tokens", { usage: { ...usage, inputTokens: -1 } }],
    ["fractional tokens", { usage: { ...usage, outputTokens: 1.5 } }],
    ["too many tokens", { usage: { ...usage, totalTokens: 1_000_000_000_001 } }],
    ["string tokens", { usage: { ...usage, totalTokens: "12" } }],
    ["zero context window", { usage: { ...usage, contextTokens: 0, maxContextTokens: 0 } }],
    ["context above window", { usage: { ...usage, contextTokens: 300_000 } }],
    ["negative tool uses", { toolUseCount: -1 }],
    ["too many tool uses", { toolUseCount: 1_000_001 }],
    ["fractional duration", { durationMs: 1.5 }],
    ["duration over 31 days", { durationMs: 31 * 24 * 60 * 60 * 1_000 + 1 }],
  ])("rejects %s", (_label, patch) => {
    expect(accepts({ ...trace, ...patch })).toBe(false);
  });
});

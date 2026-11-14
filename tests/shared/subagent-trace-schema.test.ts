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
  modelSource: "observed",
  taskKind: "agent",
  background: true,
  command: null,
  effort: "high",
  activityId: "activity-1",
  steps: [
    { label: "Read · src/index.ts", status: "completed" },
    { label: "Bash · npm test", status: "running" },
  ],
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

  it("accepts an absent, null or UUID custom agent identity", () => {
    expect(accepts({ ...trace, customAgentId: null })).toBe(true);
    expect(accepts({ ...trace, customAgentId: "6f1c2a64-5d1e-4c55-9d43-1a2b3c4d5e6f" })).toBe(true);
  });

  it("accepts every task shape within its bounds", () => {
    expect(accepts({
      ...trace,
      taskKind: "shell",
      background: null,
      command: "c".repeat(4_000),
      effort: null,
      activityId: null,
      steps: null,
      description: "d".repeat(4_000),
      progress: "p".repeat(4_000),
      result: "r".repeat(16_000),
    })).toBe(true);
    for (const taskKind of ["agent", "workflow", "shell", "monitor", "remote", "mcp"]) {
      expect(accepts({ ...trace, taskKind })).toBe(true);
    }
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(accepts({ ...trace, effort })).toBe(true);
    }
    expect(accepts({
      ...trace,
      activityId: "a".repeat(200),
      steps: Array.from({ length: 8 }, (_, index) => ({
        label: `${index}`.padEnd(200, "x"),
        status: index % 3 === 0 ? "failed" : "completed",
      })),
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
    ["empty custom agent identity", { customAgentId: "" }],
    ["non-UUID custom agent identity", { customAgentId: "agent-reviewer-0000000000000000000000" }],
    ["numeric custom agent identity", { customAgentId: 7 }],
    ["missing task kind", { taskKind: undefined }],
    ["unknown task kind", { taskKind: "daemon" }],
    ["string background", { background: "yes" }],
    ["missing background", { background: undefined }],
    ["long command", { command: "c".repeat(4_001) }],
    ["empty command", { command: "" }],
    ["unknown effort", { effort: "extreme" }],
    ["unknown model source", { modelSource: "guessed" }],
    ["missing model source", { modelSource: undefined }],
    ["long activity id", { activityId: "a".repeat(201) }],
    ["empty steps", { steps: [] }],
    ["nine steps", { steps: Array.from({ length: 9 }, () => ({ label: "Read", status: "completed" })) }],
    ["long step label", { steps: [{ label: "s".repeat(201), status: "running" }] }],
    ["empty step label", { steps: [{ label: "", status: "running" }] }],
    ["unknown step status", { steps: [{ label: "Read", status: "queued" }] }],
    ["step with extra fields", { steps: [{ label: "Read", status: "running", output: "secret" }] }],
    ["long description", { description: "d".repeat(4_001) }],
    ["long progress", { progress: "p".repeat(4_001) }],
    ["long result", { result: "r".repeat(16_001) }],
  ])("rejects %s", (_label, patch) => {
    expect(accepts({ ...trace, ...patch })).toBe(false);
  });
});

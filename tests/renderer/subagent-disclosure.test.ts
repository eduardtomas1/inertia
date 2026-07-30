import { describe, expect, it } from "vitest";

import type {
  AgentTurn,
  SubagentTrace,
} from "../../src/shared/contracts";
import {
  canStopSubagentTrace,
  subagentDisclosureRows,
  subagentDisclosureSummary,
  subagentStatusLabel,
} from "../../src/renderer/src/utils/subagentDisclosure";

function trace(
  update: Partial<SubagentTrace> = {},
): SubagentTrace {
  return {
    id: "trace-parent",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerId: "claude",
    providerTaskId: "task-parent",
    providerAgentId: "agent-parent",
    parentTraceId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-parent",
    providerRole: "researcher",
    providerName: "Evidence",
    providerStatus: null,
    status: "running",
    description: "Inspect",
    progress: null,
    result: null,
    sequence: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

function turn(
  update: Partial<AgentTurn> = {},
): AgentTurn {
  return {
    id: "turn-1",
    conversationId: "conversation-1",
    runId: "run-1",
    userMessageId: "message-1",
    terminalAssistantMessageId: null,
    providerId: "claude",
    modelSelection: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendProfileDisplayName: "Claude",
      backendConfigurationRevision: 0,
      modelId: "sonnet",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendConfigurationRevision: 0,
      endpointIdentity: "native:claude",
      modelIdentity: null,
    },
    harnessId: "claude-agent-sdk",
    backendProfileId: "builtin:claude",
    model: "sonnet",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2030-01-01T00:00:00.000Z",
    startedAt: "2030-01-01T00:00:00.000Z",
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 0,
    association: "authoritative",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

describe("inline delegated-agent disclosure", () => {
  it("preserves parent-child order and bounds malformed nesting", () => {
    const parent = trace();
    const child = trace({
      id: "trace-child",
      providerTaskId: "task-child",
      providerAgentId: "agent-child",
      parentTraceId: parent.id,
      parentProviderAgentId: parent.providerAgentId,
      providerToolUseId: "tool-child",
      sequence: 2,
    });
    expect(subagentDisclosureRows([parent, child], [turn()])).toMatchObject([
      { trace: { id: "trace-parent" }, depth: 0, canStop: true },
      { trace: { id: "trace-child" }, depth: 1, canStop: true },
    ]);
    expect(subagentDisclosureSummary([parent, child])).toBe(
      "2 delegated tasks · 2 active",
    );
  });

  it("derives Stop only from the current persisted Claude SDK route", () => {
    const live = trace();
    expect(canStopSubagentTrace(live, [turn()])).toBe(true);
    expect(canStopSubagentTrace(live, [
      turn({ harnessId: "claude-cli" }),
    ])).toBe(false);
    expect(canStopSubagentTrace(
      trace({ providerTaskId: null }),
      [turn()],
    )).toBe(false);
    expect(canStopSubagentTrace(
      trace({ status: "completed" }),
      [turn()],
    )).toBe(false);
    expect(canStopSubagentTrace(live, [
      turn({
        status: "completed",
        completedAt: "2030-01-01T00:01:00.000Z",
      }),
    ])).toBe(false);
  });

  it("keeps future provider states visibly unknown instead of relabeling them", () => {
    expect(subagentStatusLabel(trace({
      providerId: "codex",
      providerStatus: "futureState",
      status: "unknown",
    }))).toBe("Unknown (futureState)");
    expect(subagentStatusLabel(trace({
      providerId: "claude",
      providerStatus: "killed",
      status: "cancelled",
    }))).toBe("Cancelled (killed)");
    expect(canStopSubagentTrace(
      trace({ providerStatus: "pending", status: "queued" }),
      [turn()],
    )).toBe(true);
  });
});

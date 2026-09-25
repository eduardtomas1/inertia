import { describe, expect, it, vi } from "vitest";

import type { SubagentTrace } from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import type {
  ProviderActivityEvent,
  ProviderSubagentEvent,
} from "../../src/server/provider/contracts";
import {
  TurnProviderEventProjector,
} from "../../src/server/runtime/turns/turn-provider-event-projector";
import type {
  ActiveTurn,
  TurnControllerHooks,
} from "../../src/server/runtime/turns/turn-controller-types";

function event(
  sequence: number,
  providerStatus: string,
  status: ProviderSubagentEvent["status"],
  isLive: boolean,
): ProviderSubagentEvent {
  return {
    providerId: "codex",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    type: "subagent",
    sequence,
    providerTaskId: null,
    providerAgentId: "child-1",
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "spawn-1",
    providerRole: "reviewer",
    providerName: "State reviewer",
    providerStatus,
    status,
    isLive,
    description: "Preserve exact state.",
    progress: null,
    result: status === "interrupted" ? "Provider interrupted the child." : null,
  };
}

describe("TurnProviderEventProjector delegated-agent state", () => {
  it("persists and broadcasts exact queued and interrupted provider states", () => {
    const upsertSubagentTrace = vi.fn((
      input: Parameters<RuntimeStore["upsertSubagentTrace"]>[0],
    ) => ({
      changed: true,
      trace: {
        ...input,
        id: "trace-1",
        parentTraceId: null,
        providerStatus: input.providerStatus ?? null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:01.000Z",
      } as SubagentTrace,
    }));
    const broadcast = vi.fn();
    const projector = new TurnProviderEventProjector({
      store: { upsertSubagentTrace } as unknown as RuntimeStore,
      hooks: {
        broadcast,
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      agentPlans: new Map(),
      streams: {} as never,
      activities: {} as never,
      interactions: {} as never,
      now: () => "2030-01-01T00:00:01.000Z",
      transition: () => false,
      observeSubagent: () => false,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: {
        id: "turn-1",
        runId: "run-1",
        providerId: "codex",
      },
    } as ActiveTurn;

    projector.project(active, event(1, "pendingInit", "queued", true));
    projector.project(active, event(2, "interrupted", "interrupted", false));

    expect(upsertSubagentTrace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerStatus: "pendingInit",
        status: "queued",
        isLive: true,
      }),
    );
    expect(upsertSubagentTrace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerStatus: "interrupted",
        status: "interrupted",
        isLive: false,
      }),
    );
    expect(broadcast).toHaveBeenLastCalledWith({
      type: "agent.subagent.updated",
      trace: expect.objectContaining({
        providerStatus: "interrupted",
        status: "interrupted",
      }),
    });
  });

  it("does not feed a rejected late descendant revival into run state", () => {
    const terminalTrace = {
      ...event(2, "interrupted", "interrupted", false),
      id: "trace-1",
      parentTraceId: null,
      providerStatus: "interrupted",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:01.000Z",
    } as SubagentTrace;
    const observeSubagent = vi.fn();
    const broadcast = vi.fn();
    const projector = new TurnProviderEventProjector({
      store: {
        upsertSubagentTrace: vi.fn(() => ({
          changed: false,
          trace: terminalTrace,
        })),
      } as unknown as RuntimeStore,
      hooks: {
        broadcast,
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      agentPlans: new Map(),
      streams: {} as never,
      activities: {} as never,
      interactions: {} as never,
      now: () => "2030-01-01T00:00:02.000Z",
      transition: () => false,
      observeSubagent,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: {
        id: "turn-1",
        runId: "run-1",
        providerId: "codex",
      },
    } as ActiveTurn;

    projector.project(active, event(3, "running", "running", true));

    expect(broadcast).not.toHaveBeenCalled();
    expect(observeSubagent).not.toHaveBeenCalled();
  });
});

describe("TurnProviderEventProjector reasoning order", () => {
  it("lands buffered reasoning before events that end thinking, not before thinking progress", () => {
    const calls: string[] = [];
    const base = {
      providerId: "claude" as const,
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
    };
    const activity = (
      kind: ProviderActivityEvent["kind"],
      phase: ProviderActivityEvent["phase"],
    ): ProviderActivityEvent => ({
      ...base,
      type: "activity",
      kind,
      phase,
      label: `${kind} ${phase}`,
      activityId: `${kind}-activity`,
    });
    const projector = new TurnProviderEventProjector({
      store: {
        upsertAgentPlan: vi.fn(() => calls.push("persist-plan")),
      } as unknown as RuntimeStore,
      hooks: {
        broadcast: vi.fn((message: { type: string }) => calls.push(message.type)),
        broadcastConversationShell: vi.fn(),
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      agentPlans: new Map(),
      streams: {
        closeAssistantSegment: vi.fn(() => {
          calls.push("close-assistant");
          return false;
        }),
        flush: vi.fn((_active: ActiveTurn, kind: string) => {
          calls.push(`flush-${kind}`);
          return true;
        }),
      } as never,
      activities: {
        record: vi.fn((_active: ActiveTurn, value: ProviderActivityEvent) => ({
          id: value.activityId,
        })),
      } as never,
      interactions: {} as never,
      now: () => "2030-01-01T00:00:01.000Z",
      transition: () => false,
      observeSubagent: () => false,
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: { id: "turn-1", runId: "run-1", providerId: "claude" },
    } as ActiveTurn;

    projector.project(active, activity("reasoning", "started"));
    projector.project(active, activity("reasoning", "started"));
    expect(calls).toEqual([
      "close-assistant",
      "agent.activity",
      "close-assistant",
      "agent.activity",
    ]);

    calls.length = 0;
    projector.project(active, activity("tool", "started"));
    projector.project(active, activity("reasoning", "completed"));
    projector.project(active, {
      ...base,
      type: "plan",
      explanation: null,
      steps: [{ step: "Verify ordering", status: "inProgress" }],
    });
    expect(calls).toEqual([
      "close-assistant",
      "flush-reasoning",
      "agent.activity",
      "close-assistant",
      "flush-reasoning",
      "agent.activity",
      "close-assistant",
      "flush-reasoning",
      "persist-plan",
      "agent.plan.updated",
    ]);
  });
});

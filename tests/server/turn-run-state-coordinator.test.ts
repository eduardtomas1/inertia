import { describe, expect, it, vi } from "vitest";

import type {
  AgentTurn,
  SubagentTrace,
} from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import { AuthoritativeRunStateEngine } from "../../src/server/runtime/run-state-engine";
import type {
  ActiveTurn,
  TurnControllerHooks,
} from "../../src/server/runtime/turns/turn-controller-types";
import { TurnRunStateCoordinator } from "../../src/server/runtime/turns/turn-run-state-coordinator";

function trace(overrides: Partial<SubagentTrace>): SubagentTrace {
  return {
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
    providerToolUseId: "spawn-1",
    providerRole: "reviewer",
    providerName: "State reviewer",
    providerStatus: "running",
    status: "running",
    isLive: true,
    description: "Preserve descendant identity.",
    progress: null,
    result: null,
    sequence: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("TurnRunStateCoordinator descendant identity", () => {
  it("keeps one stable descendant when provider identifiers are enriched", () => {
    const active = {
      conversation: {
        id: "conversation-1",
        title: "Stable delegated work",
      },
      turn: {
        id: "turn-1",
        runId: "run-1",
        providerId: "codex",
        status: "running",
      },
      runState: new AuthoritativeRunStateEngine({
        conversationId: "conversation-1",
        runId: "run-1",
        turnId: "turn-1",
        providerId: "codex",
      }),
      workspaceRunCreated: false,
    } as unknown as ActiveTurn;
    active.runState.setTransport("running", "root/running");
    const updateAgentTurnLifecycle = vi.fn((
      _turnId: Parameters<RuntimeStore["updateAgentTurnLifecycle"]>[0],
      update: Parameters<RuntimeStore["updateAgentTurnLifecycle"]>[1],
    ) => ({ ...active.turn, ...update }) as AgentTurn);
    const coordinator = new TurnRunStateCoordinator({
      store: {
        updateAgentTurnLifecycle,
        updateConversation: vi.fn(),
      } as unknown as RuntimeStore,
      providers: {} as never,
      hooks: {
        broadcastSnapshot: vi.fn(),
      } as unknown as TurnControllerHooks,
      scheduler: {} as never,
      pendingApprovals: new Map(),
      pendingInputs: new Map(),
      settlement: {} as never,
      providerRunOwnershipBarriers: new Map(),
      now: () => "2030-01-01T00:00:01.000Z",
      activity: vi.fn(),
      release: vi.fn(async () => undefined),
      track: vi.fn(),
    });

    expect(coordinator.observeSubagent(active, trace({}))).toBe(true);
    expect(active.runState.snapshot().state).toBe("delegated");
    expect(coordinator.observeSubagent(active, trace({
      providerTaskId: "task-1",
      providerStatus: "working",
      sequence: 2,
    }))).toBe(true);
    expect(active.runState.snapshot().state).toBe("delegated");
    expect(coordinator.observeSubagent(active, trace({
      providerTaskId: "task-1",
      providerStatus: "completed",
      status: "completed",
      isLive: false,
      sequence: 3,
    }))).toBe(true);

    expect(active.runState.snapshot()).toMatchObject({
      state: "running",
      providerState: "completed",
    });
  });
});

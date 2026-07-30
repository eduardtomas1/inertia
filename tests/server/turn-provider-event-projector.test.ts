import { describe, expect, it, vi } from "vitest";

import type { SubagentTrace } from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import type {
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
    });
    const active = {
      conversation: { id: "conversation-1" },
      turn: {
        id: "turn-1",
        runId: "run-1",
        providerId: "codex",
      },
    } as ActiveTurn;

    projector.project(active, event(1, "pendingInit", "queued"));
    projector.project(active, event(2, "interrupted", "interrupted"));

    expect(upsertSubagentTrace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerStatus: "pendingInit",
        status: "queued",
      }),
    );
    expect(upsertSubagentTrace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerStatus: "interrupted",
        status: "interrupted",
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
});

import { describe, expect, it, vi } from "vitest";

import { stopActiveSubagent, type TurnSubagentStopOptions } from "../../src/server/runtime/turns/turn-subagent-stop";
import type { SubagentTrace } from "../../src/shared/contracts";

const CONVERSATION = "conversation-1";
const ACTIVE = { runId: "run-2", turnId: "turn-2" };

function trace(overrides: Partial<SubagentTrace> & { id: string }): SubagentTrace {
  return {
    conversationId: CONVERSATION, runId: ACTIVE.runId, turnId: ACTIVE.turnId, providerId: "claude",
    providerTaskId: `task-${overrides.id}`, providerAgentId: null, parentTraceId: null, parentProviderAgentId: null,
    parentProviderToolUseId: null, providerToolUseId: null, providerRole: null, providerName: null, providerStatus: null,
    status: "running", isLive: true, description: null, progress: null, result: null, model: null, activity: null,
    usage: null, toolUseCount: null, durationMs: null, sequence: 1,
    createdAt: "2026-10-31T10:00:00.000Z", updatedAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  };
}

function harness(traces: SubagentTrace[], active: { runId: string; turnId: string } | null = ACTIVE) {
  const byId = new Map(traces.map((entry) => [entry.id, entry]));
  const providerStop = vi.fn(async () => true);
  const activeTurn = active ? {
    turn: { id: active.turnId, runId: active.runId },
    runState: { acceptsProviderEvents: () => true },
  } : undefined;
  const options = {
    store: {
      subagentTrace: (id: string) => {
        const found = byId.get(id);
        if (!found) throw new Error("missing");
        return found;
      },
      acknowledgeSubagentStop: (id: string) => {
        const stopped = { ...byId.get(id)!, status: "cancelled" as const, isLive: false };
        byId.set(id, stopped);
        return { changed: true, trace: stopped };
      },
    },
    providers: { stopSubagent: providerStop },
    hooks: { broadcast: vi.fn() },
    activeForConversation: (conversationId: string) => conversationId === CONVERSATION ? activeTurn : undefined,
    now: () => "2026-10-31T10:00:05.000Z",
    observeSubagent: () => true,
  } as unknown as TurnSubagentStopOptions;
  return { options, providerStop };
}

describe("observed child stop", () => {
  it("rechecks the exact live trace on the active run and turn before the provider is asked", async () => {
    const traces = [
      trace({ id: "live" }),
      trace({ id: "earlier-turn", turnId: "turn-1" }),
      trace({ id: "earlier-run", runId: "run-1" }),
      trace({ id: "other-chat", conversationId: "conversation-2" }),
      trace({ id: "codex", providerId: "codex" }),
      trace({ id: "no-task", providerTaskId: null }),
      trace({ id: "finished", status: "completed", isLive: false }),
    ];
    const { options, providerStop } = harness(traces);

    for (const refused of ["earlier-turn", "earlier-run", "other-chat", "codex", "no-task", "finished", "missing"]) {
      await expect(stopActiveSubagent(options, CONVERSATION, refused)).resolves.toBe(false);
    }
    expect(providerStop).not.toHaveBeenCalled();

    await expect(stopActiveSubagent(options, CONVERSATION, "live")).resolves.toBe(true);
    expect(providerStop).toHaveBeenCalledExactlyOnceWith(CONVERSATION, "task-live", ACTIVE);
  });

  it("refuses without an active turn even for a trace that was live when it was read", async () => {
    const { options, providerStop } = harness([trace({ id: "live" })], null);
    await expect(stopActiveSubagent(options, CONVERSATION, "live")).resolves.toBe(false);
    expect(providerStop).not.toHaveBeenCalled();
  });
});

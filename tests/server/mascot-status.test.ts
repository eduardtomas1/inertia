import { describe, expect, it, vi } from "vitest";
import type { ConversationShell } from "../../src/shared/contracts/app";
import { AGENT_RUN_STATES, agentTurnStatusForRunState, type AgentRunState } from "../../src/shared/run-state";
import { MascotStatusPublisher } from "../../src/server/runtime/mascot-status";
import { emptyMascotStatus } from "../../src/shared/mascot";

function conversation(id: string, state: AgentRunState): ConversationShell {
  return {
    id, projectId: "project", title: "PRIVATE TITLE", status: "idle",
    archivedAt: null, lastViewedAt: null,
    latestTurn: {
      id: `${id}-turn`, runId: `${id}-run`,
      status: agentTurnStatusForRunState(state),
      runState: { state, revision: 1, providerState: "PRIVATE PROVIDER TEXT" },
      completedAt: "2026-09-06T10:00:00.000Z",
      updatedAt: "2026-09-06T10:00:00.000Z",
    },
  } as ConversationShell;
}

describe("authoritative mascot status", () => {
  it.each(AGENT_RUN_STATES)("preserves exact %s state and full turn identity", (phase) => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([conversation("chat", phase)]);
    expect(publish).toHaveBeenLastCalledWith({
      phase, projectId: "project", conversationId: "chat", runId: "chat-run", turnId: "chat-turn",
      activeCount: ["completed", "failed", "cancelled", "interrupted"].includes(phase) ? 0 : 1,
    });
    expect(JSON.stringify(publish.mock.calls)).not.toContain("PRIVATE");
  });

  it("prioritizes actionable requests over live work and unseen outcomes", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([
      conversation("complete", "completed"), conversation("failure", "failed"),
      conversation("working", "running"), conversation("approval", "waiting-for-approval"),
    ]);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "waiting-for-approval", activeCount: 2 });
    publisher.update({ ...conversation("approval", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "running", activeCount: 1 });
    publisher.update({ ...conversation("working", "running"), archivedAt: "2026-09-06T11:00:00.000Z" });
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: "failed", activeCount: 0 });
  });

  it("does not replay seen results, invent completion for cancellation, or retain deleted chats", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    publisher.replace([{ ...conversation("old", "completed"), lastViewedAt: "2026-09-06T11:00:00.000Z" }]);
    expect(publish).toHaveBeenLastCalledWith(emptyMascotStatus());
    publisher.update(conversation("cancelled", "cancelled"));
    expect(publish.mock.lastCall?.[0].phase).toBe("cancelled");
    publisher.replace([]);
    expect(publish).toHaveBeenLastCalledWith(emptyMascotStatus());
  });

  it("deduplicates shell/snapshot updates including streamed text metadata changes", () => {
    const publish = vi.fn();
    const publisher = new MascotStatusPublisher(publish);
    const chat = conversation("chat", "running");
    publisher.replace([chat]);
    publisher.update({ ...chat, title: "Renamed" });
    publisher.replace([chat]);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

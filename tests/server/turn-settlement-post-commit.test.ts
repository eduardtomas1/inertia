// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { TurnNativeGoalCoordinator } from
  "../../src/server/runtime/turns/turn-native-goal-coordinator";
import { recoverInterruptedTurns } from "../../src/server/runtime/turns/turn-recovery";
import { TurnSettlementCoordinator } from
  "../../src/server/runtime/turns/turn-settlement-coordinator";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  turnControllerTestAttachment,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

const runtimes: TurnControllerTestRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) {
    await runtime.controller.dispose("runtime-shutdown");
    runtime.store.close();
  }
  await cleanupTurnControllerTestDirectories();
});

function diagnostics(runtime: TurnControllerTestRuntime, turnId: string) {
  return runtime.store.conversationDetail(runtime.conversationId)!.activities
    .filter((activity) => activity.turnId === turnId
      && activity.detail?.includes('"code":"turn-post-processing-failed"'));
}

function start(runtime: TurnControllerTestRuntime) {
  const queued = runtime.controller.queue({
    conversationId: runtime.conversationId,
    content: "Complete the synthetic request.",
  });
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  return queued;
}

async function complete(runtime: TurnControllerTestRuntime, turnId: string) {
  runtime.provider.resolve({ status: "completed", text: "Saved answer." });
  await expect.poll(() => runtime.store.agentTurn(turnId).status).toBe("completed");
  await runtime.controller.drainSettlementTasks();
}

describe("terminal commitment survives downstream faults", () => {
  it("publishes one content-free incident after a failed terminal write, not for a later successful turn", async () => {
    const reportIncident = vi.fn();
    const runtime = await createTurnControllerTestRuntime({ reportIncident });
    runtimes.push(runtime);
    const first = start(runtime);
    runtime.provider.resolve({ status: "failed", exitCode: 9, error: "PRIVATE provider output" });
    await expect.poll(() => runtime.store.agentTurn(first.turn.id).status).toBe("failed");
    await runtime.controller.drainSettlementTasks();
    expect(reportIncident).toHaveBeenCalledOnce();
    expect(reportIncident.mock.calls[0]![0]).toMatchObject({ code: "turn.failed", outcome: "failed",
      correlationId: first.turn.id, context: { turnId: first.turn.id, conversationId: runtime.conversationId,
        projectId: runtime.store.conversation(runtime.conversationId).projectId, providerId: "codex" } });
    expect(JSON.stringify(reportIncident.mock.calls)).not.toContain("PRIVATE");
    const next = start(runtime);
    await complete(runtime, next.turn.id);
    expect(reportIncident).toHaveBeenCalledOnce();
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
  });

  it.each((["metadata", "runtime-settled", "turn-settled", "artifacts"] as const)
    .flatMap((stage) => ["throw", "reject"].map((mode) => ({ stage, mode }))))(
    "does not contradict a durable completion after $stage $mode",
    async ({ stage, mode }) => {
      const fault = () => {
        const error = new Error("synthetic-private-detail-must-not-be-persisted");
        if (mode === "reject") return Promise.reject(error);
        throw error;
      };
      const globalSettled = vi.fn(stage === "runtime-settled" ? fault : () => {});
      const turnSettled = vi.fn(stage === "turn-settled" ? fault : () => {});
      const settlement = vi.spyOn(TurnSettlementCoordinator.prototype, "settle");
      const cleanup = vi.spyOn(TurnNativeGoalCoordinator.prototype, "cleanup");
      const runtime = await createTurnControllerTestRuntime({
        captureGitArtifacts: stage === "artifacts" ? fault : () => {},
        refreshProviderMetadata: stage === "metadata" ? fault : () => {},
        onTurnSettled: globalSettled,
      });
      runtimes.push(runtime);
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Complete the synthetic request.",
        onSettled: turnSettled,
      });
      runtime.controller.start(queued.turn.id);
      runtime.provider.resolve({ status: "completed", text: "Saved answer." });
      await expect.poll(() => runtime.store.agentTurn(queued.turn.id).status)
        .toBe("completed");
      await runtime.controller.drainSettlementTasks();
      const active = settlement.mock.calls.find(([candidate]) =>
        candidate.turn.id === queued.turn.id)![0];

      expect({
        canonical: runtime.store.agentTurn(queued.turn.id).status,
        runState: active.runState.snapshot().state,
        conversation: runtime.store.conversation(runtime.conversationId).status,
        workspace: runtime.store.workspaceRun(queued.turn.runId).status,
        terminalEvents: runtime.events.filter((event) =>
          event.type === "agent.completed" || event.type === "agent.failed")
          .map((event) => event.type),
      }).toEqual({
        canonical: "completed",
        runState: "completed",
        conversation: "completed",
        workspace: "succeeded",
        terminalEvents: ["agent.completed"],
      });
      expect(globalSettled).toHaveBeenCalledOnce();
      expect(turnSettled).toHaveBeenCalledOnce();
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.store.providerRunOwnership.all()).toEqual([]);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(diagnostics(runtime, queued.turn.id)).toHaveLength(1);
      expect(JSON.stringify(diagnostics(runtime, queued.turn.id)))
        .not.toContain("synthetic-private-detail");
      const next = start(runtime);
      await complete(runtime, next.turn.id);
      expect(runtime.provider.runCount).toBe(2);
    },
  );

  it.each(["agent.completed", "conversation.detail.invalidated", "snapshot"]
    .flatMap((stage) => ["throw", "reject"].map((mode) => ({ stage, mode }))))(
    "keeps independent effects and drainage alive when $stage publication $mode",
    async ({ stage, mode }) => {
      let enabled = false;
      const unavailable = () => {
        if (mode === "reject") return Promise.reject(new Error("transport unavailable"));
        throw new Error("transport unavailable");
      };
      const runtime = await createTurnControllerTestRuntime({
        broadcast(event) {
          runtime.events.push(event);
          if (enabled && event.type === stage) return unavailable();
        },
        broadcastSnapshot() {
          if (enabled && stage === "snapshot") return unavailable();
        },
        refreshProviderMetadata: async () => {},
      });
      runtimes.push(runtime);
      const turn = start(runtime).turn;
      enabled = true;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      await complete(runtime, turn.id);
      expect(runtime.store.agentTurn(turn.id).runState?.state).toBe("completed");
      expect(runtime.store.conversation(runtime.conversationId).status).toBe("completed");
      expect(runtime.events.filter(({ type }) => type === "agent.failed")).toEqual([]);
      expect(runtime.settled).toContain(`completed:${turn.id}`);
      expect(diagnostics(runtime, turn.id).map(({ detail }) => JSON.parse(detail!)))
        .toEqual([expect.objectContaining({ effect: "publication", outcome: "completed" })]);
      enabled = false;
      warning.mockRestore();
      const next = start(runtime);
      await complete(runtime, next.turn.id);
    },
  );

  it("records a late rejected effect only on its old turn, without touching the next writer", async () => {
    let rejectMetadata!: (error: Error) => void;
    const metadata = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectMetadata = reject;
    }));
    const runtime = await createTurnControllerTestRuntime({ refreshProviderMetadata: metadata });
    runtimes.push(runtime);
    const first = start(runtime).turn;
    const oldIdentity = {
      providerId: first.providerId,
      conversationId: first.conversationId,
      runId: first.runId,
      turnId: first.id,
    };
    runtime.provider.resolve({ text: "First answer." });
    await expect.poll(() => runtime.controller.isActive(runtime.conversationId)).toBe(false);
    const saved = runtime.store.agentTurn(first.id);
    const second = start(runtime).turn;
    await expect.poll(() => runtime.provider.input?.turnId).toBe(second.id);
    runtime.provider.emit({
      providerId: second.providerId, conversationId: second.conversationId,
      runId: second.runId, turnId: second.id, type: "status", status: "running",
    });
    rejectMetadata(new Error("late optional metadata failure"));
    await runtime.controller.drainSettlementTasks();

    expect(runtime.controller.handleProviderEvent({
      ...oldIdentity, type: "text", text: "late text must not enter the new answer",
    })).toBe(false);
    expect(runtime.store.settleAgentTurn(first.id, {
      status: "failed", terminalReason: "duplicate late failure",
      projection: { workspaceRunCreated: true, detail: "Stale projection must not be applied" },
    })).toEqual({ settled: false, turn: saved });
    expect(runtime.store.agentTurn(first.id)).toEqual(saved);
    expect(runtime.store.agentTurn(second.id).status).toBe("running");
    expect(runtime.store.conversation(runtime.conversationId).status).toBe("running");
    expect(runtime.store.providerRunOwnership.all()).toEqual([
      expect.objectContaining({ turnId: second.id, runId: second.runId }),
    ]);
    expect(diagnostics(runtime, first.id)).toHaveLength(1);
    expect(diagnostics(runtime, second.id)).toHaveLength(0);
    expect(runtime.provider.cancelCount).toBe(0);
    await complete(runtime, second.id);
  });

  it("preserves cancellation as the winner despite completion, duplicate cancellation and rejected hooks", async () => {
    const onTurnSettled = vi.fn(async () => { throw new Error("post-cancel follow-up unavailable"); });
    const settlement = vi.spyOn(TurnSettlementCoordinator.prototype, "settle");
    const runtime = await createTurnControllerTestRuntime({ onTurnSettled });
    runtimes.push(runtime);
    const turn = start(runtime).turn;
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(false);
    runtime.provider.resolve({ status: "completed", text: "Too late." });
    await expect.poll(() => runtime.store.agentTurn(turn.id).status).toBe("cancelled");
    await runtime.controller.drainSettlementTasks();
    expect(settlement.mock.calls[0]![0].runState.snapshot().state).toBe("cancelled");
    expect(runtime.store.conversation(runtime.conversationId).status).toBe("idle");
    expect(runtime.store.workspaceRun(turn.runId).status).toBe("cancelled");
    expect(runtime.events.filter(({ type }) => type === "agent.completed" || type === "agent.failed"))
      .toEqual([expect.objectContaining({ type: "agent.completed", status: "cancelled", turnId: turn.id })]);
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(runtime.store.providerRunOwnership.all()).toEqual([]);
  });

  it("does not retire the writer or run required follow-up after mandatory cleanup fails", async () => {
    const runtime = await createTurnControllerTestRuntime();
    runtimes.push(runtime);
    const turn = start(runtime).turn;
    vi.spyOn(TurnNativeGoalCoordinator.prototype, "cleanup")
      .mockImplementationOnce(() => { throw new Error("mandatory cleanup failure"); });
    await complete(runtime, turn.id);
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
    expect(() => start(runtime)).toThrow();
    expect(runtime.settled).not.toContain(`completed:${turn.id}`);
    expect(runtime.gitArtifacts).toEqual([]);
    expect(diagnostics(runtime, turn.id).map(({ detail }) => JSON.parse(detail!).effect).sort())
      .toEqual(["lifecycle-cleanup", "orchestration"]);
    // Provider cleanup is a separate exact receipt; local cleanup failure
    // must not manufacture or retain a false owned-process claim.
    expect(runtime.store.providerRunOwnership.all()).toEqual([]);
    expect(runtime.provider.stopOwnedCalls).toEqual([{
      conversationId: runtime.conversationId, identity: { runId: turn.runId, turnId: turn.id },
    }]);
  });

  it("waits for exact provider cleanup and releases attachments despite optional failure", async () => {
    const runtime = await createTurnControllerTestRuntime({
      onTurnSettled: async () => { throw new Error("follow-up failure"); },
    });
    runtimes.push(runtime);
    const attachment = await turnControllerTestAttachment(
      runtime, "31313131-3131-4131-8131-313131313131", "synthetic.png",
    );
    const turn = runtime.controller.queue({
      conversationId: runtime.conversationId, content: "Attached synthetic request.",
      attachments: [attachment],
    }).turn;
    runtime.controller.start(turn.id);
    runtime.provider.deferOwnedStop("settled");
    runtime.provider.resolve({ text: "Saved answer." });
    await expect.poll(() => runtime.provider.stopOwnedCalls.length).toBe(1);
    expect(runtime.store.agentTurn(turn.id).runState?.state).toBe("cancelling");
    expect(runtime.store.providerRunOwnership.all()).toHaveLength(1);
    expect(runtime.attachmentReleases).toEqual([]);
    runtime.provider.resolveOwnedStop();
    await runtime.controller.drainSettlementTasks();
    expect(runtime.store.agentTurn(turn.id).status).toBe("completed");
    expect(runtime.store.providerRunOwnership.all()).toEqual([]);
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
  });

  it("keeps a genuine failed terminal write honest and admits the next turn after successful repair", async () => {
    const runtime = await createTurnControllerTestRuntime();
    runtimes.push(runtime);
    const turn = start(runtime).turn;
    vi.spyOn(runtime.store, "settleAgentTurn").mockImplementationOnce(() => {
      throw new Error("synthetic SQLite write failure");
    });
    runtime.provider.resolve({ text: "Unsaved terminal outcome." });
    await expect.poll(() => runtime.store.agentTurn(turn.id).status).toBe("failed");
    await runtime.controller.drainSettlementTasks();
    expect(runtime.store.agentTurn(turn.id)).toMatchObject({
      status: "failed", runState: { state: "failed" }, terminalReason: "stream-persistence-failed",
    });
    expect(runtime.store.conversation(runtime.conversationId).status).toBe("failed");
    expect(runtime.store.workspaceRun(turn.runId).status).toBe("failed");
    expect(runtime.events.filter(({ type }) => type === "agent.completed" || type === "agent.failed"))
      .toEqual([expect.objectContaining({ type: "agent.failed", turnId: turn.id })]);
    const next = start(runtime);
    await complete(runtime, next.turn.id);
  });

  it("retains admission after persistent write failure until existing restart recovery interrupts the row", async () => {
    const runtime = await createTurnControllerTestRuntime();
    runtimes.push(runtime);
    const turn = start(runtime).turn;
    const failure = vi.spyOn(runtime.store, "settleAgentTurn").mockImplementation(() => {
      throw new Error("persistent SQLite write failure");
    });
    runtime.provider.resolve({ text: "Cannot commit terminal outcome." });
    await expect.poll(() => diagnostics(runtime, turn.id).length).toBe(1);
    await runtime.controller.drainSettlementTasks();
    expect(runtime.store.agentTurn(turn.id).status).toBe("running");
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
    expect(() => start(runtime)).toThrow();
    expect(runtime.events.filter(({ type }) => type === "agent.completed" || type === "agent.failed"))
      .toEqual([]);
    expect(runtime.settled).not.toContain(`failed:${turn.id}`);
    failure.mockRestore();
    await runtime.controller.dispose("runtime-shutdown");
    runtime.store.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace,
      { recoverInterruptedRuns: false });
    try {
      expect(recoverInterruptedTurns(reopened).recoveredTurns.map(({ id }) => id)).toEqual([turn.id]);
      expect(reopened.agentTurn(turn.id)).toMatchObject({ status: "interrupted", terminalReason: "runtime-restart" });
      expect(reopened.conversationDetail(runtime.conversationId)!.activities
        .some(({ detail }) => detail?.includes('"effect":"terminal-persistence"'))).toBe(true);
    } finally { reopened.close(); }
  });

  it("trusts SQLite if a terminal write succeeds before its caller throws", async () => {
    const settlement = vi.spyOn(TurnSettlementCoordinator.prototype, "settle");
    const runtime = await createTurnControllerTestRuntime();
    runtimes.push(runtime);
    const turn = start(runtime).turn;
    const settle = runtime.store.settleAgentTurn.bind(runtime.store);
    vi.spyOn(runtime.store, "settleAgentTurn").mockImplementationOnce((...args) => {
      settle(...args);
      throw new Error("commit acknowledgement lost");
    });
    await complete(runtime, turn.id);
    expect(runtime.store.agentTurn(turn.id).runState?.state).toBe("completed");
    expect(runtime.store.conversation(runtime.conversationId).status).toBe("completed");
    expect(runtime.store.workspaceRun(turn.runId).status).toBe("succeeded");
    expect(runtime.events.filter(({ type }) => type === "agent.failed")).toEqual([]);
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    const engine = settlement.mock.calls[0]![0].runState;
    const saved = runtime.store.agentTurn(turn.id);
    expect(engine.snapshot()).toEqual(saved.runState);
    expect(() => engine.acknowledgeTerminalCommit({ ...saved, runId: "another-run" }))
      .toThrow("does not own this run state");
    expect(engine.snapshot()).toEqual(saved.runState);
    expect(diagnostics(runtime, turn.id)).toEqual([
      expect.objectContaining({ detail: expect.stringContaining('"effect":"orchestration"') }),
    ]);
  });

  it.each(["conversation", "workspace"] as const)(
    "rolls back terminal state and preceding writes when its %s projection fails",
    async (stage) => {
      const runtime = await createTurnControllerTestRuntime();
      runtimes.push(runtime);
      const turn = start(runtime).turn;
      const settlement = vi.spyOn(runtime.store, "settleAgentTurn");
      const before = {
        turn: runtime.store.agentTurn(turn.id),
        conversation: runtime.store.conversation(runtime.conversationId),
        workspace: runtime.store.workspaceRun(turn.runId),
      };
      const projection = stage === "conversation"
        ? vi.spyOn(runtime.store, "updateConversation")
        : vi.spyOn(runtime.store, "updateWorkspaceRun");
      projection.mockImplementation(() => { throw new Error("persistent projection write failure"); });
      // Directly exercise the same real-store terminal transaction first: it
      // must roll back the terminal row and any preceding successful writes.
      expect(() => runtime.store.settleAgentTurn(turn.id, {
        status: "completed", completedAt: before.turn.updatedAt, updatedAt: before.turn.updatedAt,
        projection: { workspaceRunCreated: true, detail: "Synthetic result" },
      })).toThrow("persistent projection write failure");
      expect(runtime.store.agentTurn(turn.id)).toEqual(before.turn);
      expect(runtime.store.conversation(runtime.conversationId)).toEqual(before.conversation);
      expect(runtime.store.workspaceRun(turn.runId)).toEqual(before.workspace);
      projection.mockRestore();
      // Fail once only at the terminal projection (not live cancelling), so
      // the controller can commit its honest failed repair atomically.
      const update = runtime.store.updateWorkspaceRun.bind(runtime.store);
      vi.spyOn(runtime.store, "updateWorkspaceRun").mockImplementation((id, change) => {
        if (change.status === "succeeded") throw new Error("terminal projection unavailable");
        return update(id, change);
      });
      runtime.provider.resolve({ text: "Saved answer, failed lifecycle commit." });
      await expect.poll(() => runtime.store.agentTurn(turn.id).status).toBe("failed");
      await runtime.controller.drainSettlementTasks();
      expect(settlement).toHaveBeenCalledTimes(3);
      expect(runtime.store.conversation(runtime.conversationId).status).toBe("failed");
      expect(runtime.store.workspaceRun(turn.runId).status).toBe("failed");
      expect(runtime.events.filter(({ type }) => type === "agent.completed" || type === "agent.failed"))
        .toEqual([expect.objectContaining({ type: "agent.failed", turnId: turn.id })]);
    },
  );

  it("rereads canonical state when the failed repair commits before throwing on return", async () => {
    const runtime = await createTurnControllerTestRuntime();
    runtimes.push(runtime);
    const turn = start(runtime).turn;
    const settle = runtime.store.settleAgentTurn.bind(runtime.store);
    vi.spyOn(runtime.store, "settleAgentTurn")
      .mockImplementationOnce(() => { throw new Error("first write failed"); })
      .mockImplementationOnce((...args) => {
        settle(...args);
        throw new Error("repair commit acknowledgement lost");
      });
    runtime.provider.resolve({ text: "Saved response." });
    await expect.poll(() => runtime.store.agentTurn(turn.id).status).toBe("failed");
    await runtime.controller.drainSettlementTasks();
    expect(runtime.store.conversation(runtime.conversationId).status).toBe("failed");
    expect(runtime.store.workspaceRun(turn.runId).status).toBe("failed");
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    expect(diagnostics(runtime, turn.id)).toEqual([
      expect.objectContaining({ detail: expect.stringContaining('"effect":"orchestration"') }),
    ]);
  });

  it("bounds successful and rejected asynchronous snapshot publication without recursive tasks", async () => {
    let fail = false;
    const snapshot = vi.fn(async () => {
      if (fail) throw new Error("async snapshot transport unavailable");
    });
    const runtime = await createTurnControllerTestRuntime({
      broadcastSnapshot: snapshot,
      refreshProviderMetadata: async () => {},
    });
    runtimes.push(runtime);
    const first = start(runtime).turn;
    await complete(runtime, first.id);
    const successfulPublications = snapshot.mock.calls.length;
    expect(successfulPublications).toBeLessThan(20);
    const second = start(runtime).turn;
    fail = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await complete(runtime, second.id);
    expect(snapshot.mock.calls.length - successfulPublications).toBeLessThan(20);
    expect(runtime.store.agentTurn(second.id).status).toBe("completed");
    expect(diagnostics(runtime, second.id)).toHaveLength(1);
    fail = false;
    warning.mockRestore();
  });

  it("joins a rejected artifact barrier before the next checkpoint, without leaking a writer", async () => {
    let rejectArtifact!: (error: Error) => void;
    const before = vi.fn();
    const capture = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectArtifact = reject;
    }));
    const runtime = await createTurnControllerTestRuntime({
      captureGitBefore: before, captureGitArtifacts: capture,
    });
    runtimes.push(runtime);
    const first = start(runtime).turn;
    runtime.provider.resolve({ text: "First saved result." });
    await expect.poll(() => runtime.controller.isActive(runtime.conversationId)).toBe(false);
    const second = start(runtime).turn;
    expect(runtime.provider.runCount).toBe(1);
    expect(before).toHaveBeenCalledOnce();
    rejectArtifact(new Error("artifact capture unavailable"));
    await expect.poll(() => runtime.provider.input?.turnId).toBe(second.id);
    expect(before).toHaveBeenCalledTimes(2);
    expect(runtime.store.providerRunOwnership.all()).toEqual([
      expect.objectContaining({ turnId: second.id }),
    ]);
    await complete(runtime, second.id);
    expect(diagnostics(runtime, first.id)).toHaveLength(1);
    expect(runtime.store.providerRunOwnership.all()).toEqual([]);
  });

  it("keeps later owners alive and emits a sanitized warning if the diagnostic write also fails", async () => {
    const runtime = await createTurnControllerTestRuntime({
      refreshProviderMetadata: () => { throw new Error("private callback error content"); },
    });
    runtimes.push(runtime);
    const turn = start(runtime).turn;
    vi.spyOn(runtime.store, "addActivity").mockImplementation(() => {
      throw new Error("private diagnostic write error content");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await complete(runtime, turn.id);
    expect(runtime.settled).toContain(`completed:${turn.id}`);
    expect(runtime.store.conversation(runtime.conversationId).status).toBe("completed");
    expect(warning).toHaveBeenCalledWith(
      "Turn post-processing diagnostic could not be persisted.",
      expect.objectContaining({ effect: "metadata", turnId: turn.id, runId: turn.runId }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
  });

  it.each(["persistence", "publication"] as const)(
    "distinguishes a final stream %s failure at the real SQLite boundary",
    async (stage) => {
      const runtime = await createTurnControllerTestRuntime({
        broadcast(event) {
          if (stage === "publication" && event.type === "agent.text") throw new Error("renderer disconnected");
          runtime.events.push(event);
        },
      });
      runtimes.push(runtime);
      const turn = start(runtime).turn;
      if (stage === "persistence") {
        vi.spyOn(runtime.store, "createMessage").mockImplementationOnce(() => {
          throw new Error("SQLite assistant insert failed");
        });
      }
      runtime.provider.resolve({ text: "Final buffered answer." });
      const expected = stage === "persistence" ? "failed" : "completed";
      await expect.poll(() => runtime.store.agentTurn(turn.id).status).toBe(expected);
      await runtime.controller.drainSettlementTasks();
      expect(runtime.store.agentTurn(turn.id).runState?.state).toBe(expected);
      expect(runtime.store.conversation(runtime.conversationId).status).toBe(expected);
      const messages = runtime.store.conversationDetail(runtime.conversationId)!.messages
        .filter(({ role }) => role === "assistant");
      expect(messages.map(({ content }) => content))
        .toEqual(stage === "persistence" ? [] : ["Final buffered answer."]);
      expect(runtime.events.filter(({ type }) => type === "agent.completed" || type === "agent.failed"))
        .toEqual([expect.objectContaining({ type: expected === "failed" ? "agent.failed" : "agent.completed" })]);
    },
  );
});

// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import type { DelegatedTaskView } from "../../src/shared/orchestration-delegation";
import type { AgentApprovalDecision } from "../../src/server/provider/interactions";
import type { RuntimeStore } from "../../src/server/database";
import type { StoredLimitResetPlan } from "../../src/server/persistence/limit-reset-repository";
import { createDelegationCommandHandler } from "../../src/server/runtime/commands/delegation-commands";
import { LimitResetScheduler } from "../../src/server/usage/limit-reset-scheduler";
import { createDelegationManagerFixture, errorCode, parsed, settleTurnRow } from "../support/delegation-manager-fixture";

const TASK = { task: "Refactor the cache layer behind an interface.", title: "Cache refactor" };

function armLimitPlan(store: RuntimeStore, conversationId: string, failedTurnId: string): StoredLimitResetPlan {
  store.limitResets.markUsageLimited(failedTurnId);
  const plan: StoredLimitResetPlan = { id: randomUUID(), conversationId, failedTurnId, routeIdentity: "route",
    accountIdentity: "account", resetsAt: "2030-01-01T00:00:00.000Z", nextAttemptAt: "2030-01-01T00:00:00.000Z",
    attempts: 0, state: "waiting", error: null, turnId: null };
  store.limitResets.save(plan);
  return plan;
}

function limitScheduler(store: RuntimeStore): LimitResetScheduler {
  return new LimitResetScheduler({ store, signal: new AbortController().signal, enabled: false,
    readAccount: async () => null, cachedAccount: () => null, busy: () => false, dispatch: async () => undefined,
    track: (operation) => operation(), changed: () => undefined });
}

function markAppUpdateInterrupted(database: Database.Database, turnId: string): void {
  database.prepare(`UPDATE agent_turns SET status = 'interrupted', run_state = 'interrupted', terminal_reason = 'app-update',
    started_at = COALESCE(started_at, requested_at), completed_at = COALESCE(started_at, requested_at) WHERE id = ?`).run(turnId);
}

describe("inertia_cancel_task", () => {
  it("stops only the exact task turn and the task's own nested tasks", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const bystander = parsed<{ conversationId: string; turnId: string }>(await f.invoke("inertia_create_conversation",
        { title: "Unrelated", prompt: "Keep working" }));
      const child = { conversation: f.store.conversation(view.conversationId), turn: f.store.agentTurn(view.firstTurnId) };
      const nested = parsed<DelegatedTaskView>(await f.invokeAs(child, "inertia_delegate_task",
        { task: "Write the interface tests.", title: "Interface tests" }));
      expect(f.active.get(nested.conversationId)?.turnId).toBe(nested.firstTurnId);

      const approval = vi.fn(async (): Promise<AgentApprovalDecision> => "approve");
      const cancelled = parsed<{ taskId: string; status: string }>(await f.invoke("inertia_cancel_task",
        { taskId: view.taskId, reason: "No longer needed" }, { approval }));
      await f.drain();

      expect(cancelled).toEqual({ taskId: view.taskId, status: "cancel_requested" });
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ title: "Cancel delegated task “Cache refactor”",
        detail: `Target ${view.conversationId} · No longer needed` }));
      expect(f.turns.stopped).toEqual([view.firstTurnId, nested.firstTurnId]);
      expect(f.active.get(bystander.conversationId)?.turnId).toBe(bystander.turnId);
      expect(f.service.view(view.taskId)).toMatchObject({ status: "cancelled", delivery: { state: "disposed" } });
      expect(f.service.view(nested.taskId)).toMatchObject({ status: "cancelled", delivery: { state: "disposed" } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();
      expect(f.store.queuedMessages.activeDelegatedDelivery(view.conversationId)).toBeNull();
    } finally { await f.close(); }
  });

  it("never stops a replacement turn that started after the cancel approval was requested", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      let approve!: (decision: AgentApprovalDecision) => void;
      let asked!: () => void;
      const requested = new Promise<void>((resolve) => { asked = resolve; });
      const cancelling = f.invoke("inertia_cancel_task", { taskId: view.taskId }, {
        approval: async () => { asked(); return await new Promise<AgentApprovalDecision>((resolve) => { approve = resolve; }); },
      });
      await requested;
      f.turns.cancel(view.conversationId);
      const replacement = f.beginTurn(view.conversationId, "User's own request");
      f.turns.start(replacement.id);
      approve("approve");
      expect(parsed(await cancelling)).toEqual({ taskId: view.taskId, status: "cancel_requested" });
      expect(f.turns.stopped).toEqual([]);
      expect(f.active.get(view.conversationId)?.turnId).toBe(replacement.id);
      expect(f.service.view(view.taskId).delivery.state).toBe("disposed");
    } finally { await f.close(); }
  });

  it("cancels the child's armed usage-limit resume after its limit, through the scheduler", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const plan = armLimitPlan(f.store, view.conversationId, view.firstTurnId);
      const scheduler = limitScheduler(f.store);
      const schedulerCancel = vi.spyOn(scheduler, "cancel");
      await f.settle(view.firstTurnId, "failed");
      expect(f.store.orchestration.delegation.get(view.taskId)?.result).toBeNull();
      expect(f.service.view(view.taskId).workState).toBe("working");

      const cancelled = parsed<{ status: string }>(await f.invoke("inertia_cancel_task", { taskId: view.taskId }));
      await f.drain();
      expect(cancelled.status).toBe("cancel_requested");
      expect(schedulerCancel).toHaveBeenCalledWith(view.conversationId, plan.id);
      expect(f.store.limitResets.get(view.conversationId)?.state).toBe("cancelled");
      expect(f.service.view(view.taskId)).toMatchObject({ status: "failed", delivery: { state: "disposed" } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();
      expect(f.turns.stopped).toEqual([]);
    } finally { await f.close(); }
  });

  it("cancels as the child's usage limit lands, so nothing is left to resume", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const settling: Promise<void>[] = [];
      vi.spyOn(f.turns, "cancelOwned").mockImplementation((conversationId, identity) => {
        if (f.active.get(conversationId)?.turnId !== identity.turnId) return false;
        f.active.delete(conversationId);
        f.turns.stopped.push(identity.turnId);
        settleTurnRow(f.store, f.database, identity.turnId, "failed");
        f.store.limitResets.markUsageLimited(identity.turnId);
        settling.push(f.service.onTurnSettled(f.store.agentTurn(identity.turnId)));
        return true;
      });

      const cancelled = parsed<{ status: string }>(await f.invoke("inertia_cancel_task", { taskId: view.taskId }));
      await Promise.all(settling);
      await f.drain();
      expect(cancelled.status).toBe("cancel_requested");
      expect(f.turns.stopped).toEqual([view.firstTurnId]);
      expect(f.store.agentTurn(view.firstTurnId).status).toBe("failed");
      expect(f.service.view(view.taskId)).toMatchObject({ status: "failed", delivery: { state: "disposed" } });
      expect(f.store.limitResets.get(view.conversationId)).toBeNull();
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();

      armLimitPlan(f.store, view.conversationId, view.firstTurnId);
      await f.service.onChildEvidence(view.conversationId);
      expect(f.service.view(view.taskId)).toMatchObject({ status: "failed", workState: "result_available",
        delivery: { state: "disposed" } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();
    } finally { await f.close(); }
  });

  it("resumes at the reset and delivers the resumed result when the task is never cancelled", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const plan = armLimitPlan(f.store, view.conversationId, view.firstTurnId);
      await f.settle(view.firstTurnId, "failed");
      expect(f.service.view(view.taskId).workState).toBe("working");

      expect(f.store.limitResets.claim(plan)).toBe(true);
      const child = f.store.conversation(view.conversationId);
      const resumed = f.store.beginAgentTurn({
        id: randomUUID(), conversationId: child.id, runId: randomUUID(), content: "Continue from where you stopped.",
        activateConversation: false, providerId: child.providerId, harnessId: child.modelSelection.harnessId,
        backendProfileId: child.modelSelection.backendProfileId, model: child.modelSelection.modelId,
        modelAlias: child.modelSelection.alias, reasoningEffort: child.modelSelection.reasoningEffort ?? "",
        interactionMode: child.interactionMode, accessMode: child.accessMode, providerSessionBefore: null,
        usageAtStart: null, configurationRevision: child.modelSelection.backendConfigurationRevision,
        association: "authoritative", limitResetPlanId: plan.id,
      }).turn;
      expect(f.store.limitResets.get(view.conversationId)).toMatchObject({ state: "completed", turnId: resumed.id });
      f.turns.start(resumed.id);
      await f.service.onChildEvidence(view.conversationId);
      expect(f.service.view(view.taskId).workState).toBe("working");

      await f.settle(resumed.id, "completed", "Resumed and finished the refactor.");
      expect(f.service.view(view.taskId)).toMatchObject({ status: "completed", delivery: { state: "claimed" },
        result: { turnId: resumed.id, text: "Resumed and finished the refactor." } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)?.delegatedCompletion?.taskIds).toEqual([view.taskId]);
      expect(f.offers).toContain(f.source.id);
    } finally { await f.close(); }
  });

  it("dismisses the child's pending restart continuation when the task is cancelled", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      f.active.delete(view.conversationId);
      markAppUpdateInterrupted(f.database, view.firstTurnId);
      f.store.restartContinuations.createForConversations([{ conversationId: view.conversationId,
        interruptedTurnId: view.firstTurnId, routeIdentity: "route" }]);
      await f.service.onTurnSettled(f.store.agentTurn(view.firstTurnId));
      expect(f.service.view(view.taskId).workState).toBe("working");

      const cancelled = parsed<{ status: string }>(await f.invoke("inertia_cancel_task", { taskId: view.taskId }));
      await f.drain();
      expect(cancelled.status).toBe("cancel_requested");
      expect(f.turns.stopped).toEqual([]);
      expect(f.store.restartContinuations.forConversation(view.conversationId)).toMatchObject({ state: "cancelled",
        error: "The delegated task was cancelled." });
      expect(f.service.view(view.taskId)).toMatchObject({ status: "interrupted", delivery: { state: "disposed" } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();
    } finally { await f.close(); }
  });

  it("refuses a task with nothing running, waiting or armed before asking the user", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      f.active.delete(view.conversationId);
      const approval = vi.fn(async (): Promise<AgentApprovalDecision> => "approve");
      expect(errorCode(await f.invoke("inertia_cancel_task", { taskId: view.taskId }, { approval }))).toBe("task_not_cancellable");
      expect(approval).not.toHaveBeenCalled();

      const finished = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", { ...TASK, title: "Finished" }));
      await f.settle(finished.firstTurnId, "completed", "All done.");
      expect(f.service.view(finished.taskId).delivery.state).toBe("claimed");
      expect(parsed(await f.invoke("inertia_cancel_task", { taskId: finished.taskId })))
        .toEqual({ taskId: finished.taskId, status: "completed" });
      expect(f.service.view(finished.taskId)).toMatchObject({ status: "completed", delivery: { state: "disposed" },
        result: { text: "All done." } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();
    } finally { await f.close(); }
  });

  it("cancels while a provider-managed agent of the child is live", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const running = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      f.live.set(`${running.conversationId}:${running.firstTurnId}`, 1);
      expect(parsed(await f.invoke("inertia_cancel_task", { taskId: running.taskId })))
        .toEqual({ taskId: running.taskId, status: "cancel_requested" });
      expect(f.turns.stopped).toEqual([running.firstTurnId]);

      const waiting = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", { ...TASK, title: "Waiting on agents" }));
      f.live.set(`${waiting.conversationId}:${waiting.firstTurnId}`, 1);
      await f.settle(waiting.firstTurnId, "completed", "Main turn done.");
      expect(f.service.view(waiting.taskId)).toMatchObject({ status: "running", workState: "waiting_for_children" });
      expect(parsed(await f.invoke("inertia_cancel_task", { taskId: waiting.taskId })))
        .toEqual({ taskId: waiting.taskId, status: "cancel_requested" });
      f.live.set(`${waiting.conversationId}:${waiting.firstTurnId}`, 0);
      await f.service.onChildEvidence(waiting.conversationId);
      expect(f.service.view(waiting.taskId)).toMatchObject({ status: "completed", delivery: { state: "disposed" } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();
    } finally { await f.close(); }
  });

  it("serves the user's cancel and read commands without an approval", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const events: ServerEvent[] = [];
      const broadcastSnapshot = vi.fn();
      const handler = createDelegationCommandHandler({ delegation: f.service, send: (_socket, event) => events.push(event),
        broadcastSnapshot });
      const socket = null as unknown as WebSocket;
      await handler(socket, { type: "delegation.task.read", requestId: randomUUID(), payload: { taskId: view.taskId } });
      await handler(socket, { type: "delegation.task.cancel", requestId: randomUUID(), payload: { taskId: view.taskId } });
      await f.drain();
      expect(events.map((event) => event.type === "request.result" ? event.result : null)).toEqual([
        expect.objectContaining({ kind: "delegation.task", task: expect.objectContaining({ taskId: view.taskId, status: "running" }) }),
        { kind: "delegation.task.cancel", taskId: view.taskId, status: "cancel_requested" },
      ]);
      expect(broadcastSnapshot).toHaveBeenCalledOnce();
      expect(f.turns.stopped).toEqual([view.firstTurnId]);
      await expect(handler(socket, { type: "delegation.wake.set", requestId: randomUUID(),
        payload: { taskId: "a".repeat(64), armed: true } })).rejects.toThrow("That delegated task does not exist.");
    } finally { await f.close(); }
  });
});

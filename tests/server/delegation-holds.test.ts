// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import type { DelegatedTaskView } from "../../src/shared/orchestration-delegation";
import type { RuntimeStore } from "../../src/server/database";
import type { StoredLimitResetPlan } from "../../src/server/persistence/limit-reset-repository";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import { createDelegationCommandHandler } from "../../src/server/runtime/commands/delegation-commands";
import {
  createSettingsBackendCommandHandler,
  type SettingsBackendCommandDependencies,
} from "../../src/server/runtime/commands/settings-backend-commands";
import { RestartContinuationScheduler } from "../../src/server/runtime/restart-continuation-scheduler";
import { LimitResetScheduler } from "../../src/server/usage/limit-reset-scheduler";
import { createDelegationManagerFixture, parsed, settleTurnRow } from "../support/delegation-manager-fixture";
import { createDelegationQueueFixture, type DelegationQueueFixture } from "../support/delegation-queue-fixture";
import { cleanupTurnControllerTestDirectories, turnControllerTestIdentity } from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const TASK = { task: "Profile the importer and report the slowest stage.", title: "Importer profile" };

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

function deliveryHandler(f: DelegationQueueFixture, events: ServerEvent[]) {
  return createDelegationCommandHandler({ delegation: f.delegation.service, send: (_socket, event) => events.push(event),
    broadcastSnapshot: () => undefined });
}

async function failParentOnUsageLimit(f: DelegationQueueFixture): Promise<void> {
  f.provider.resolve({ status: "failed", failure: { reason: "provider-error", message: "Usage limit reached.", usageLimited: true } });
  await f.drain();
}

function disarmReasons(database: Database.Database): string[] {
  return (database.prepare(`SELECT json_extract(payload_json, '$.reason') AS reason FROM orchestration_v2_events
    WHERE type = 'delegation.wakes-disarmed' ORDER BY sequence`).all() as { reason: string }[]).map(({ reason }) => reason);
}

describe("delegated task reads in the gap before finalization", () => {
  it("acknowledges a wait that ends between the child turn's end and finalization, with no wake", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const waiting = f.invoke("inertia_wait_for_task", { taskId: view.taskId, timeoutMs: 5_000 });
      await new Promise((resolve) => setImmediate(resolve));
      f.active.delete(view.conversationId);
      settleTurnRow(f.store, f.database, view.firstTurnId, "completed", "Finished in the gap.");
      f.service.signals.notify();

      const result = parsed<DelegatedTaskView>(await waiting);
      expect(result).toMatchObject({ status: "completed", waitTimedOut: false, delivery: { state: "acknowledged" },
        result: { text: "Finished in the gap." } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)).toBeNull();

      await f.service.onTurnSettled(f.store.agentTurn(view.firstTurnId));
      await f.drain();
      expect(f.service.view(view.taskId).delivery.state).toBe("acknowledged");
      expect(f.store.queuedMessages.list(f.source.id)).toEqual([]);
      expect(f.offers).not.toContain(f.source.id);
    } finally { await f.close(); }
  });

  it("acknowledges a status read in the same gap", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      f.active.delete(view.conversationId);
      settleTurnRow(f.store, f.database, view.firstTurnId, "completed", "Read before finalize.");
      const status = parsed<DelegatedTaskView>(await f.invoke("inertia_get_task_status", { taskId: view.taskId }));
      expect(status).toMatchObject({ status: "completed", delivery: { state: "acknowledged" } });
      await f.service.onTurnSettled(f.store.agentTurn(view.firstTurnId));
      await f.drain();
      expect(f.store.queuedMessages.list(f.source.id)).toEqual([]);
    } finally { await f.close(); }
  });

  it("serves task-scoped needsAction in the parent's conversation detail", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const other = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", { ...TASK, title: "Quiet task" }));
      const inputId = randomUUID();
      f.inputs.set(inputId, { id: inputId, providerId: "codex", conversationId: view.conversationId, runId: "run",
        turnId: view.firstTurnId, questions: [{ id: "q", header: "Choice", question: "Which index?", options: [] }],
        autoResolutionMs: null } as never);
      f.inputs.set(randomUUID(), { id: randomUUID(), providerId: "codex", conversationId: other.conversationId, runId: "run",
        turnId: randomUUID(), questions: [{ id: "q", header: "Old", question: "Unrelated turn?", options: [] }],
        autoResolutionMs: null } as never);
      const events: ServerEvent[] = [];
      const dependencies: Pick<ConversationCommandDependencies, "store" | "runtimeSync" | "deletedConversationIds" | "send"
        | "publicError" | "decorateDelegation"> = {
        store: f.store,
        runtimeSync: { ensureConversationSubscription: () => undefined, cursor: () => null } as never,
        deletedConversationIds: new Set(), send: (_socket, event) => { events.push(event); },
        publicError: (error) => String(error), decorateDelegation: (delegation) => f.service.decorateDetail(delegation),
      };
      await createConversationCommandHandler(dependencies as ConversationCommandDependencies)(null as unknown as WebSocket,
        { type: "conversation.detail.load", requestId: randomUUID(), payload: { conversationId: f.source.id } });
      const loaded = events.at(-1);
      if (loaded?.type !== "request.result" || loaded.result.kind !== "conversation.detail" || loaded.result.state !== "ready") {
        throw new Error("The detail did not load.");
      }
      const tasks = loaded.result.detail.delegation?.asParent?.tasks ?? [];
      expect(tasks.find(({ taskId }) => taskId === view.taskId)?.needsAction).toEqual({ kind: "question", turnId: view.firstTurnId });
      expect(tasks.find(({ taskId }) => taskId === other.taskId)?.needsAction).toBeNull();
    } finally { await f.close(); }
  });
});

describe("delegated task holds", () => {
  it("finalizes the task and wakes the parent when the user cancels the child's limit-reset plan", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      const plan = armLimitPlan(f.store, view.conversationId, view.firstTurnId);
      await f.settle(view.firstTurnId, "failed");
      expect(f.store.orchestration.delegation.get(view.taskId)?.result).toBeNull();
      expect(f.service.view(view.taskId).workState).toBe("working");

      limitScheduler(f.store).cancel(view.conversationId, plan.id);
      await vi.waitFor(() => expect(f.service.view(view.taskId)).toMatchObject({ status: "failed",
        delivery: { state: "claimed", generation: 1 } }));
      expect(f.store.limitResets.get(view.conversationId)?.state).toBe("cancelled");
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.source.id)?.delegatedCompletion?.taskIds).toEqual([view.taskId]);
      expect(f.offers).toContain(f.source.id);
    } finally { await f.close(); }
  });

  it("finalizes the task when the child's restart continuation is declined", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      f.active.delete(view.conversationId);
      f.database.prepare(`UPDATE agent_turns SET status = 'interrupted', run_state = 'interrupted', terminal_reason = 'app-update',
        started_at = COALESCE(started_at, requested_at), completed_at = COALESCE(started_at, requested_at) WHERE id = ?`)
        .run(view.firstTurnId);
      f.store.restartContinuations.createForConversations([{ conversationId: view.conversationId,
        interruptedTurnId: view.firstTurnId, routeIdentity: "a route that no longer matches" }]);
      await f.service.onTurnSettled(f.store.agentTurn(view.firstTurnId));
      expect(f.store.orchestration.delegation.get(view.taskId)?.result).toBeNull();
      expect(f.service.view(view.taskId).workState).toBe("working");

      const dispatch = vi.fn(async () => undefined);
      await new RestartContinuationScheduler({ store: f.store, signal: new AbortController().signal, enabled: true,
        held: () => false, busy: () => false, pendingInteraction: () => false, dispatch,
        track: (operation) => operation() }).tick();
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.store.restartContinuations.forConversation(view.conversationId)?.state).toBe("cancelled");
      await vi.waitFor(() => expect(f.service.view(view.taskId)).toMatchObject({ status: "interrupted",
        delivery: { state: "claimed" } }));
      expect(f.offers).toContain(f.source.id);
    } finally { await f.close(); }
  });

  it("keeps a usage-limited parent's tasks and delivers their results after the resume message", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      f.provider.steerSupported = false;
      const { task, childTurn } = await f.delegate(parentTurn);
      await f.completeChild(childTurn, "Result that arrived before the limit.");
      await failParentOnUsageLimit(f);

      expect(f.store.agentTurn(parentTurn.id).status).toBe("failed");
      expect(f.store.limitResets.usageLimited(parentTurn.id)).toBe(true);
      expect(f.delegation.service.view(task.taskId)).toMatchObject({ wakeArmed: true, delivery: { state: "claimed" } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)?.state).toBe("waiting");
      expect(f.parentTurns()).toHaveLength(1);

      const plan = armLimitPlan(f.store, f.parentId, parentTurn.id);
      expect(f.store.limitResets.claim(plan)).toBe(true);
      const resume = f.controller.queue({ conversationId: f.parentId, content: "Continue from where you stopped.",
        limitResetPlanId: plan.id }).turn;
      f.controller.start(resume.id);
      f.provider.emit({ ...turnControllerTestIdentity(f), type: "status", status: "running" });
      expect(f.store.limitResets.get(f.parentId)).toMatchObject({ state: "completed", turnId: resume.id });
      await f.finishActive("completed", "Resumed.");

      const turns = f.parentTurns();
      expect(turns.map(({ id }) => id).slice(0, 2)).toEqual([parentTurn.id, resume.id]);
      expect(turns).toHaveLength(3);
      expect(f.store.message(turns[2]!.userMessageId!).delegatedCompletion?.taskIds).toEqual([task.taskId]);
      expect(f.provider.input?.prompt).toContain("Result that arrived before the limit.");
      expect(disarmReasons(f.database)).toEqual([]);
    } finally { await f.close(); }
  });

  it("releases a usage-limited parent's tasks once its limit-reset plan ends without resuming", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      f.provider.steerSupported = false;
      const { task, childTurn } = await f.delegate(parentTurn);
      await f.completeChild(childTurn, "Held result.");
      await failParentOnUsageLimit(f);
      const plan = armLimitPlan(f.store, f.parentId, parentTurn.id);
      expect(f.delegation.service.view(task.taskId).wakeArmed).toBe(true);

      limitScheduler(f.store).cancel(f.parentId, plan.id);
      await vi.waitFor(() => expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)).toBeNull());
      expect(f.delegation.service.view(task.taskId)).toMatchObject({ wakeArmed: false, delivery: { state: "disposed" },
        result: { text: "Held result." } });
      expect(disarmReasons(f.database)).toEqual(["source-failed"]);
      expect(f.parentTurns()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("keeps results in the inbox while automatic wakes are off and still sends them on request", async () => {
    const f = await createDelegationQueueFixture();
    try {
      f.automatic.enabled = false;
      expect(f.store.appSettings().delegationAutomaticWakes).toBe(false);
      expect(f.store.shellSnapshot().settings.delegationAutomaticWakes).toBe(false);
      const parentTurn = f.startParent();
      const { task, childTurn } = await f.delegate(parentTurn);
      expect(f.delegation.service.view(task.taskId)).toMatchObject({ completionWake: "always", wakeArmed: false });
      await f.completeChild(childTurn, "Inbox result.");
      await f.finishActive();

      expect(f.delegation.service.view(task.taskId)).toMatchObject({ status: "completed", delivery: { state: null },
        result: { text: "Inbox result." } });
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);
      expect(f.parentTurns()).toHaveLength(1);
      expect(f.provider.steerCalls).toEqual([]);
      expect(disarmReasons(f.database)).toEqual(["setting-off"]);

      const events: ServerEvent[] = [];
      await deliveryHandler(f, events)(null as unknown as WebSocket, { type: "delegation.delivery.send", requestId: randomUUID(),
        payload: { parentConversationId: f.parentId } });
      await f.drain();
      expect(events.at(-1)).toMatchObject({ result: { kind: "delegation.delivery", action: "sent", taskIds: [task.taskId] } });
      expect(f.parentTurns()).toHaveLength(2);
      expect(f.store.message(f.parentTurns()[1]!.userMessageId!).delegatedCompletion?.taskIds).toEqual([task.taskId]);
    } finally { await f.close(); }
  });

  it("disarms waiting wakes with setting-off when the user turns automatic wakes off", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const parentTurn = f.startParent();
      f.provider.steerSupported = false;
      const { task, childTurn } = await f.delegate(parentTurn);
      const running = await f.delegate(parentTurn, { title: "Still running" });
      await f.completeChild(childTurn, "Waiting result.");
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)?.state).toBe("waiting");

      const sent: ServerEvent[] = [];
      const dependencies: Pick<SettingsBackendCommandDependencies, "store" | "send" | "broadcastSnapshot" | "automaticWakesTurnedOff"> = {
        store: f.store, send: (_socket, event) => { sent.push(event); }, broadcastSnapshot: () => undefined,
        automaticWakesTurnedOff: (trigger) => f.delegation.automaticWakesTurnedOff(trigger),
      };
      const settings = createSettingsBackendCommandHandler(dependencies as SettingsBackendCommandDependencies);
      await expect(settings(null as unknown as WebSocket, { type: "settings.update", requestId: randomUUID(),
        payload: { delegationAutomaticWakes: false } })).resolves.toBe("mutation");

      expect(f.store.appSettings().delegationAutomaticWakes).toBe(false);
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)).toBeNull();
      expect(f.delegation.service.view(task.taskId)).toMatchObject({ wakeArmed: false, delivery: { state: "pending" } });
      expect(f.delegation.service.view(running.task.taskId)).toMatchObject({ wakeArmed: false, delivery: { state: null } });
      expect(disarmReasons(f.database)).toEqual(["setting-off"]);

      await f.completeChild(running.childTurn, "Late result.");
      await f.finishActive();
      expect(f.parentTurns()).toHaveLength(1);
      expect(f.store.queuedMessages.list(f.parentId)).toEqual([]);

      const events: ServerEvent[] = [];
      await deliveryHandler(f, events)(null as unknown as WebSocket, { type: "delegation.delivery.send", requestId: randomUUID(),
        payload: { parentConversationId: f.parentId } });
      await f.drain();
      expect(f.parentTurns()).toHaveLength(2);
      expect(f.store.message(f.parentTurns()[1]!.userMessageId!).delegatedCompletion?.taskIds?.sort())
        .toEqual([task.taskId, running.task.taskId].sort());
    } finally { await f.close(); }
  });
});

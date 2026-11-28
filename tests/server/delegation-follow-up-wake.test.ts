// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { AgentTurn } from "../../src/shared/contracts";
import type { DelegatedTaskView } from "../../src/shared/orchestration-delegation";
import type { RuntimeStore } from "../../src/server/database";
import { commandFingerprint } from "../../src/server/orchestration-v2/json";
import {
  beginStoreTurn,
  createDelegationManagerFixture,
  errorCode,
  parsed,
  type DelegationManagerFixture,
} from "../support/delegation-manager-fixture";

const TASK = { task: "Refactor the cache layer behind an interface.", title: "Cache refactor" };

function armLimitPlan(store: RuntimeStore, conversationId: string, failedTurnId: string): void {
  store.limitResets.markUsageLimited(failedTurnId);
  store.limitResets.save({ id: randomUUID(), conversationId, failedTurnId, routeIdentity: "route",
    accountIdentity: "account", resetsAt: "2030-01-01T00:00:00.000Z", nextAttemptAt: "2030-01-01T00:00:00.000Z",
    attempts: 0, state: "waiting", error: null, turnId: null });
}

function markAppUpdateInterrupted(database: Database.Database, turnId: string): void {
  database.prepare(`UPDATE agent_turns SET status = 'interrupted', run_state = 'interrupted', terminal_reason = 'app-update',
    started_at = COALESCE(started_at, requested_at), completed_at = COALESCE(started_at, requested_at) WHERE id = ?`).run(turnId);
}

/** An original task with a result, then a follow-up F whose turn starts G1, which finishes and is delivered back. */
async function followUpWithDeliveredTask(f: DelegationManagerFixture) {
  const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
  await f.settle(view.firstTurnId, "completed", "Original report.");
  const sent = parsed<{ taskId: string; turnId: string }>(await f.invoke("inertia_send_message",
    { conversationId: view.conversationId, content: "Now write the fix." }));
  const child = f.store.conversation(view.conversationId);
  const started = f.store.agentTurn(sent.turnId);
  f.turns.start(started.id);
  const g1 = parsed<DelegatedTaskView>(await f.invokeAs({ conversation: child, turn: started }, "inertia_delegate_task",
    { task: "Write the interface tests.", title: "G1" }));
  await f.settle(started.id, "completed", "Started G1.");
  await f.settle(g1.firstTurnId, "completed", "G1 result.");
  const generation = f.store.orchestration.delegation.get(g1.taskId)!.delivery.generation!;
  return { view, followUpId: sent.taskId, childId: child.id, started, g1, generation };
}

type WakeAdmission = "admitted" | "legacy";

/**
 * The wake that delivers G1. "admitted" goes through orchestration admission, which attaches it to the open
 * follow-up; "legacy" is persisted without admission, as a version that never attached wakes left it.
 */
function wakeFor(f: DelegationManagerFixture, setup: Awaited<ReturnType<typeof followUpWithDeliveredTask>>,
  admission: WakeAdmission): AgentTurn {
  const queued = f.database.prepare(`SELECT id FROM queued_messages WHERE conversation_id = ?
    AND json_extract(delegated_completion_json, '$.generation') = ?`).get(setup.childId, setup.generation) as { id: string };
  // Admitted as the queue runtime admits a delivery: the queued row is claimed and accepted with the turn.
  if (admission === "admitted") {
    f.store.orchestration.queue.claim({ conversationId: setup.childId, itemId: queued.id, mode: "run" });
  }
  const wake = beginStoreTurn(f.store, setup.childId, "Delegated task finished", { delegatedCompletion:
    { parentConversationId: setup.childId, generation: setup.generation, taskIds: [setup.g1.taskId] },
  ...(admission === "admitted" ? { queuedMessageId: queued.id } : {}) }, { admit: admission === "admitted" }).turn;
  // The provider start was attempted, as it is for a wake that ran.
  f.database.prepare("UPDATE orchestration_v2_effects SET attempts = 1 WHERE id = ?").run(`start:${commandFingerprint(wake.runId)}`);
  expect(f.store.orchestration.delegation.taskForChildTurn(wake.id)?.taskId ?? null)
    .toBe(admission === "admitted" ? setup.followUpId : null);
  expect(f.store.orchestration.delegation.markDispatched(setup.childId, setup.generation, wake.id)).toBe(true);
  return wake;
}

function delivered(f: DelegationManagerFixture, setup: Awaited<ReturnType<typeof followUpWithDeliveredTask>>, wake: AgentTurn) {
  f.store.orchestration.delegation.settleDelivery(setup.childId, wake.id);
  expect(f.store.orchestration.delegation.get(setup.g1.taskId)!.delivery.state).toBe("delivered");
}

describe("cancelling a follow-up whose wake is running or held", () => {
  it.each(["admitted", "legacy"] as const)("cancels the armed usage-limit resume of the follow-up's %s wake", async (admission) => {
    const f = await createDelegationManagerFixture();
    try {
      const setup = await followUpWithDeliveredTask(f);
      const wake = wakeFor(f, setup, admission);
      armLimitPlan(f.store, setup.childId, wake.id);
      await f.settle(wake.id, "failed");
      delivered(f, setup, wake);
      expect(f.service.view(setup.followUpId)).toMatchObject({ status: "running", workState: "working" });

      const cancelled = await f.invoke("inertia_cancel_task", { taskId: setup.followUpId });
      expect(cancelled.success, cancelled.text).toBe(true);
      await f.drain();
      expect(f.store.limitResets.get(setup.childId)?.state).toBe("cancelled");
      expect(f.service.view(setup.followUpId).delivery.state).toBe("disposed");
    } finally { await f.close(); }
  });

  it.each(["admitted", "legacy"] as const)("dismisses the restart continuation of the follow-up's %s wake", async (admission) => {
    const f = await createDelegationManagerFixture();
    try {
      const setup = await followUpWithDeliveredTask(f);
      const wake = wakeFor(f, setup, admission);
      markAppUpdateInterrupted(f.database, wake.id);
      f.store.restartContinuations.createForConversations([{ conversationId: setup.childId,
        interruptedTurnId: wake.id, routeIdentity: "route" }]);
      await f.service.onTurnSettled(f.store.agentTurn(wake.id));
      delivered(f, setup, wake);
      expect(f.service.view(setup.followUpId).workState).toBe("working");

      const cancelled = await f.invoke("inertia_cancel_task", { taskId: setup.followUpId });
      expect(cancelled.success, cancelled.text).toBe(true);
      await f.drain();
      expect(f.store.restartContinuations.forConversation(setup.childId)?.state).toBe("cancelled");
    } finally { await f.close(); }
  });

  it("stops the follow-up's running wake and reports its approval as needing the user", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const setup = await followUpWithDeliveredTask(f);
      const wake = wakeFor(f, setup, "admitted");
      f.turns.start(wake.id);
      const approvalId = randomUUID();
      f.approvals.set(approvalId, { id: approvalId, providerId: "codex", conversationId: setup.childId, runId: wake.runId,
        turnId: wake.id, kind: "command", title: "Run", detail: null, command: "npm test", cwd: null, reason: null,
        networkScope: null } as never);
      expect(f.service.view(setup.followUpId).needsAction).toEqual({ kind: "approval", turnId: wake.id });
      expect(f.service.prepareCancel(f.source.id, setup.followUpId).identity).toEqual({ turnId: wake.id, runId: wake.runId });
      expect(parsed(await f.invoke("inertia_cancel_task", { taskId: setup.followUpId })))
        .toEqual({ taskId: setup.followUpId, status: "cancel_requested" });
      expect(f.turns.stopped).toContain(wake.id);
    } finally { await f.close(); }
  });
});

describe("a follow-up's scope in the child chat", () => {
  it("does not cancel a task the user started from the child chat", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      await f.settle(view.firstTurnId, "completed", "Original report.");
      const child = f.store.conversation(view.conversationId);
      const userTurn = f.beginTurn(child.id, "The user's own request");
      f.turns.start(userTurn.id);
      const userTask = parsed<DelegatedTaskView>(await f.invokeAs({ conversation: child, turn: userTurn },
        "inertia_delegate_task", { task: "Profile the cache.", title: "Started by the user" }));
      await f.settle(userTurn.id, "completed", "Started one.");

      const sent = parsed<{ taskId: string; turnId: string }>(await f.invoke("inertia_send_message",
        { conversationId: child.id, content: "Now write the fix." }));
      const started = f.store.agentTurn(sent.turnId);
      f.turns.start(started.id);
      const own = parsed<DelegatedTaskView>(await f.invokeAs({ conversation: child, turn: started },
        "inertia_delegate_task", { task: "Write the interface tests.", title: "G1" }));

      expect(parsed(await f.invoke("inertia_cancel_task", { taskId: sent.taskId })))
        .toEqual({ taskId: sent.taskId, status: "cancel_requested" });
      await f.drain();
      expect(f.turns.stopped).toEqual([started.id, own.firstTurnId]);
      expect(f.active.get(userTask.conversationId)?.turnId).toBe(userTask.firstTurnId);
      expect(f.service.view(userTask.taskId)).toMatchObject({ status: "running" });
      // Stopping F's turn disarms the chat's wakes, as any Stop in that chat does; the task itself keeps running.
      expect(f.service.view(userTask.taskId).delivery.state).toBe("disposed");
    } finally { await f.close(); }
  });

  it("is not held by a restart continuation of the user's own turn", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const view = parsed<DelegatedTaskView>(await f.invoke("inertia_delegate_task", TASK));
      await f.settle(view.firstTurnId, "completed", "Original report.");
      const sent = parsed<{ taskId: string; turnId: string }>(await f.invoke("inertia_send_message",
        { conversationId: view.conversationId, content: "Now write the fix." }));
      f.turns.start(sent.turnId);
      const userTurn = f.beginTurn(view.conversationId, "The user's own request");
      markAppUpdateInterrupted(f.database, userTurn.id);
      f.store.restartContinuations.createForConversations([{ conversationId: view.conversationId,
        interruptedTurnId: userTurn.id, routeIdentity: "route" }]);
      await f.settle(sent.turnId, "completed", "Follow-up answer.");
      expect(f.service.view(sent.taskId)).toMatchObject({ status: "completed", result: { text: "Follow-up answer." } });
      expect(errorCode(await f.invoke("inertia_cancel_task", { taskId: sent.taskId }))).toBeUndefined();
    } finally { await f.close(); }
  });
});

// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import { delegatedDeliveryId } from "../../src/server/persistence/queued-message-repository";
import { cleanupTurnControllerTestDirectories } from "../support/turn-controller-runtime";
import { createDelegationFixture, delegationEvents, queuedDeliveries, type DelegationFixture }
  from "../support/delegation-fixture";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

function deliveryRows(fixture: DelegationFixture) {
  return fixture.database.prepare(`SELECT id, state, json_extract(delegated_completion_json, '$.generation') AS generation,
    json_extract(delegated_completion_json, '$.taskIds') AS task_ids FROM queued_messages
    WHERE conversation_id = ? AND delegated_completion_json IS NOT NULL ORDER BY sequence`).all(fixture.parentId) as
    { id: string; state: string; generation: number; task_ids: string }[];
}

function expectOneWakePerGeneration(fixture: DelegationFixture) {
  const generations = deliveryRows(fixture).map(({ generation }) => generation);
  expect(new Set(generations).size).toBe(generations.length);
  expect(deliveryRows(fixture).filter(({ state }) => ["waiting", "dispatching", "blocked"].includes(state)).length)
    .toBeLessThanOrEqual(1);
}

function failQueueWrites(fixture: DelegationFixture, operation: "INSERT" | "UPDATE") {
  fixture.database.exec(`CREATE TRIGGER delegation_fault BEFORE ${operation} ON queued_messages
    WHEN NEW.delegated_completion_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected queue fault'); END`);
  return () => fixture.database.exec("DROP TRIGGER delegation_fault");
}

async function finishedChild(fixture: DelegationFixture, wake: "always" | "settled_only" = "always") {
  const source = fixture.queue(fixture.parentId, "Delegate");
  const delegated = fixture.delegate(source, { wake });
  return { source, ...delegated };
}

describe("delegation fault-injection recovery", () => {
  it("publishes a result that was never finalized before the crash, once", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture);
      await fixture.finish(source);
      await fixture.finish(childTurn, { text: "Recovered result" });
      const report = fixture.delegation.recover();
      expect(report.finalized).toEqual([task.taskId]);
      expect(deliveryRows(fixture)).toMatchObject([{ id: delegatedDeliveryId(fixture.parentId, 1), state: "waiting", generation: 1 }]);
      const events = delegationEvents(fixture);
      expect(fixture.delegation.recover()).toMatchObject({ finalized: [], settled: [] });
      expect(delegationEvents(fixture)).toEqual(events);
      expectOneWakePerGeneration(fixture);
    } finally { fixture.close(); }
  });

  it("rolls back result storage and inbox claim together when the queue write fails", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture);
      await fixture.finish(source);
      await fixture.finish(childTurn);
      const restore = failQueueWrites(fixture, "INSERT");
      const events = delegationEvents(fixture);
      expect(() => fixture.delegation.finalizeIfReady(task.taskId)).toThrow(/injected queue fault/u);
      expect(fixture.delegation.get(task.taskId)).toMatchObject({ status: "running", result: null, delivery: { state: null } });
      expect(fixture.database.prepare("SELECT status FROM delegated_tasks WHERE task_id = ?").get(task.taskId)).toEqual({ status: "running" });
      expect(delegationEvents(fixture)).toEqual(events);
      expect(deliveryRows(fixture)).toEqual([]);
      restore();
      expect(fixture.delegation.recover().finalized).toEqual([task.taskId]);
      expect(fixture.delegation.get(task.taskId)!.delivery).toMatchObject({ state: "claimed", generation: 1 });
      expectOneWakePerGeneration(fixture);
    } finally { fixture.close(); }
  });

  it("keeps a queued delivery and a held queue after a crash before dispatch", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture);
      await fixture.finish(childTurn);
      fixture.delegation.onChildChanged(task.childConversationId);
      fixture.crash(source);
      const before = deliveryRows(fixture);
      expect(before).toHaveLength(1);
      fixture.delegation.recover();
      expect(deliveryRows(fixture)).toEqual(before);
      expect(fixture.runtime.store.latestAgentTurnForConversation(fixture.parentId)).toMatchObject({ id: source.id,
        status: "interrupted", terminalReason: "runtime-crash" });
      expect(fixture.delegation.mailbox(fixture.parentId)).toMatchObject({ phase: "queued", generation: 1 });
      expectOneWakePerGeneration(fixture);
    } finally { fixture.close(); }
  });

  it("re-plans a wake cut by a crash under a new generation", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture);
      await fixture.finish(source);
      await fixture.finish(childTurn);
      fixture.delegation.onChildChanged(task.childConversationId);
      const wake = fixture.wake(fixture.parentId, 1);
      fixture.runtime.controller.start(wake.id);
      fixture.crash(wake);
      const report = fixture.delegation.recover();
      expect(report.settled).toEqual([fixture.parentId]);
      expect(fixture.delegation.get(task.taskId)!.delivery).toMatchObject({ state: "claimed", generation: 2 });
      expect(deliveryRows(fixture).map(({ state, generation }) => [generation, state])).toEqual([[1, "accepted"], [2, "waiting"]]);
      expect(deliveryRows(fixture)[1]!.id).toBe(delegatedDeliveryId(fixture.parentId, 2));
      fixture.delegation.recover();
      expect(deliveryRows(fixture)).toHaveLength(2);
      expectOneWakePerGeneration(fixture);
    } finally { fixture.close(); }
  });

  it("settles a wake that finished before the crash recorded its acknowledgement", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture);
      await fixture.finish(source);
      await fixture.finish(childTurn);
      fixture.delegation.onChildChanged(task.childConversationId);
      await fixture.finish(fixture.wake(fixture.parentId, 1));
      fixture.delegation.recover();
      expect(fixture.delegation.get(task.taskId)!.delivery).toMatchObject({ state: "delivered", generation: 1 });
      expect(deliveryRows(fixture).map(({ state }) => state)).toEqual(["accepted"]);
      expect(fixture.delegation.mailbox(fixture.parentId)).toMatchObject({ phase: "settled", nextGeneration: 2 });
    } finally { fixture.close(); }
  });

  it("re-plans a wake that never crossed provider start", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture);
      await fixture.finish(source);
      await fixture.finish(childTurn);
      fixture.delegation.onChildChanged(task.childConversationId);
      const wake = fixture.wake(fixture.parentId, 1);
      expect(fixture.runtime.controller.failBeforeStart(fixture.parentId, "Could not start")).toBe(true);
      fixture.delegation.settleDelivery(fixture.parentId, wake.id);
      expect(fixture.delegation.get(task.taskId)!.delivery).toMatchObject({ state: "claimed", generation: 2 });
      expectOneWakePerGeneration(fixture);
    } finally { fixture.close(); }
  });

  it("rolls back an acknowledgement whose queue rewrite fails", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const [first, second] = [fixture.delegate(source), fixture.delegate(source)];
      await fixture.finish(source);
      await fixture.finish(first.childTurn);
      await fixture.finish(second.childTurn);
      fixture.delegation.onChildChanged(first.childId);
      fixture.delegation.onChildChanged(second.childId);
      const observer = fixture.queue(fixture.parentId, "Observe");
      const restore = failQueueWrites(fixture, "UPDATE");
      expect(() => fixture.delegation.acknowledge(first.task.taskId, observer.id)).toThrow(/injected queue fault/u);
      expect(fixture.delegation.get(first.task.taskId)!.delivery.state).toBe("claimed");
      expect(JSON.parse(deliveryRows(fixture)[0]!.task_ids)).toEqual([first.task.taskId, second.task.taskId]);
      restore();
      expect(fixture.delegation.acknowledge(first.task.taskId, observer.id)).toBe(true);
      expect(JSON.parse(deliveryRows(fixture)[0]!.task_ids)).toEqual([second.task.taskId]);
    } finally { fixture.close(); }
  });

  it("upgrades settled_only tasks whose blocking wait died with the crashed source turn", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture, "settled_only");
      const disarmed = fixture.delegate(source, { wake: "settled_only" });
      fixture.delegation.disarm({ parentConversationId: fixture.parentId, scope: "conversation", sourceTurnId: null,
        reason: "setting-off", trigger: "settings" });
      fixture.delegation.setWakeArmed(task.taskId, true, "user-rearm");
      await fixture.finish(childTurn);
      fixture.crash(source);
      const report = fixture.delegation.recover();
      expect(report.upgraded).toEqual([task.taskId]);
      expect(fixture.delegation.get(task.taskId)).toMatchObject({ completionWake: "always", delivery: { state: "claimed" } });
      expect(fixture.delegation.get(disarmed.task.taskId)).toMatchObject({ completionWake: "settled_only", wakeArmed: false });
      expect(fixture.delegation.recover().upgraded).toEqual([]);
      const stored = [task.taskId, disarmed.task.taskId].map((taskId) => fixture.delegation.get(taskId));
      fixture.runtime.store.orchestration.events.rebuildProjections();
      expect([task.taskId, disarmed.task.taskId].map((taskId) => fixture.delegation.get(taskId))).toEqual(stored);
      expect(queuedDeliveries(fixture)).toHaveLength(1);
    } finally { fixture.close(); }
  });

  it("rebuilds the task index and turn ownership from the event log with identical reads and planning", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const [first, second, third] = [fixture.delegate(source), fixture.delegate(source), fixture.delegate(source)];
      await fixture.finish(source);
      fixture.delegation.attach(first.task.taskId, first.childTurn.id, "steer");
      await fixture.finish(first.childTurn, { text: "First" });
      await fixture.finish(second.childTurn, { text: "Second" });
      fixture.delegation.onChildChanged(first.childId);
      fixture.delegation.onChildChanged(second.childId);
      const followTurn = fixture.queue(first.childId, "More");
      const { task: followUp } = fixture.followUp(fixture.delegation.get(first.task.taskId)!, source, followTurn);
      const taskIds = [first.task.taskId, second.task.taskId, third.task.taskId, followUp.taskId];
      const snapshot = () => ({
        tasks: fixture.database.prepare("SELECT * FROM delegated_tasks ORDER BY task_id").all(),
        turns: fixture.database.prepare("SELECT * FROM delegated_task_turns ORDER BY child_turn_id").all(),
        reads: taskIds.map((taskId) => fixture.delegation.read(taskId)),
        detail: fixture.delegation.detail(fixture.parentId),
        target: fixture.delegation.followUpTarget(fixture.parentId, first.childId),
        owner: fixture.delegation.taskForChildTurn(followTurn.id)?.taskId,
        queue: deliveryRows(fixture),
        text: fixture.delegation.deliveryText(fixture.parentId, 1),
      });
      const before = snapshot();
      expect(before.tasks).toHaveLength(4);
      expect(before.turns).toHaveLength(4);
      fixture.database.exec("DELETE FROM delegated_task_turns; DELETE FROM delegated_tasks;");
      fixture.database.prepare(`UPDATE queued_messages SET content = 'stale', delegated_completion_json = json_set(
        delegated_completion_json, '$.taskIds', json_array(?)) WHERE id = ?`).run(first.task.taskId, delegatedDeliveryId(fixture.parentId, 1));
      const events = delegationEvents(fixture);
      expect(fixture.delegation.rebuildProjections()).toEqual({ tasks: 4, turns: 4, skipped: [],
        repairedDeliveries: [delegatedDeliveryId(fixture.parentId, 1)] });
      expect(snapshot()).toEqual(before);
      expect(queuedDeliveries(fixture)[0]!.content).toBe(before.text);
      expect(fixture.delegation.planDelivery(fixture.parentId)).toMatchObject({ claimed: [], pending: [], disposed: [] });
      expect(delegationEvents(fixture)).toEqual(events);
      await fixture.finish(third.childTurn, { text: "Third" });
      expect(fixture.delegation.onChildChanged(third.childId).finalized).toEqual([third.task.taskId]);
      expect(JSON.parse(deliveryRows(fixture)[0]!.task_ids)).toEqual([first.task.taskId, second.task.taskId, third.task.taskId]);
      expect(queuedDeliveries(fixture)[0]!.content).toContain(
        "3 of 4 delegated tasks finished: Investigate the cache, Investigate the cache, Investigate the cache");
      expectOneWakePerGeneration(fixture);
    } finally { fixture.close(); }
  });

  it("treats a delivery removed from the queue as dismissed", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childTurn } = await finishedChild(fixture);
      await fixture.finish(source);
      await fixture.finish(childTurn);
      fixture.delegation.onChildChanged(task.childConversationId);
      fixture.runtime.store.queuedMessages.cancel(fixture.parentId, delegatedDeliveryId(fixture.parentId, 1));
      fixture.delegation.recover();
      expect(fixture.delegation.get(task.taskId)!.delivery.state).toBe("disposed");
      expect(fixture.delegation.mailbox(fixture.parentId)).toMatchObject({ phase: "withdrawn" });
      expect(queuedDeliveries(fixture)).toEqual([]);
    } finally { fixture.close(); }
  });
});

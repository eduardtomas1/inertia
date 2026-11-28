// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { activeTaskTurn } from "../../src/server/runtime/delegation/task-view";
import { storeTurnInput } from "../support/delegation-manager-fixture";
import type { AgentTurn } from "../../src/shared/contracts";
import { cleanupTurnControllerTestDirectories, flushTurnControllerTestPromises } from "../support/turn-controller-runtime";
import { createDelegationFixture, delegationEvents, type DelegationFixture } from "../support/delegation-fixture";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

/** A turn that completes without assistant text, as a queued acknowledgement or a silent wake does. */
async function silent(fixture: DelegationFixture, turn: AgentTurn): Promise<AgentTurn> {
  const finished = await fixture.finish(turn, { text: "" });
  expect(finished).toMatchObject({ status: "completed", terminalAssistantMessageId: null });
  return finished;
}

function watcherWake(fixture: DelegationFixture, turn: AgentTurn): void {
  // Only the row's presence matters to the delegated reads; the watcher link behind it does not.
  fixture.database.pragma("foreign_keys = OFF");
  try {
    fixture.database.prepare(`INSERT INTO watcher_wakes (id, link_id, watcher_turn_id, sequence, trigger, state, outcome,
      created_at, settled_at) VALUES (?, ?, ?, 1, 'activity', 'settled', 'silent', ?, ?)`)
      .run(randomUUID(), randomUUID(), turn.id, new Date().toISOString(), new Date().toISOString());
  } finally { fixture.database.pragma("foreign_keys = ON"); }
}

async function finishedOriginal(fixture: DelegationFixture) {
  const source = fixture.queue(fixture.parentId, "Delegate");
  const original = fixture.delegate(source);
  await fixture.finish(original.childTurn, { text: "ORIGINAL-REPORT" });
  fixture.delegation.finalizeIfReady(original.task.taskId);
  expect(fixture.delegation.get(original.task.taskId)!.result).not.toBeNull();
  return { source, ...original };
}

describe("delegated task report (T3 0df1967cf)", () => {
  it("keeps the report when a later turn of the same task ends without text", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: reporting } = fixture.followUp(task, source);
      await fixture.finish(reporting, { text: "REPORT-OK" });
      const acknowledging = fixture.queue(childId, "Sent after the report");
      fixture.delegation.attach(followUp.taskId, acknowledging.id, "send");
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("working");
      await silent(fixture, acknowledging);

      const read = fixture.delegation.read(followUp.taskId)!;
      expect(read).toMatchObject({ status: "completed", workState: "result_available",
        result: { turnId: acknowledging.id, status: "completed" } });
      expect(read.result!.text).toBe("REPORT-OK");
      expect(fixture.delegation.finalizeIfReady(followUp.taskId).finalized).toEqual([followUp.taskId]);
      const finalized = fixture.delegation.read(followUp.taskId)!;
      expect(finalized.task.result).toMatchObject({ turnId: acknowledging.id, runId: acknowledging.runId,
        messageId: fixture.turn(reporting.id).terminalAssistantMessageId });
      expect(finalized.result!.text).toBe("REPORT-OK");
    } finally { fixture.close(); }
  });

  it("looks past a silent wake turn to the report written before the child waited for its own task", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childId, childTurn } = fixture.delegate(source);
      const { task: grandchild, childId: grandchildId, childTurn: grandchildTurn } = fixture.delegate(childTurn, { parentId: childId });
      await fixture.finish(childTurn, { text: "REPORT-OK" });
      await fixture.finish(grandchildTurn, { text: "Grandchild result" });
      fixture.delegation.onChildChanged(grandchildId);
      const wake = await silent(fixture, fixture.wake(childId, 1));
      fixture.delegation.settleDelivery(childId, wake.id);
      expect(fixture.delegation.get(grandchild.taskId)!.delivery.state).toBe("delivered");

      expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([task.taskId]);
      const read = fixture.delegation.read(task.taskId)!;
      expect(read.task.result!.turnId).toBe(wake.id);
      expect(read.result!.text).toBe("REPORT-OK");
    } finally { fixture.close(); }
  });

  it("skips watcher wakes and rolled-back turns on the way back to the report", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childId, childTurn } = fixture.delegate(source);
      await fixture.finish(childTurn, { text: "REPORT-OK" });
      const watcher = fixture.queue(childId, "Watcher note");
      watcherWake(fixture, watcher);
      await fixture.finish(watcher, { text: "WATCHER-NOTE" });
      const rolled = await fixture.finish(fixture.queue(childId, "Try again"), { text: "ROLLED-BACK" });
      const parent = fixture.runtime.store.conversation(fixture.parentId);
      fixture.database.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('rolled-back-turn', ?, ?, ?, 1, '{}')`).run(rolled.id, parent.projectId, childId);
      const last = await silent(fixture, fixture.queue(childId, "Anything else?"));

      const read = fixture.delegation.read(task.taskId)!;
      expect(read.result).toMatchObject({ turnId: last.id, status: "completed", text: "REPORT-OK" });
    } finally { fixture.close(); }
  });

  it("skips a turn that never started on the way back to the report", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: reporting } = fixture.followUp(task, source);
      await fixture.finish(reporting, { text: "REPORT-OK" });
      const never = fixture.queue(childId, "Cancelled before it started");
      fixture.delegation.attach(followUp.taskId, never.id, "send");
      expect(fixture.runtime.controller.cancel(childId)).toBe(true);
      await flushTurnControllerTestPromises();
      expect(fixture.delegation.reads.startCrossed(fixture.delegation.reads.turn(never.id)!)).toBe(false);
      expect(fixture.turn(never.id).status).toBe("cancelled");
      const acknowledging = fixture.queue(childId, "Sent after the cancel");
      fixture.delegation.attach(followUp.taskId, acknowledging.id, "send");
      await silent(fixture, acknowledging);
      expect(fixture.delegation.read(followUp.taskId)!.result).toMatchObject({ turnId: acknowledging.id, text: "REPORT-OK" });
    } finally { fixture.close(); }
  });

  it("does not let watcher wakes crowd the report out of the bounded search", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childId, childTurn } = fixture.delegate(source);
      await fixture.finish(childTurn, { text: "REPORT-OK" });
      for (let index = 0; index < 70; index += 1) {
        const watcher = fixture.queue(childId, `Watcher note ${index}`);
        watcherWake(fixture, watcher);
        await fixture.finish(watcher, { text: `WATCHER-${index}` });
      }
      const last = await silent(fixture, fixture.queue(childId, "Anything else?"));
      expect(fixture.delegation.read(task.taskId)!.result).toMatchObject({ turnId: last.id, text: "REPORT-OK" });
    } finally { fixture.close(); }
  }, 30_000);

  it("stops at another task's turn or a turn that did not complete", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      // The follow-up's only turn is silent; the original's report belongs to another task.
      const { task: followUp, childTurn: followTurn } = fixture.followUp(task, source);
      await silent(fixture, followTurn);
      expect(fixture.delegation.read(followUp.taskId)!.result).toMatchObject({ turnId: followTurn.id, status: "completed",
        text: null });
      fixture.delegation.finalizeIfReady(followUp.taskId);

      // A failed turn between the report and the silent turn ends the search.
      const { task: second, childTurn: reporting } = fixture.followUp(task, source);
      await fixture.finish(reporting, { text: "REPORT-OK" });
      const failing = fixture.queue(childId, "Then this failed");
      fixture.delegation.attach(second.taskId, failing.id, "send");
      await fixture.finish(failing, { status: "failed" });
      const acknowledging = fixture.queue(childId, "Sent after the failure");
      fixture.delegation.attach(second.taskId, acknowledging.id, "send");
      await silent(fixture, acknowledging);
      const read = fixture.delegation.read(second.taskId)!;
      expect(read.result).toMatchObject({ turnId: acknowledging.id, status: "completed", text: null });

      // A turn the task never owned also ends the search for a follow-up.
      fixture.delegation.finalizeIfReady(second.taskId);
      const { task: third, childTurn: thirdReport } = fixture.followUp(task, source);
      await fixture.finish(thirdReport, { text: "REPORT-OK" });
      const userTurn = await fixture.finish(fixture.queue(childId, "Typed by the user in the child"), { text: "USER-REPLY" });
      expect(fixture.delegation.taskForChildTurn(userTurn.id)).toBeNull();
      const thirdSilent = fixture.queue(childId, "Queued after the user");
      fixture.delegation.attach(third.taskId, thirdSilent.id, "send");
      await silent(fixture, thirdSilent);
      expect(fixture.delegation.read(third.taskId)!.result).toMatchObject({ turnId: thirdSilent.id, text: null });
    } finally { fixture.close(); }
  });
});

describe("waiting for children (T3 b79d277cd)", () => {
  it("waits only on delegated tasks the follow-up's own turns started", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      // The user starts a task from the child chat; it is not the follow-up's work.
      const userTurn = fixture.queue(childId, "Typed by the user in the child");
      const unrelated = fixture.delegate(userTurn, { parentId: childId, title: "Started by the user" });
      await fixture.finish(userTurn, { text: "Started one" });
      expect(fixture.delegation.get(unrelated.task.taskId)!.status).toBe("running");

      const { task: followUp, childTurn: followTurn } = fixture.followUp(task, source);
      const own = fixture.delegate(followTurn, { parentId: childId, title: "Started by the follow-up" });
      await fixture.finish(followTurn, { text: "Follow-up answer" });
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("waiting_for_children");
      await fixture.finish(own.childTurn, { text: "Own grandchild" });
      fixture.delegation.onChildChanged(own.childId);
      fixture.delegation.dispose(own.task.taskId, "user-dismiss", "dismiss-own");

      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("result_available");
      expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([followUp.taskId]);
      expect(fixture.delegation.read(followUp.taskId)!.result!.text).toBe("Follow-up answer");
      expect(fixture.delegation.get(unrelated.task.taskId)!.status).toBe("running");
    } finally { fixture.close(); }
  });

  it("counts the wake turns that deliver a follow-up's own tasks as the follow-up's turns", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: started } = fixture.followUp(task, source);
      const first = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(started, { text: "Started G1, will report" });
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("waiting_for_children");
      await fixture.finish(first.childTurn, { text: "G1 result" });
      fixture.delegation.onChildChanged(first.childId);

      // The wake that delivers G1 starts G2 and ends; the follow-up still waits on G2.
      const wake = fixture.wake(childId, 1);
      expect(fixture.delegation.read(followUp.taskId)).toMatchObject({ workState: "working", hasPendingChildTurns: true });
      expect(activeTaskTurn(fixture.delegation, fixture.delegation.get(followUp.taskId)!)).toEqual({ id: wake.id, runId: wake.runId });
      const second = fixture.delegate(wake, { parentId: childId, title: "G2" });
      await fixture.finish(wake, { text: "Started G2" });
      fixture.delegation.settleDelivery(childId, wake.id);
      expect(fixture.delegation.get(first.task.taskId)!.delivery.state).toBe("delivered");
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("waiting_for_children");
      expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([]);

      // The next wake's report becomes the follow-up's result, as T3's wake runs belong to the open follow-up.
      await fixture.finish(second.childTurn, { text: "G2 result" });
      fixture.delegation.onChildChanged(second.childId);
      const report = fixture.wake(childId, 2);
      await fixture.finish(report, { text: "FINAL-REPORT" });
      fixture.delegation.settleDelivery(childId, report.id);
      expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([followUp.taskId]);
      const read = fixture.delegation.read(followUp.taskId)!;
      expect(read.task.result).toMatchObject({ turnId: report.id, status: "completed" });
      expect(read.result!.text).toBe("FINAL-REPORT");
      expect(fixture.delegation.get(task.taskId)!.result!.turnId).not.toBe(report.id);
    } finally { fixture.close(); }
  });

  it("attaches a wake admitted while the follow-up is open to it, whichever task it delivers (T3)", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const userTurn = fixture.queue(childId, "Typed by the user in the child");
      const unrelated = fixture.delegate(userTurn, { parentId: childId, title: "Started by the user" });
      await fixture.finish(userTurn, { text: "Started one" });
      const { task: followUp, childTurn: followTurn } = fixture.followUp(task, source);
      await fixture.finish(followTurn, { text: "Follow-up answer" });
      await fixture.finish(unrelated.childTurn, { text: "Unrelated result" });
      fixture.delegation.onChildChanged(unrelated.childId);
      const wake = fixture.wake(childId, 1);
      expect(fixture.delegation.taskForChildTurn(wake.id)?.taskId).toBe(followUp.taskId);
      expect(delegationEvents(fixture).at(-1)).toBe("delegation.task-turn-attached");
      await fixture.finish(wake, { text: "USER-WAKE" });
      fixture.delegation.settleDelivery(childId, wake.id);
      expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([followUp.taskId]);
      expect(fixture.delegation.read(followUp.taskId)!.result).toMatchObject({ turnId: wake.id, text: "USER-WAKE" });
    } finally { fixture.close(); }
  });

  it("attaches a wake that mixes the follow-up's task with one the user started", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const userTurn = fixture.queue(childId, "Typed by the user in the child");
      const unrelated = fixture.delegate(userTurn, { parentId: childId, title: "Started by the user" });
      await fixture.finish(userTurn, { text: "Started one" });
      const { task: followUp, childTurn: started } = fixture.followUp(task, source);
      const own = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(started, { text: "Started G1" });
      await fixture.finish(own.childTurn, { text: "G1 result" });
      await fixture.finish(unrelated.childTurn, { text: "Gu result" });
      fixture.delegation.onChildChanged(own.childId);
      fixture.delegation.onChildChanged(unrelated.childId);
      const wake = fixture.wake(childId, 1);
      expect(fixture.turn(wake.id)).toBeDefined();
      expect(fixture.runtime.store.message(wake.userMessageId!).delegatedCompletion?.taskIds.slice().sort())
        .toEqual([own.task.taskId, unrelated.task.taskId].sort());
      expect(fixture.delegation.taskForChildTurn(wake.id)?.taskId).toBe(followUp.taskId);
      expect(fixture.delegation.read(followUp.taskId)).toMatchObject({ workState: "working", hasPendingChildTurns: true });
      await fixture.finish(wake, { text: "MIXED-REPORT" });
      fixture.delegation.settleDelivery(childId, wake.id);
      expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([followUp.taskId]);
      expect(fixture.delegation.read(followUp.taskId)!.result).toMatchObject({ turnId: wake.id, text: "MIXED-REPORT" });
    } finally { fixture.close(); }
  });

  it("looks back from a silent wake to the follow-up's earlier report", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: started } = fixture.followUp(task, source);
      const own = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(started, { text: "REPORT-F" });
      await fixture.finish(own.childTurn, { text: "G1 result" });
      fixture.delegation.onChildChanged(own.childId);
      const wake = await silent(fixture, fixture.wake(childId, 1));
      fixture.delegation.settleDelivery(childId, wake.id);
      expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([followUp.taskId]);
      expect(fixture.delegation.read(followUp.taskId)!.result).toMatchObject({ turnId: wake.id, text: "REPORT-F" });
    } finally { fixture.close(); }
  });

  it("keeps a running follow-up wake out of the finalized original's read", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId, childTurn } = await finishedOriginal(fixture);
      const { childTurn: started } = fixture.followUp(task, source);
      const own = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(started, { text: "Started G1" });
      await fixture.finish(own.childTurn, { text: "G1 result" });
      fixture.delegation.onChildChanged(own.childId);
      const wake = fixture.wake(childId, 1);
      fixture.runtime.controller.start(wake.id);
      const original = fixture.delegation.read(task.taskId)!;
      expect(original).toMatchObject({ status: "completed", hasPendingChildTurns: false, latest: null,
        result: { turnId: childTurn.id, text: "ORIGINAL-REPORT" } });
      expect(fixture.delegation.reads.ownsTurn(fixture.delegation.get(task.taskId)!, wake.id)).toBe(false);
    } finally { fixture.close(); }
  });

  it("places a wake an older version left unattached by the turns that started its tasks", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: started } = fixture.followUp(task, source);
      const own = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(started, { text: "Started G1" });
      await fixture.finish(own.childTurn, { text: "G1 result" });
      fixture.delegation.onChildChanged(own.childId);
      const wake = fixture.wake(childId, 1);
      // An upgrade from a version that admitted wakes without attaching them.
      fixture.database.prepare("DELETE FROM delegated_task_turns WHERE child_turn_id = ?").run(wake.id);
      expect(fixture.delegation.taskForChildTurn(wake.id)).toBeNull();
      const tasks = (id: string) => fixture.delegation.get(id)!;
      expect(fixture.delegation.reads.ownsTurn(tasks(followUp.taskId), wake.id)).toBe(true);
      expect(fixture.delegation.reads.ownsTurn(tasks(task.taskId), wake.id)).toBe(false);
      const second = fixture.delegate(wake, { parentId: childId, title: "G2" });
      await fixture.finish(wake, { text: "Started G2" });
      fixture.delegation.settleDelivery(childId, wake.id);
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("waiting_for_children");
      expect(fixture.delegation.get(second.task.taskId)!.status).toBe("running");
    } finally { fixture.close(); }
  });

  it.each(["usage-limit resume", "restart continuation"] as const)(
    "gives a follow-up the %s of its wake, so the resumed turn's report is the result", async (kind) => {
      const fixture = await createDelegationFixture();
      try {
        const { source, task, childId } = await finishedOriginal(fixture);
        const { task: followUp, childTurn: started } = fixture.followUp(task, source);
        const own = fixture.delegate(started, { parentId: childId, title: "G1" });
        await fixture.finish(started, { text: "Started G1" });
        await fixture.finish(own.childTurn, { text: "G1 result" });
        fixture.delegation.onChildChanged(own.childId);
        const wake = fixture.wake(childId, 1);
        expect(fixture.delegation.taskForChildTurn(wake.id)?.taskId).toBe(followUp.taskId);
        const store = fixture.runtime.store;
        let plan: { limitResetPlanId: string } | { restartContinuationPlanId: string };
        if (kind === "usage-limit resume") {
          await fixture.finish(wake, { status: "failed" });
          store.limitResets.markUsageLimited(wake.id);
          const id = randomUUID();
          store.limitResets.save({ id, conversationId: childId, failedTurnId: wake.id, routeIdentity: "route",
            accountIdentity: "account", resetsAt: "2030-01-01T00:00:00.000Z", nextAttemptAt: "2030-01-01T00:00:00.000Z",
            attempts: 0, state: "dispatching", error: null, turnId: null });
          plan = { limitResetPlanId: id };
        } else {
          fixture.runtime.controller.start(wake.id);
          fixture.runtime.provider.resolve({ status: "failed" });
          await flushTurnControllerTestPromises();
          // An update cut the started wake (the fake provider settles only completed or failed turns).
          fixture.database.prepare(`UPDATE agent_turns SET status = 'interrupted', run_state = 'interrupted',
            terminal_reason = 'app-update' WHERE id = ?`).run(wake.id);
          expect(fixture.turn(wake.id).status).toBe("interrupted");
          const [created] = store.restartContinuations.createForConversations([{ conversationId: childId,
            interruptedTurnId: wake.id, routeIdentity: "route" }]);
          fixture.database.prepare("UPDATE restart_continuation_plans SET state = 'dispatching' WHERE id = ?").run(created!.id);
          plan = { restartContinuationPlanId: created!.id };
        }
        fixture.delegation.settleDelivery(childId, wake.id);
        expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("working");

        const resumed = fixture.runtime.controller.queue({ conversationId: childId, content: "Continue.", ...plan }).turn;
        expect(fixture.delegation.taskForChildTurn(resumed.id)?.taskId).toBe(followUp.taskId);
        expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([]);
        await fixture.finish(resumed, { text: "RESUMED-REPORT" });
        expect(fixture.delegation.onChildChanged(childId).finalized).toEqual([followUp.taskId]);
        expect(fixture.delegation.read(followUp.taskId)!.result).toMatchObject({ turnId: resumed.id, status: "completed",
          text: "RESUMED-REPORT" });
      } finally { fixture.close(); }
    });

  it("does not attach a wake to a follow-up that was cancelled", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: started } = fixture.followUp(task, source);
      const own = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(started, { text: "Started G1" });
      await fixture.finish(own.childTurn, { text: "G1 result" });
      fixture.delegation.onChildChanged(own.childId);
      expect(fixture.delegation.dispose(followUp.taskId, "cancelled", "cancel-follow-up")).toBe(true);
      expect(fixture.delegation.get(followUp.taskId)!.result).toBeNull();
      const wake = fixture.wake(childId, 1);
      expect(fixture.delegation.taskForChildTurn(wake.id)).toBeNull();
    } finally { fixture.close(); }
  });

  it("does not attach a delivery steered into the follow-up's running turn, as T3 does not", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: started } = fixture.followUp(task, source);
      const own = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(own.childTurn, { text: "G1 result" });
      fixture.delegation.onChildChanged(own.childId);
      fixture.runtime.controller.start(started.id);
      const attached = () => (fixture.database.prepare("SELECT COUNT(*) AS count FROM delegated_task_turns WHERE task_id = ?")
        .get(followUp.taskId) as { count: number }).count;
      const before = attached();
      expect(fixture.delegation.deliverySteered(childId, 1, started.id)).toBe(true);
      expect(attached()).toBe(before);
      expect(fixture.delegation.get(own.task.taskId)!.delivery.state).toBe("delivered");
      expect(delegationEvents(fixture).filter((type) => type === "delegation.task-turn-attached")).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it("rebuilds a wake's attachment from its event and attaches a replayed admission once", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: started } = fixture.followUp(task, source);
      const own = fixture.delegate(started, { parentId: childId, title: "G1" });
      await fixture.finish(started, { text: "Started G1" });
      await fixture.finish(own.childTurn, { text: "G1 result" });
      fixture.delegation.onChildChanged(own.childId);
      const wake = fixture.wake(childId, 1);
      fixture.delegation.rebuildIndex();
      expect(fixture.delegation.taskForChildTurn(wake.id)?.taskId).toBe(followUp.taskId);
      expect(fixture.delegation.get(followUp.taskId)!.turnIds).toContain(wake.id);
      await fixture.finish(wake, { text: "Wake" });

      // Admitting the same request again answers from its receipt and attaches nothing more.
      const store = fixture.runtime.store;
      const attribution = store.message(wake.userMessageId!).delegatedCompletion!;
      const input = { ...storeTurnInput(store, childId, "Delegated task finished"), delegatedCompletion: attribution };
      const attachedEvents = () => delegationEvents(fixture).filter((type) => type === "delegation.task-turn-attached").length;
      const before = attachedEvents();
      const request = { actorId: "runtime", commandId: `replay-${input.id!}`, command: { type: "replay-probe", id: input.id! } };
      const admitted = store.beginOrchestratedAgentTurn(input, request);
      expect(attachedEvents()).toBe(before + 1);
      expect(store.beginOrchestratedAgentTurn(input, request).turn.id).toBe(admitted.turn.id);
      expect(attachedEvents()).toBe(before + 1);
      expect(fixture.delegation.taskForChildTurn(admitted.turn.id)?.taskId).toBe(followUp.taskId);
    } finally { fixture.close(); }
  });

  it("reads live native children on every one of the task's own turns", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: earlier } = fixture.followUp(task, source);
      await fixture.finish(earlier, { text: "Earlier" });
      const later = fixture.queue(childId, "Sent after");
      fixture.delegation.attach(followUp.taskId, later.id, "send");
      await fixture.finish(later, { text: "Later" });
      fixture.live.set(`${childId}:${earlier.id}`, 1);
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("waiting_for_children");
      fixture.live.clear();
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("result_available");
      // One read for all of the task's own turns, not one per turn.
      const reads: (readonly string[])[] = [];
      fixture.delegation.useLiveNativeChildren((_conversationId, turnIds) => { reads.push(turnIds); return 0; });
      fixture.delegation.read(followUp.taskId);
      expect(reads).toHaveLength(1);
      expect([...reads[0]!].sort()).toEqual([earlier.id, later.id].sort());
    } finally { fixture.close(); }
  });

  it("reads live native children of the task's own latest turn, not the chat's", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: followTurn } = fixture.followUp(task, source);
      await fixture.finish(followTurn, { text: "Follow-up answer" });
      const userTurn = await fixture.finish(fixture.queue(childId, "Typed by the user in the child"), { text: "Later" });

      fixture.live.set(`${childId}:${userTurn.id}`, 1);
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("result_available");
      fixture.live.clear();
      fixture.live.set(`${childId}:${followTurn.id}`, 1);
      expect(fixture.delegation.read(followUp.taskId)!.workState).toBe("waiting_for_children");
      fixture.live.clear();
      expect(fixture.delegation.finalizeIfReady(followUp.taskId).finalized).toEqual([followUp.taskId]);
    } finally { fixture.close(); }
  });
});

describe("provider stop reason on delegated results (T3 c02b98bb3, c440fd19d)", () => {
  const REASON = "Stop hook (project): Tests are still failing.";

  function runPayload(fixture: DelegationFixture, runId: string): Record<string, unknown> {
    const row = fixture.database.prepare("SELECT payload_json FROM orchestration_v2_entities WHERE kind = 'run' AND id = ?")
      .get(runId) as { payload_json: string };
    return JSON.parse(row.payload_json) as Record<string, unknown>;
  }

  it("ends a completed result that has report text with the stop reason, before and after it is frozen", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childTurn } = fixture.delegate(source);
      await fixture.finish(childTurn, { text: "I checked the remaining files.", providerStopReason: REASON });
      expect(runPayload(fixture, childTurn.runId)).toMatchObject({ status: "completed", providerStopReason: REASON });
      const expected = `I checked the remaining files.\n\n${REASON}`;
      expect(fixture.delegation.read(task.taskId)!.result).toMatchObject({ status: "completed", text: expected });
      fixture.delegation.finalizeIfReady(task.taskId);
      expect(fixture.delegation.reads.resultView(fixture.delegation.get(task.taskId)!)!.text).toBe(expected);
    } finally { fixture.close(); }
  });

  it("ends a textless result with the stop reason and does not look back past it", async () => {
    const fixture = await createDelegationFixture();
    try {
      const { source, task, childId } = await finishedOriginal(fixture);
      const { task: followUp, childTurn: reporting } = fixture.followUp(task, source);
      await fixture.finish(reporting, { text: "REPORT-OK" });
      const stopped = fixture.queue(childId, "Sent after the report");
      fixture.delegation.attach(followUp.taskId, stopped.id, "send");
      await fixture.finish(stopped, { text: "", providerStopReason: REASON });

      const read = fixture.delegation.read(followUp.taskId)!;
      expect(read.result).toMatchObject({ turnId: stopped.id, status: "completed", text: `(No result text.)\n\n${REASON}` });
      fixture.delegation.finalizeIfReady(followUp.taskId);
      expect(fixture.delegation.get(followUp.taskId)!.result).toMatchObject({ turnId: stopped.id, messageId: null });
    } finally { fixture.close(); }
  });

  it("ends the result of a turn Codex ended interrupted (settled cancelled) with the stop reason", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childTurn } = fixture.delegate(source);
      const finished = await fixture.finish(childTurn, { status: "cancelled", text: "Partial work", providerStopReason: REASON });
      expect(finished.status).toBe("cancelled");
      expect(runPayload(fixture, childTurn.runId)).toMatchObject({ status: "cancelled", providerStopReason: REASON });
      expect(fixture.delegation.read(task.taskId)!.result).toMatchObject({ status: "cancelled",
        text: `Partial work\n\n${REASON}` });
    } finally { fixture.close(); }
  });

  it("keeps the stop reason when a long report fills the result bound", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childTurn } = fixture.delegate(source);
      await fixture.finish(childTurn, { text: "R".repeat(20_000), providerStopReason: REASON });
      const result = fixture.delegation.read(task.taskId)!.result!;
      expect(result.truncated).toBe(true);
      expect(result.text!.endsWith(`\n\n${REASON}`)).toBe(true);
      expect(Buffer.byteLength(result.text!, "utf8")).toBeLessThanOrEqual(8_000);
    } finally { fixture.close(); }
  });

  function notices(fixture: DelegationFixture, turnId: string) {
    return fixture.database.prepare(`SELECT kind, title, detail, status FROM activities
      WHERE turn_id = ? AND title = 'Stopped by the provider'`).all(turnId);
  }

  it("adds Stopped by the provider at settlement of a completed or cancelled run only", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const completed = fixture.delegate(source);
      await fixture.finish(completed.childTurn, { text: "Done", providerStopReason: REASON });
      expect(notices(fixture, completed.childTurn.id)).toEqual([
        { kind: "status", title: "Stopped by the provider", detail: REASON, status: "completed" }]);
      const interrupted = fixture.delegate(source);
      await fixture.finish(interrupted.childTurn, { status: "cancelled", text: "", providerStopReason: REASON });
      expect(notices(fixture, interrupted.childTurn.id)).toHaveLength(1);
      const failed = fixture.delegate(source);
      await fixture.finish(failed.childTurn, { status: "failed", providerStopReason: REASON });
      expect(notices(fixture, failed.childTurn.id)).toEqual([]);
    } finally { fixture.close(); }
  });

  it("drops the reason when the user's Stop ends the run", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childId, childTurn } = fixture.delegate(source);
      fixture.runtime.controller.start(childTurn.id);
      await flushTurnControllerTestPromises();
      expect(fixture.runtime.controller.cancel(childId)).toBe(true);
      fixture.runtime.provider.resolve({ status: "cancelled", text: "", providerStopReason: REASON });
      await flushTurnControllerTestPromises();
      expect(fixture.turn(childTurn.id).status).toBe("cancelled");
      expect(runPayload(fixture, childTurn.runId)).not.toHaveProperty("providerStopReason");
      expect(notices(fixture, childTurn.id)).toEqual([]);
      expect(fixture.delegation.read(task.taskId)!.result?.text ?? null).toBeNull();
    } finally { fixture.close(); }
  });

  it("keeps the reason when the user's Stop comes after the provider ended the run", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childId, childTurn } = fixture.delegate(source);
      fixture.runtime.provider.deferOwnedStop("settled");
      fixture.runtime.controller.start(childTurn.id);
      await flushTurnControllerTestPromises();
      fixture.runtime.provider.resolve({ status: "completed", text: "Done", providerStopReason: REASON });
      await flushTurnControllerTestPromises();
      // The completed result was taken; the Stop arrives while the provider's cleanup is still pending.
      expect(fixture.turn(childTurn.id).status).not.toBe("completed");
      fixture.runtime.controller.cancel(childId);
      fixture.runtime.provider.resolveOwnedStop();
      await flushTurnControllerTestPromises();
      expect(fixture.turn(childTurn.id).status).toBe("completed");
      expect(runPayload(fixture, childTurn.runId)).toMatchObject({ status: "completed", providerStopReason: REASON });
      expect(notices(fixture, childTurn.id)).toHaveLength(1);
      expect(fixture.delegation.read(task.taskId)!.result!.text).toBe(`Done\n\n${REASON}`);
    } finally { fixture.close(); }
  });

  function failNoticeInsert(fixture: DelegationFixture, raise: "ABORT" | "ROLLBACK"): void {
    // Fails the notice's INSERT itself, inside its savepoint: ABORT ends the statement, ROLLBACK the transaction.
    fixture.database.exec(`CREATE TEMP TRIGGER fail_stop_notice BEFORE INSERT ON activities
      WHEN NEW.title = 'Stopped by the provider' BEGIN SELECT RAISE(${raise}, 'notice insert failed'); END`);
  }

  it("writes the notice from the reason the run recorded, and none when the run records none", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const together = fixture.delegate(source);
      await fixture.finish(together.childTurn, { text: "Done", providerStopReason: REASON });
      const recorded = runPayload(fixture, together.childTurn.runId).providerStopReason;
      expect(recorded).toBe(REASON);
      expect(notices(fixture, together.childTurn.id)).toEqual([
        { kind: "status", title: "Stopped by the provider", detail: recorded, status: "completed" }]);

      // The settlement carries a reason the run's projection does not record: no notice is written for it.
      const orchestration = fixture.runtime.store.orchestration;
      const synchronize = orchestration.synchronize.bind(orchestration);
      const spy = vi.spyOn(orchestration, "synchronize").mockImplementation((turn, observer, delivery, failureCode, unread) =>
        synchronize(turn, observer, delivery, failureCode, unread));
      const unrecorded = fixture.delegate(source);
      await fixture.finish(unrecorded.childTurn, { text: "Done", providerStopReason: REASON });
      spy.mockRestore();
      expect(fixture.turn(unrecorded.childTurn.id).status).toBe("completed");
      expect(runPayload(fixture, unrecorded.childTurn.runId)).not.toHaveProperty("providerStopReason");
      expect(notices(fixture, unrecorded.childTurn.id)).toEqual([]);
    } finally { fixture.close(); }
  });

  it("loses only the notice when its insert statement fails", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childTurn } = fixture.delegate(source);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      failNoticeInsert(fixture, "ABORT");
      const settled = await fixture.finish(childTurn, { text: "Done", providerStopReason: REASON });
      expect(settled.status).toBe("completed");
      expect(runPayload(fixture, childTurn.runId)).toMatchObject({ status: "completed", providerStopReason: REASON });
      expect(notices(fixture, childTurn.id)).toEqual([]);
      expect(fixture.delegation.read(task.taskId)!.result!.text).toBe(`Done\n\n${REASON}`);
      expect(warn).toHaveBeenCalledWith("The provider stop notice could not be written.", "SqliteError");
    } finally { fixture.close(); }
  });

  it("surfaces a failure that ends the settlement's transaction, with nothing half-written", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { childTurn } = fixture.delegate(source);
      const store = fixture.runtime.store;
      const settle = store.settleAgentTurn.bind(store);
      const thrown: unknown[] = [];
      vi.spyOn(store, "settleAgentTurn").mockImplementation((turnId, update) => {
        try { return settle(turnId, update); } catch (error) { thrown.push(error); throw error; }
      });
      failNoticeInsert(fixture, "ROLLBACK");
      const settled = await fixture.finish(childTurn, { text: "Done", providerStopReason: REASON });
      // The original error reached the settlement, not a later "no transaction is active".
      expect(thrown.map((error) => (error as Error).message)).toEqual(["notice insert failed"]);
      expect(fixture.database.inTransaction).toBe(false);
      // The completed settlement was rolled back whole; the runtime then settled the turn as failed on its own.
      expect(settled.status).toBe("failed");
      expect(runPayload(fixture, childTurn.runId)).not.toHaveProperty("providerStopReason");
      expect(notices(fixture, childTurn.id)).toEqual([]);
    } finally { fixture.close(); }
  });

  it("guard: records no stop reason on a failed run, and none that is not bounded text", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const { task, childTurn } = fixture.delegate(source);
      await fixture.finish(childTurn, { status: "failed", providerStopReason: REASON });
      expect(runPayload(fixture, childTurn.runId)).not.toHaveProperty("providerStopReason");
      expect(fixture.delegation.read(task.taskId)!.result!.text).not.toContain(REASON);

      const second = fixture.delegate(source);
      await fixture.finish(second.childTurn, { text: "Done", providerStopReason: "x".repeat(2_001) });
      expect(runPayload(fixture, second.childTurn.runId)).not.toHaveProperty("providerStopReason");
      expect(fixture.delegation.read(second.task.taskId)!.result!.text).toBe("Done");
    } finally { fixture.close(); }
  });
});

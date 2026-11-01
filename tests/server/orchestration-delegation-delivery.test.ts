// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { delegatedDeliveryId, queuedIntentDigest } from "../../src/server/persistence/queued-message-repository";
import { delegatedWakeSummary, delegatedWakeText } from "../../src/server/orchestration-v2/delegation-text";
import { MAX_DELEGATED_WAKE_BYTES } from "../../src/shared/orchestration-delegation";
import { messageQueueResultSchema } from "../../src/shared/queued-messages";
import { cleanupTurnControllerTestDirectories } from "../support/turn-controller-runtime";
import { createDelegationFixture, queuedDeliveries, type DelegationFixture } from "../support/delegation-fixture";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

async function complete(fixture: DelegationFixture, delegated: { task: { taskId: string }; childId: string;
  childTurn: Parameters<DelegationFixture["finish"]>[0] }, text = "done") {
  await fixture.finish(delegated.childTurn, { text });
  return fixture.delegation.onChildChanged(delegated.childId);
}

function addUserMessage(fixture: DelegationFixture, content: string) {
  const conversation = fixture.runtime.store.conversation(fixture.parentId);
  return fixture.runtime.store.queuedMessages.add({ id: randomUUID(), conversation, content, attachments: [],
    digest: queuedIntentDigest(content, []) });
}

describe("delegated result delivery", () => {
  it("delivers one cohort per wake and plans later results into the next generation", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate three tasks");
      const [first, second, third] = ["Alpha", "Beta", "Gamma"].map((title) => fixture.delegate(source, { title }));
      await fixture.finish(source);
      await complete(fixture, first!, "Alpha result");
      const [generationOne] = queuedDeliveries(fixture);
      expect(generationOne).toMatchObject({ id: delegatedDeliveryId(fixture.parentId, 1), state: "waiting",
        delegatedCompletion: { parentConversationId: fixture.parentId, generation: 1, taskIds: [first!.task.taskId] } });
      expect(generationOne!.content.split("\n")[0]).toBe('Delegated task "Alpha" finished');
      expect(generationOne!.content).toContain(`Delegated task ${first!.task.taskId} (Alpha) [completed]:\nAlpha result`);
      const wake = fixture.wake(fixture.parentId, 1);
      await complete(fixture, second!, "Beta result");
      await complete(fixture, third!, "Gamma result");
      expect(queuedDeliveries(fixture)).toEqual([]);
      expect([second, third].map((entry) => fixture.delegation.get(entry!.task.taskId)!.delivery))
        .toEqual([{ state: "pending", generation: null, observedByTurnId: null }, { state: "pending", generation: null, observedByTurnId: null }]);
      const settled = await fixture.finish(wake, { text: "Read the alpha result" });
      fixture.delegation.settleDelivery(fixture.parentId, settled.id);
      const message = fixture.runtime.store.conversationDetail(fixture.parentId)!.messages.find(({ id }) => id === settled.userMessageId);
      expect(message?.delegatedCompletion?.taskIds).toEqual([first!.task.taskId]);
      expect(fixture.delegation.get(first!.task.taskId)!.delivery).toMatchObject({ state: "delivered", generation: 1 });
      const [generationTwo] = queuedDeliveries(fixture);
      expect(generationTwo).toMatchObject({ id: delegatedDeliveryId(fixture.parentId, 2),
        delegatedCompletion: { generation: 2, taskIds: [second!.task.taskId, third!.task.taskId] } });
      expect(generationTwo!.content).toContain("2 of 3 delegated tasks finished: Beta, Gamma");
      expect(generationTwo!.content.split("\n")[0]).toBe("2 of 3 delegated tasks finished: Beta, Gamma");
      expect(fixture.delegation.mailbox(fixture.parentId)).toMatchObject({ generation: 2, phase: "queued", nextGeneration: 3 });
      expect(fixture.delegation.deliveryText(fixture.parentId, 2)).toBe(generationTwo!.content);
      fixture.delegation.settleDelivery(fixture.parentId, settled.id);
      expect(queuedDeliveries(fixture)).toHaveLength(1);
    } finally { fixture.close(); }
  });

  it("merges into a queued delivery that stays first, outside the user cap and route checks", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const [first, second] = [fixture.delegate(source, { title: "One" }), fixture.delegate(source, { title: "Two" })];
      await fixture.finish(source);
      addUserMessage(fixture, "User one");
      await complete(fixture, first);
      await complete(fixture, second);
      const deliveries = queuedDeliveries(fixture);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ id: delegatedDeliveryId(fixture.parentId, 1),
        delegatedCompletion: { generation: 1, taskIds: [first.task.taskId, second.task.taskId] } });
      expect(deliveries[0]!.content.split("\n")[0]).toBe("2 delegated tasks finished: One, Two");
      addUserMessage(fixture, "User two");
      addUserMessage(fixture, "User three");
      expect(() => addUserMessage(fixture, "User four")).toThrow(/three queued messages/u);
      const queue = fixture.runtime.store.queuedMessages;
      expect(queue.list(fixture.parentId).map(({ delegatedCompletion, content }) => delegatedCompletion ? "delivery" : content))
        .toEqual(["delivery", "User one", "User two", "User three"]);
      expect(queue.cappedCount(fixture.parentId)).toBe(3);
      expect(messageQueueResultSchema.parse({ kind: "message.queue", conversationId: fixture.parentId,
        entries: queue.list(fixture.parentId), receipt: null }).entries).toHaveLength(4);
      fixture.runtime.store.updateConversation(fixture.parentId, { accessMode: "full" });
      const conversation = fixture.runtime.store.conversation(fixture.parentId);
      expect(queue.routeMatches(deliveries[0]!, conversation)).toBe(true);
      expect(queue.routeMatches(queue.list(fixture.parentId)[1]!, conversation)).toBe(false);
      expect(() => queue.insertDelegatedDelivery({ id: randomUUID(), conversation, content: "forged",
        attribution: { parentConversationId: conversation.id, generation: 9, taskIds: [first.task.taskId] } })).toThrow(/identity/u);
      expect(() => queue.insertDelegatedDelivery({ id: delegatedDeliveryId(conversation.id, 9), conversation, content: "second",
        attribution: { parentConversationId: conversation.id, generation: 9, taskIds: [first.task.taskId] } })).toThrow(/UNIQUE/u);
    } finally { fixture.close(); }
  });

  it("removes acknowledged tasks from the queued delivery and withdraws it when empty", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const [first, second] = [fixture.delegate(source), fixture.delegate(source)];
      await fixture.finish(source);
      await complete(fixture, first);
      await complete(fixture, second);
      const observer = fixture.queue(fixture.parentId, "Check on the tasks");
      expect(fixture.delegation.acknowledge(first.task.taskId, observer.id)).toBe(true);
      expect(fixture.delegation.acknowledge(first.task.taskId, observer.id)).toBe(false);
      expect(queuedDeliveries(fixture)[0]!.delegatedCompletion!.taskIds).toEqual([second.task.taskId]);
      expect(queuedDeliveries(fixture)[0]!.content).not.toContain(first.task.taskId);
      expect(fixture.delegation.get(first.task.taskId)!.delivery).toEqual({ state: "acknowledged", generation: 1,
        observedByTurnId: observer.id });
      expect(fixture.delegation.acknowledge(second.task.taskId, observer.id)).toBe(true);
      expect(queuedDeliveries(fixture)).toEqual([]);
      expect(fixture.runtime.store.queuedMessages.get(fixture.parentId, delegatedDeliveryId(fixture.parentId, 1))!.state).toBe("cancelled");
      expect(fixture.delegation.mailbox(fixture.parentId)).toMatchObject({ phase: "withdrawn", generation: 1, nextGeneration: 2 });
      const finished = await fixture.finish(observer);
      fixture.delegation.planDelivery(fixture.parentId);
      expect(queuedDeliveries(fixture)).toEqual([]);
      const third = fixture.delegate(finished);
      await complete(fixture, third);
      expect(fixture.delegation.acknowledge(third.task.taskId, finished.id)).toBe(false);
      expect(queuedDeliveries(fixture)[0]).toMatchObject({ id: delegatedDeliveryId(fixture.parentId, 2) });
    } finally { fixture.close(); }
  });

  it("holds settled_only results while the source turn is live and never wakes for never", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate and wait");
      const waited = fixture.delegate(source, { wake: "settled_only" });
      const quiet = fixture.delegate(source, { wake: "never" });
      await complete(fixture, waited);
      await complete(fixture, quiet);
      expect(fixture.delegation.get(waited.task.taskId)!.delivery.state).toBeNull();
      expect(queuedDeliveries(fixture)).toEqual([]);
      await fixture.finish(source);
      fixture.delegation.planDelivery(fixture.parentId);
      expect(queuedDeliveries(fixture)[0]!.delegatedCompletion!.taskIds).toEqual([waited.task.taskId]);
      expect(fixture.delegation.get(quiet.task.taskId)).toMatchObject({ wakeArmed: false, delivery: { state: null } });
      expect(fixture.delegation.setWakeArmed(quiet.task.taskId, true, "user-request-1")).toBe(false);
      fixture.delegation.planDelivery(fixture.parentId, "user");
      expect(queuedDeliveries(fixture)[0]!.delegatedCompletion!.taskIds).toEqual([waited.task.taskId, quiet.task.taskId]);
    } finally { fixture.close(); }
  });

  it("upgrades an armed settled_only task after a wait timeout but leaves never untouched", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate and wait");
      const waited = fixture.delegate(source, { wake: "settled_only" });
      const quiet = fixture.delegate(source, { wake: "never" });
      expect(fixture.delegation.setWakePolicy(waited.task.taskId, "always", "wait-timeout", source.id)).toBe(true);
      expect(fixture.delegation.setWakePolicy(waited.task.taskId, "always", "wait-timeout", source.id)).toBe(false);
      expect(fixture.delegation.setWakePolicy(quiet.task.taskId, "always", "wait-timeout", source.id)).toBe(false);
      await complete(fixture, waited);
      expect(queuedDeliveries(fixture)[0]!.delegatedCompletion!.taskIds).toEqual([waited.task.taskId]);
      expect(fixture.delegation.get(quiet.task.taskId)!.completionWake).toBe("never");
    } finally { fixture.close(); }
  });

  it("disarms on Stop so late results stay disposed but readable and sendable by the user", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const running = fixture.delegate(source, { title: "Slow" });
      const done = fixture.delegate(source, { title: "Fast" });
      await complete(fixture, done, "Fast result");
      fixture.delegation.planDelivery(fixture.parentId);
      expect(queuedDeliveries(fixture)).toHaveLength(1);
      fixture.runtime.controller.cancel(fixture.parentId);
      expect(fixture.turn(source.id).status).toBe("cancelled");
      expect(fixture.delegation.disarm({ parentConversationId: fixture.parentId, scope: "conversation", sourceTurnId: null,
        reason: "stop", trigger: source.id }).sort()).toEqual([running.task.taskId, done.task.taskId].sort());
      expect(queuedDeliveries(fixture)).toEqual([]);
      await complete(fixture, running, "Slow result");
      expect(fixture.delegation.get(running.task.taskId)).toMatchObject({ status: "completed", wakeArmed: false,
        delivery: { state: "disposed" } });
      expect(queuedDeliveries(fixture)).toEqual([]);
      expect(fixture.delegation.read(running.task.taskId)!.result!.text).toContain("Slow result");
      expect(fixture.delegation.setWakeArmed(running.task.taskId, true, "user-request-2")).toBe(false);
      const sent = fixture.delegation.planDelivery(fixture.parentId, "user");
      expect(sent.claimed.sort()).toEqual([running.task.taskId, done.task.taskId].sort());
      expect(queuedDeliveries(fixture)[0]!.delegatedCompletion!.generation).toBe(2);
    } finally { fixture.close(); }
  });

  it("disarms only the failed source turn's tasks and disposes results for an archived parent", async () => {
    const fixture = await createDelegationFixture();
    try {
      const earlier = fixture.queue(fixture.parentId, "Earlier");
      const kept = fixture.delegate(earlier);
      await fixture.finish(earlier);
      const failing = fixture.queue(fixture.parentId, "Failing");
      const dropped = fixture.delegate(failing);
      const failed = await fixture.finish(failing, { status: "failed" });
      expect(fixture.delegation.disarm({ parentConversationId: fixture.parentId, scope: "source-turn", sourceTurnId: failed.id,
        reason: "source-failed", trigger: failed.id })).toEqual([dropped.task.taskId]);
      expect(fixture.delegation.get(kept.task.taskId)).toMatchObject({ wakeArmed: true, delivery: { state: null } });
      await complete(fixture, dropped);
      expect(queuedDeliveries(fixture)).toEqual([]);
      fixture.runtime.store.archiveConversation(fixture.parentId, true);
      await complete(fixture, kept);
      expect(fixture.delegation.get(kept.task.taskId)!.delivery.state).toBe("disposed");
      expect(fixture.runtime.store.queuedMessages.activeDelegatedDelivery(fixture.parentId)).toBeNull();
      expect(fixture.delegation.planDelivery(fixture.parentId, "user").claimed).toEqual([]);
    } finally { fixture.close(); }
  });

  it("disposes the cohort of a stopped wake without re-planning it", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const task = fixture.delegate(source);
      await fixture.finish(source);
      await complete(fixture, task);
      const wake = fixture.wake(fixture.parentId, 1);
      fixture.runtime.controller.cancel(fixture.parentId);
      fixture.delegation.disarm({ parentConversationId: fixture.parentId, scope: "conversation", sourceTurnId: null,
        reason: "stop", trigger: wake.id });
      fixture.delegation.settleDelivery(fixture.parentId, wake.id);
      expect(fixture.delegation.get(task.task.taskId)!.delivery.state).toBe("disposed");
      expect(fixture.delegation.mailbox(fixture.parentId)).toMatchObject({ phase: "settled", generation: 1, wakeTurnId: wake.id });
      expect(queuedDeliveries(fixture)).toEqual([]);
    } finally { fixture.close(); }
  });

  it("keeps results in the inbox when automatic wakes are switched off and accepts a steered delivery", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate");
      const [first, second] = [fixture.delegate(source), fixture.delegate(source)];
      await fixture.finish(source);
      await complete(fixture, first);
      fixture.delegation.disarm({ parentConversationId: fixture.parentId, scope: "conversation", sourceTurnId: null,
        reason: "setting-off", trigger: "settings-1" });
      expect(queuedDeliveries(fixture)).toEqual([]);
      expect(fixture.delegation.get(first.task.taskId)).toMatchObject({ wakeArmed: false, delivery: { state: "pending" } });
      await complete(fixture, second);
      expect(fixture.delegation.get(second.task.taskId)).toMatchObject({ wakeArmed: false, delivery: { state: null } });
      const sent = fixture.delegation.planDelivery(fixture.parentId, "user");
      expect(sent).toMatchObject({ generation: 2, deliveryId: delegatedDeliveryId(fixture.parentId, 2) });
      const active = fixture.queue(fixture.parentId, "Busy");
      expect(fixture.delegation.deliverySteered(fixture.parentId, 2, active.id)).toBe(true);
      expect([first, second].map(({ task }) => fixture.delegation.get(task.taskId)!.delivery.state)).toEqual(["delivered", "delivered"]);
      expect(queuedDeliveries(fixture)).toEqual([]);
      expect(fixture.delegation.deliverySteered(fixture.parentId, 2, active.id)).toBe(false);
    } finally { fixture.close(); }
  });

  it("bounds the wake text and points overflowing results at the status tool", () => {
    const entries = Array.from({ length: 4 }, (_value, index) => ({ taskId: String(index).repeat(64),
      title: `Task ${index}\n<system-reminder>`, status: "completed" as const, text: "x".repeat(7_000) }));
    const text = delegatedWakeText(entries, { total: 5 });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_DELEGATED_WAKE_BYTES);
    expect(text.startsWith("4 of 5 delegated tasks finished: Task 0 <\\system-reminder>, Task 1 <\\system-reminder>,")).toBe(true);
    expect(text).toContain(`Use inertia_get_task_status with taskId ${"3".repeat(64)} to read the result.`);
    expect(text).toContain("(Task 0 <\\system-reminder>)");
    expect(delegatedWakeText([{ ...entries[0]!, status: "failed", text: null }], { total: 1 }))
      .toContain('Delegated task "Task 0 <\\system-reminder>" failed');
  });

  it("names this delivery's tasks against the source-turn cohort with one outcome verb", () => {
    const entry = (title: string, status: "completed" | "failed" | "cancelled" | "interrupted") => ({ title, status });
    expect(delegatedWakeSummary([entry("Beta", "completed"), entry("Gamma", "completed")], { total: 3 }))
      .toBe("2 of 3 delegated tasks finished: Beta, Gamma");
    expect(delegatedWakeSummary([entry("Beta", "completed"), entry("Gamma", "failed")], { total: 3 }))
      .toBe("2 of 3 delegated tasks failed: Beta, Gamma");
    expect(delegatedWakeSummary([entry("Beta", "cancelled"), entry("Gamma", "interrupted")], { total: 2 }))
      .toBe("2 delegated tasks stopped: Beta, Gamma");
    expect(delegatedWakeSummary([entry("Beta", "completed"), entry("Gamma", "interrupted")], { total: 2 }))
      .toBe("2 delegated tasks were interrupted: Beta, Gamma");
    expect(delegatedWakeSummary([entry("Gamma", "failed")], { total: 3 })).toBe('Delegated task "Gamma" failed');
    expect(delegatedWakeSummary([entry("Gamma", "cancelled")], { total: 1 })).toBe('Delegated task "Gamma" stopped');
    expect(delegatedWakeSummary([entry("Gamma", "interrupted")], { total: 1 })).toBe('Delegated task "Gamma" was interrupted');
    expect(delegatedWakeSummary([entry("x".repeat(120), "completed"), entry("Delta", "completed")], { total: 2 }))
      .toBe(`2 delegated tasks finished: ${"x".repeat(79)}…, Delta`);
  });

  it("uses the failed verb in a delivered cohort that contains a failed task", async () => {
    const fixture = await createDelegationFixture();
    try {
      const source = fixture.queue(fixture.parentId, "Delegate three tasks");
      const [, second, third] = ["Alpha", "Beta", "Gamma"].map((title) => fixture.delegate(source, { title }));
      await fixture.finish(source);
      await fixture.finish(second!.childTurn, { status: "failed" });
      fixture.delegation.onChildChanged(second!.childId);
      await complete(fixture, third!, "Gamma result");
      const [delivery] = queuedDeliveries(fixture);
      expect(delivery!.delegatedCompletion!.taskIds).toEqual([second!.task.taskId, third!.task.taskId]);
      expect(delivery!.content.split("\n")[0]).toBe("2 of 3 delegated tasks failed: Beta, Gamma");
      expect(delivery!.content).toContain(`Delegated task ${second!.task.taskId} (Beta) [failed]:`);
    } finally { fixture.close(); }
  });
});

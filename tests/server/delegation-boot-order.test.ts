// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { beginStoreTurn, settleTurnRow } from "../support/delegation-manager-fixture";
import { createDelegationQueueFixture, type DelegationQueueFixture } from "../support/delegation-queue-fixture";
import { cleanupTurnControllerTestDirectories } from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function crashedParent(f: DelegationQueueFixture, reason: string, wake: "always" | "settled_only") {
  const parentTurn = beginStoreTurn(f.store, f.parentId, "Coordinate").turn;
  expect(f.controller.isActive(f.parentId)).toBe(false);
  const delegated = await f.delegate(parentTurn, { wake });
  settleTurnRow(f.store, f.database, delegated.childTurn.id, "completed", "Finished while the app was down.");
  f.database.prepare(`UPDATE agent_turns SET status = 'interrupted', run_state = 'interrupted', terminal_reason = ?,
    started_at = COALESCE(started_at, requested_at), completed_at = COALESCE(started_at, requested_at),
    updated_at = MAX(updated_at, COALESCE(started_at, requested_at)) WHERE id = ?`).run(reason, parentTurn.id);
  expect(f.store.orchestration.delegation.get(delegated.task.taskId)?.result).toBeNull();
  return delegated;
}

describe("delegation boot order", () => {
  it("recovers delegated tasks after queue reconcile and before queue scheduling", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const { task } = await crashedParent(f, "runtime-crash", "settled_only");
      const reconcile = vi.spyOn(f.store.queuedMessages, "reconcile");
      const finalize = vi.spyOn(f.store.orchestration.delegation, "finalizeIfReady");
      const plan = vi.spyOn(f.store.orchestration.delegation, "planDelivery");
      const lanes = vi.spyOn(f.store.orchestration.lanes, "run");
      const pending = vi.spyOn(f.store.queuedMessages, "pendingConversationIds");

      await f.queue.start(() => f.delegation.recover());
      await f.drain();

      expect(reconcile).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledWith(task.taskId);
      expect(pending).toHaveBeenCalledOnce();
      expect(reconcile.mock.invocationCallOrder[0]!).toBeLessThan(finalize.mock.invocationCallOrder[0]!);
      expect(plan.mock.invocationCallOrder.at(-1)!).toBeLessThan(pending.mock.invocationCallOrder[0]!);
      expect(lanes.mock.calls.map(([threadId]) => threadId)).toContain(f.parentId);
      expect(lanes.mock.invocationCallOrder.every((order) => order < pending.mock.invocationCallOrder[0]!)).toBe(true);
      expect(pending.mock.results[0]!.value).toContain(f.parentId);
      expect(f.delegation.service.view(task.taskId)).toMatchObject({ status: "completed", completionWake: "always",
        delivery: { state: "claimed", generation: 1 } });
      expect(f.store.queuedMessages.activeDelegatedDelivery(f.parentId)?.state).toBe("waiting");
      expect(f.parentTurns()).toHaveLength(1);
      expect(f.provider.runCount).toBe(0);
    } finally { await f.close(); }
  });

  it("dispatches the recovered delivery after a planned app-update restart", async () => {
    const f = await createDelegationQueueFixture();
    try {
      const { task } = await crashedParent(f, "app-update", "always");
      await f.queue.start(async () => {
        await f.delegation.recover();
        f.queue.onCompactionSettled(f.parentId);
        await f.drain();
        expect(f.parentTurns()).toHaveLength(1);
      });
      await f.drain();
      expect(f.parentTurns()).toHaveLength(2);
      expect(f.store.message(f.parentTurns()[1]!.userMessageId!).delegatedCompletion?.taskIds).toEqual([task.taskId]);
      expect(f.provider.runCount).toBe(1);
    } finally { await f.close(); }
  });

  it("wires recovery between queue reconcile and scheduling in the runtime entry point", () => {
    const source = readFileSync(resolve("src/server/index.ts"), "utf8");
    const created = source.indexOf("delegation = createDelegationRuntime(");
    const started = source.indexOf("queuedMessages.start(() => delegation?.recover());");
    expect(created).toBeGreaterThan(0);
    expect(started).toBeGreaterThan(created);
    expect(source).toContain("(settled) => delegation?.onTurnSettled(settled),");
    expect(source).toContain("delegation?.observe(event);");
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises, turnControllerTestIdentity } from "../support/turn-controller-runtime";
import { stopOwnedManagedTurn } from "../../src/server/runtime/managed-turn-ownership";
import type { RuntimeStore } from "../../src/server/database";
import type { TurnController } from "../../src/server/runtime/turns/turn-controller";

afterEach(cleanupTurnControllerTestDirectories);
it("reports an accepted follow-up as unconfirmed when its owner ends before acknowledgement", async () => {
  const runtime = await createTurnControllerTestRuntime();
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start" });
  runtime.controller.start(queued.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
  let accept!: (value: boolean) => void;
  vi.spyOn(runtime.provider, "steer").mockImplementation(async () => new Promise<boolean>((resolve) => { accept = resolve; }));
  const lease = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
  const acknowledged = vi.fn();
  const sending = runtime.controller.steer(lease, { content: "Follow up", imagePaths: [] }, [], acknowledged);
  await flushTurnControllerTestPromises();
  runtime.provider.resolve(); await flushTurnControllerTestPromises();
  accept(true);
  await expect(sending).resolves.toEqual({
    kind: "unconfirmed",
    message: "The follow-up was accepted as its turn ended. Check this chat before retrying.",
  });
  expect(acknowledged).toHaveBeenCalledTimes(1);
  lease.release(); await flushTurnControllerTestPromises();
  expect(runtime.store.conversationDetail(runtime.conversationId)?.messages.filter((message) => message.content === "Follow up")).toEqual([]);
  runtime.store.close();
});

it("retains orphaned follow-up images until exact provider cleanup, including a failed first cleanup", async () => {
  const runtime = await createTurnControllerTestRuntime();
  runtime.provider.deferOwnedStop();
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start" });
  runtime.controller.start(queued.turn.id);
  const lease = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
  const cleanup = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("Transient file lock"));
  runtime.controller.deferFollowUpAttachmentCleanup(lease, cleanup);
  lease.release(); runtime.controller.cancel(runtime.conversationId);
  await flushTurnControllerTestPromises(); expect(cleanup).not.toHaveBeenCalled();
  runtime.provider.resolveOwnedStop();
  await flushTurnControllerTestPromises(); expect(cleanup).not.toHaveBeenCalled();
  runtime.provider.resolve({ status: "cancelled" });
  await flushTurnControllerTestPromises();
  expect(cleanup).toHaveBeenCalledTimes(2);
  runtime.store.close();
});

it("rejects cancellation with a stale run or turn owner", async () => {
  const runtime = await createTurnControllerTestRuntime();
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Keep this turn running." });
  runtime.controller.start(queued.turn.id);
  const owner = { turnId: queued.turn.id, runId: queued.turn.runId };
  expect(runtime.controller.activeIdentity(runtime.conversationId)).toEqual(owner);
  expect(runtime.controller.cancelOwned(runtime.conversationId, { ...owner, turnId: "old-turn" })).toBe(false);
  expect(runtime.controller.cancelOwned(runtime.conversationId, { ...owner, runId: "old-run" })).toBe(false);
  expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
  expect(runtime.controller.cancelOwned(runtime.conversationId, owner)).toBe(true);
  await runtime.controller.waitForProviderCleanup([runtime.conversationId]);
  expect(runtime.store.agentTurn(owner.turnId).status).toBe("cancelled");
  runtime.store.close();
});

it("does not report a stopped managed turn while its exact provider ownership remains", async () => {
  const owner = { turnId: "old-turn", runId: "old-run" };
  const store = { providerRunOwnership: { forConversation: () => [owner] } } as unknown as RuntimeStore;
  const turns = { cancelOwned: () => true, waitForProviderCleanup: async () => undefined, activeIdentity: () => null } as unknown as TurnController;
  await expect(stopOwnedManagedTurn(store, turns, "chat", owner)).rejects.toThrow("cleanup was not confirmed");
  const replacement = { providerRunOwnership: { forConversation: () => [{ turnId: "new-turn", runId: "new-run" }] } } as unknown as RuntimeStore;
  await expect(stopOwnedManagedTurn(replacement, turns, "chat", owner)).resolves.toBeUndefined();
});

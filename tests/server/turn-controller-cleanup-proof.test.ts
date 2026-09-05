// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime as testRuntime,
  flushTurnControllerTestPromises as flushPromises,
  turnControllerTestAttachment as testAttachment,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("TurnController exact provider cleanup proof", () => {
  it("retains authority until an exact settled receipt joins a terminal result", async () => {
    const runtime = await testRuntime();
    const attachment = await testAttachment(
      runtime,
      "91919191-9191-4191-8191-919191919191",
      "exact-cleanup.png",
    );
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Join exact cleanup before finalizing.",
      attachments: [attachment],
    });
    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    let confirmCleanup!: (result: "settled") => void;
    const cleanup = new Promise<"settled">((resolve) => {
      confirmCleanup = resolve;
    });
    const stopOwned = vi.spyOn(runtime.provider, "stopOwned")
      .mockReturnValue(cleanup);

    runtime.provider.resolve({ status: "completed", text: "Done." });
    await flushPromises();

    expect(stopOwned).toHaveBeenCalledWith(runtime.conversationId, {
      runId: queued.turn.runId,
      turnId: queued.turn.id,
    });
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "running",
      runState: { state: "cancelling" },
      terminalReason: null,
    });
    expect(runtime.store.providerRunOwnership.forConversation(
      runtime.conversationId,
    )).toHaveLength(1);
    expect(runtime.attachmentReleases).toEqual([]);

    confirmCleanup("settled");
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "completed",
      terminalReason: "provider-completed",
    });
    expect(runtime.store.providerRunOwnership.forConversation(
      runtime.conversationId,
    )).toEqual([]);
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    runtime.store.close();
  });

  it.each([
    { result: "missing" as const, isRunning: false },
    { result: "identity-mismatch" as const, isRunning: true },
  ])(
    "retains authority when synchronous launch cleanup is $result",
    async ({ result, isRunning }) => {
      const runtime = await testRuntime();
      const attachment = await testAttachment(
        runtime,
        result === "missing"
          ? "92929292-9292-4292-8292-929292929292"
          : "93939393-9393-4393-8393-939393939393",
        `${result}.png`,
      );
      vi.spyOn(runtime.provider, "run").mockImplementationOnce(() => {
        throw new Error("provider launch failed after ownership persisted");
      });
      const stopOwned = vi.spyOn(runtime.provider, "stopOwned")
        .mockResolvedValue(result);
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Retain authority without an exact cleanup receipt.",
        attachments: [attachment],
      });
      vi.spyOn(runtime.provider, "isRunning").mockReturnValue(isRunning);
      vi.spyOn(runtime.provider, "ownsRun").mockReturnValue(false);

      expect(runtime.controller.start(queued.turn.id)).toBe(false);
      await flushPromises();

      expect(stopOwned).toHaveBeenCalledWith(runtime.conversationId, {
        runId: queued.turn.runId,
        turnId: queued.turn.id,
      });
      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "running",
        runState: { state: "cancelling" },
        terminalReason: null,
      });
      expect(runtime.store.providerRunOwnership.forConversation(
        runtime.conversationId,
      )).toHaveLength(1);
      expect(runtime.attachmentReleases).toEqual([]);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
      expect(() => runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "A replacement must remain quarantined.",
      })).toThrow("already has an active turn");
      runtime.store.close();
    },
  );

  it("joins settled cleanup after a provider throws synchronously post-start", async () => {
    const runtime = await testRuntime();
    const attachment = await testAttachment(
      runtime,
      "94949494-9494-4494-8494-949494949494",
      "post-start-throw.png",
    );
    const originalRun = runtime.provider.run.bind(runtime.provider);
    vi.spyOn(runtime.provider, "run").mockImplementationOnce((input, callbacks) => {
      void originalRun(input, callbacks);
      throw new Error("provider threw after establishing live ownership");
    });
    vi.spyOn(runtime.provider, "cancel").mockImplementationOnce(() => {
      throw new Error("provider cancellation bridge failed");
    });
    const stopOwned = vi.spyOn(runtime.provider, "stopOwned");
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Prove cleanup after a synchronous post-start throw.",
      attachments: [attachment],
    });

    expect(runtime.controller.start(queued.turn.id)).toBe(false);
    await flushPromises();

    expect(stopOwned).toHaveBeenCalledWith(runtime.conversationId, {
      runId: queued.turn.runId,
      turnId: queued.turn.id,
    });
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "turn-start-failed",
    });
    expect(runtime.store.providerRunOwnership.forConversation(
      runtime.conversationId,
    )).toEqual([]);
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    runtime.store.close();
  });

  it("does not mint provider ownership before host authority is prepared", async () => {
    const runtime = await testRuntime({
      hostToolsForTurn: () => {
        throw new Error("host authority preparation failed");
      },
    });
    const attachment = await testAttachment(
      runtime,
      "95959595-9595-4595-8595-959595959595",
      "host-authority.png",
    );
    const stopOwned = vi.spyOn(runtime.provider, "stopOwned");
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Fail before invoking the provider.",
      attachments: [attachment],
    });

    expect(runtime.controller.start(queued.turn.id)).toBe(false);
    await flushPromises();

    expect(runtime.provider.runCount).toBe(0);
    expect(stopOwned).not.toHaveBeenCalled();
    expect(runtime.store.providerRunOwnership.forConversation(
      runtime.conversationId,
    )).toEqual([]);
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "turn-start-failed",
    });
    expect(runtime.attachmentReleases).toEqual([[attachment.id]]);
    runtime.store.close();
  });

  it("retains authority for a mismatched terminal result", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Reject a stale cleanup claim.",
    });
    runtime.controller.start(queued.turn.id);
    const stopOwned = vi.spyOn(runtime.provider, "stopOwned")
      .mockResolvedValue("identity-mismatch");

    runtime.provider.resolve({
      status: "completed",
      runId: `${queued.turn.runId}-stale`,
    });
    await flushPromises();

    expect(stopOwned).toHaveBeenCalledWith(runtime.conversationId, {
      runId: queued.turn.runId,
      turnId: queued.turn.id,
    });
    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "running",
      runState: { state: "cancelling" },
      terminalReason: null,
    });
    expect(runtime.store.providerRunOwnership.forConversation(
      runtime.conversationId,
    )).toHaveLength(1);
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
    runtime.store.close();
  });
});

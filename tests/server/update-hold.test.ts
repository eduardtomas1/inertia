import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
} from "../support/turn-controller-runtime";
import {
  hold,
  isHeld,
  release,
  scheduleSafetyRelease,
  UPDATE_HOLD_SAFETY_RELEASE_MS,
} from "../../src/server/runtime/update-hold";

afterEach(async () => {
  release();
  vi.useRealTimers();
  await cleanupTurnControllerTestDirectories();
});

describe("update hold", () => {
  it("holds until released and notifies its owner once", () => {
    const released = vi.fn();
    expect(isHeld()).toBe(false);
    hold(released);
    expect(isHeld()).toBe(true);
    release();
    release();
    expect(isHeld()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("never releases on its own while the update run is still working", () => {
    vi.useFakeTimers();
    hold();
    vi.advanceTimersByTime(UPDATE_HOLD_SAFETY_RELEASE_MS * 3);
    expect(isHeld()).toBe(true);
  });

  it("releases ten minutes after the run hands over when the renderer never calls back", () => {
    vi.useFakeTimers();
    const released = vi.fn();
    hold(released);
    scheduleSafetyRelease();
    vi.advanceTimersByTime(UPDATE_HOLD_SAFETY_RELEASE_MS - 1);
    expect(isHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isHeld()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    expect(UPDATE_HOLD_SAFETY_RELEASE_MS).toBe(10 * 60_000);
  });

  it("drops a pending safety release when it is released early", () => {
    vi.useFakeTimers();
    const released = vi.fn();
    hold(released);
    scheduleSafetyRelease();
    release();
    hold();
    vi.advanceTimersByTime(UPDATE_HOLD_SAFETY_RELEASE_MS);
    expect(isHeld()).toBe(true);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("does not arm a safety release without a hold", () => {
    vi.useFakeTimers();
    scheduleSafetyRelease();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("update hold turn admission", () => {
  it("refuses to queue any new turn until the hold is released", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      hold();
      expect(() => runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Start while updating.",
      })).toThrow("Inertia is updating.");
      expect(() => runtime.controller.queuePair("launch", [
        { conversationId: runtime.conversationId, content: "Left." },
        { conversationId: runtime.conversationId, content: "Right." },
      ])).toThrow("Inertia is updating.");
      expect(runtime.store.latestAgentTurnForConversation(runtime.conversationId)).toBeNull();
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);

      release();
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Start after the update.",
      });
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
      runtime.controller.failBeforeStart(runtime.conversationId, "Test cleanup.");
      expect(queued.turn.conversationId).toBe(runtime.conversationId);
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

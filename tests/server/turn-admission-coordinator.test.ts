import { describe, expect, it, vi } from "vitest";

import { TurnAdmissionCoordinator } from "../../src/server/runtime/turns/turn-admission-coordinator";

const conversationId = "11111111-1111-4111-8111-111111111111";

function coordinator() {
  let active = false;
  let goalBlocked = false;
  const waitForGoalIdle = vi.fn(async () => !goalBlocked);
  const admission = new TurnAdmissionCoordinator({
    isClosing: () => false,
    isActive: () => active,
    hasProviderCleanup: () => false,
    waitForProviderCleanup: vi.fn(async () => true),
    blocksForGoalMutation: () => goalBlocked,
    waitForGoalIdle,
  });
  return {
    admission,
    setActive: (value: boolean) => { active = value; },
    setGoalBlocked: (value: boolean) => { goalBlocked = value; },
    waitForGoalIdle,
  };
}

describe("TurnAdmissionCoordinator", () => {
  it("does not install a lease after its deadline", async () => {
    const runtime = coordinator();
    await expect(runtime.admission.acquire(conversationId, 0))
      .resolves.toBeNull();

    const retry = await runtime.admission.acquire(conversationId, 1_000);
    expect(retry).not.toBeNull();
    retry!.release();
  });

  it("enforces exact authority and hands ownership off atomically", async () => {
    const runtime = coordinator();
    const lease = await runtime.admission.acquire(conversationId, 1_000);
    expect(lease).not.toBeNull();
    expect(() => runtime.admission.assertQueueAuthority(conversationId))
      .toThrow("Another message is being prepared");
    expect(() => runtime.admission.assertQueueAuthority(
      conversationId,
      { conversationId, token: Symbol(), release: vi.fn() },
    )).toThrow("Another message is being prepared");
    expect(() => runtime.admission.assertQueueAuthority(conversationId, lease!))
      .not.toThrow();

    const competing = runtime.admission.acquire(conversationId, 1_000);
    runtime.setActive(true);
    runtime.admission.consume(lease!);
    lease!.release();
    await expect(competing).resolves.toBeNull();
    expect(() => runtime.admission.assertQueueAuthority(conversationId, lease!))
      .toThrow("admission expired");
  });

  it("waits for goal mutation idleness and exposes the release barrier", async () => {
    const runtime = coordinator();
    runtime.setGoalBlocked(true);
    await expect(runtime.admission.acquire(conversationId, 1_000))
      .resolves.toBeNull();
    expect(runtime.waitForGoalIdle).toHaveBeenCalled();

    runtime.setGoalBlocked(false);
    const lease = await runtime.admission.acquire(conversationId, 1_000);
    const barrier = runtime.admission.releaseBarrier(conversationId);
    expect(barrier).not.toBeNull();
    lease!.release();
    await expect(barrier).resolves.toBeUndefined();
  });
});

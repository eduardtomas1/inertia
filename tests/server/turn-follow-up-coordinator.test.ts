import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import type { ActiveTurn } from "../../src/server/runtime/turns/turn-controller-types";
import { TurnFollowUpCoordinator } from "../../src/server/runtime/turns/turn-follow-up-coordinator";
import { AuthoritativeRunStateEngine } from "../../src/server/runtime/run-state-engine";
import { snapshotFixture } from "../helpers/snapshot-fixture";

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function activeTurn(): ActiveTurn {
  return {
    conversation: { id: "conversation-1" },
    turn: {
      id: "turn-1",
      runId: "run-1",
      harnessId: "codex-app-server",
    },
    runState: new AuthoritativeRunStateEngine({
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
      providerId: "codex",
    }),
    supportsFollowUpImages: true,
    followUpAdmissions: new Set<Promise<void>>(),
    followUpAdmissionTail: Promise.resolve(),
  } as unknown as ActiveTurn;
}

describe("TurnFollowUpCoordinator", () => {
  it("includes trusted snapshot context only in the provider follow-up", async () => {
    const active = activeTurn();
    const steer = vi.fn(async () => true);
    const persist = vi.fn(() => ({ content: "Inspect this window" }) as ChatMessage);
    const coordinator = new TurnFollowUpCoordinator({
      providers: { steer } as unknown as TurnProviderRuntime,
      store: { createAcknowledgedFollowUpMessage: persist } as unknown as RuntimeStore,
      now: () => "2026-09-08T09:00:00.000Z", activeForConversation: () => active,
    });
    const lease = coordinator.acquire(active)!;
    const attachments = [{ id: "11111111-1111-4111-8111-111111111111", name: "snapshot.png", path: "/trusted/snapshot.png", mimeType: "image/png" as const, size: 4, snapshot: snapshotFixture() }];
    try {
      await coordinator.steer(lease, { content: "Inspect this window", imagePaths: [attachments[0]!.path] }, attachments);
      expect(steer).toHaveBeenCalledWith("conversation-1", expect.objectContaining({ content: expect.stringContaining("untrusted captured application content") }), { runId: "run-1", turnId: "turn-1" });
      expect(persist).toHaveBeenCalledWith("conversation-1", "turn-1", "Inspect this window", lease.submittedAt, "2026-09-08T09:00:00.000Z", attachments);
    } finally { lease.release(); }
  });

  it("serializes acknowledged parent follow-ups FIFO for the exact active turn", async () => {
    const active = activeTurn();
    const acknowledgements: Array<(accepted: boolean) => void> = [];
    const steer = vi.fn(async () => await new Promise<boolean>((resolve) => {
      acknowledgements.push(resolve);
    }));
    const persist = vi.fn((
      _conversationId: string,
      turnId: string,
      content: string,
      _submittedAt?: string,
    ) => ({ turnId, content }) as ChatMessage);
    const coordinator = new TurnFollowUpCoordinator({
      providers: { steer } as unknown as TurnProviderRuntime,
      store: {
        createAcknowledgedFollowUpMessage: persist,
      } as unknown as RuntimeStore,
      now: () => "2026-08-18T00:00:00.000Z",
      activeForConversation: () => active,
    });
    const firstAdmission = coordinator.acquire(active)!;
    const secondAdmission = coordinator.acquire(active)!;
    const first = coordinator.steer(firstAdmission, {
      content: "First follow-up",
      imagePaths: [],
    }, []);
    const second = coordinator.steer(secondAdmission, {
      content: "Second follow-up",
      imagePaths: [],
    }, []);

    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(1);
    acknowledgements[0]!(true);
    await expect(first).resolves.toMatchObject({ content: "First follow-up" });
    firstAdmission.release();
    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(2);
    acknowledgements[1]!(true);
    await expect(second).resolves.toMatchObject({ content: "Second follow-up" });
    secondAdmission.release();
    expect(persist.mock.calls.map(([, , content]) => content)).toEqual([
      "First follow-up",
      "Second follow-up",
    ]);
    expect(persist.mock.calls.map(([, , , submittedAt]) => submittedAt))
      .toEqual([
        "2026-08-18T00:00:00.000Z",
        "2026-08-18T00:00:00.001Z",
      ]);
  });

  it("does not dispatch a queued follow-up after its owner is cancelled", async () => {
    const steer = vi.fn(async () => true);
    const active = activeTurn();
    const coordinator = new TurnFollowUpCoordinator({
      store: {
        createAcknowledgedFollowUpMessage: vi.fn(),
      } as never,
      providers: { steer } as never,
      now: () => "2026-08-21T10:00:00.000Z",
      activeForConversation: () => active,
    });
    const blocker = coordinator.acquire(active);
    const cancelled = coordinator.acquire(active);
    expect(blocker).not.toBeNull();
    expect(cancelled).not.toBeNull();
    const controller = new AbortController();
    const pending = coordinator.steer(
      cancelled!,
      { content: "Do not dispatch this cancelled follow-up", imagePaths: [] },
      [],
      undefined,
      controller.signal,
    );

    controller.abort();
    blocker!.release();

    await expect(pending).resolves.toBeNull();
    expect(steer).not.toHaveBeenCalled();
    cancelled!.release();
  });

  it("persists provider-accepted work when the caller aborts during admission", async () => {
    let accept!: (accepted: boolean) => void;
    const steer = vi.fn(async () => await new Promise<boolean>((resolve) => {
      accept = resolve;
    }));
    const persist = vi.fn((
      _conversationId: string,
      turnId: string,
      content: string,
    ) => ({ turnId, content }) as ChatMessage);
    const acknowledged = vi.fn();
    const active = activeTurn();
    const coordinator = new TurnFollowUpCoordinator({
      store: {
        createAcknowledgedFollowUpMessage: persist,
      } as never,
      providers: { steer } as never,
      now: () => "2026-08-21T10:00:00.000Z",
      activeForConversation: () => active,
    });
    const admission = coordinator.acquire(active)!;
    const controller = new AbortController();
    const pending = coordinator.steer(
      admission,
      { content: "Keep the provider-accepted follow-up", imagePaths: [] },
      [],
      acknowledged,
      controller.signal,
    );

    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(1);
    controller.abort();
    accept(true);

    await expect(pending).resolves.toMatchObject({
      turnId: active.turn.id,
      content: "Keep the provider-accepted follow-up",
    });
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    admission.release();
  });

  it("does not acknowledge or persist a follow-up when its owner settles during provider steering", async () => {
    let accept!: (accepted: boolean) => void;
    const steer = vi.fn(async () => await new Promise<boolean>((resolve) => {
      accept = resolve;
    }));
    const persist = vi.fn();
    const acknowledged = vi.fn();
    const active = activeTurn();
    const coordinator = new TurnFollowUpCoordinator({
      store: {
        createAcknowledgedFollowUpMessage: persist,
      } as never,
      providers: { steer } as never,
      now: () => "2026-08-21T10:00:00.000Z",
      activeForConversation: () => active,
    });
    const admission = coordinator.acquire(active)!;
    const pending = coordinator.steer(
      admission,
      { content: "Do not persist after Stop", imagePaths: [] },
      [],
      acknowledged,
    );

    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(1);
    active.runState.requestTerminal("cancelled", "test-cancelled");
    accept(true);

    await expect(pending).resolves.toBeNull();
    expect(acknowledged).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    admission.release();
  });
});

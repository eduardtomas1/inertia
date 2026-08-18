import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import type { ActiveTurn } from "../../src/server/runtime/turns/turn-controller-types";
import { TurnFollowUpCoordinator } from "../../src/server/runtime/turns/turn-follow-up-coordinator";

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("TurnFollowUpCoordinator", () => {
  it("serializes acknowledged parent follow-ups FIFO for the exact active turn", async () => {
    const active = {
      conversation: { id: "conversation-1" },
      turn: {
        id: "turn-1",
        runId: "run-1",
        harnessId: "codex-app-server",
      },
      acceptingProviderEvents: true,
      settled: false,
      supportsFollowUpImages: true,
      followUpAdmissions: new Set<Promise<void>>(),
      followUpAdmissionTail: Promise.resolve(),
    } as ActiveTurn;
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

});

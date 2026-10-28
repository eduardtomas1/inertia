// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import { PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS } from "../../src/shared/run-state";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("turn provider activity on the conversation shell", () => {
  it("adds the live provider activity time to the latest turn and republishes the shell when it moves", async () => {
    let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const broadcastConversationShell = vi.fn();
    const runtime = await createTurnControllerTestRuntime(
      { broadcastConversationShell },
      { clock: () => new Date(nowMs) },
    );
    try {
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Keep working quietly.",
      });
      expect(runtime.controller.start(queued.turn.id)).toBe(true);
      await flushTurnControllerTestPromises();
      const startedAt = new Date(nowMs).toISOString();
      const shell = () => runtime.controller.withProviderActivity(
        runtime.store.conversationShell(runtime.conversationId)!,
      );
      expect(shell().latestTurn).toMatchObject({ id: queued.turn.id, providerActivityAt: startedAt });
      const event = { type: "conversation.shell.updated", conversation: shell(), runs: [] };
      expect(serverEventSchema.safeParse(event).success).toBe(true);
      expect(serverEventSchema.safeParse({
        ...event,
        conversation: { ...event.conversation, latestTurn: { ...event.conversation.latestTurn, providerActivityAt: 5 } },
      }).success).toBe(false);

      const publishedBefore = broadcastConversationShell.mock.calls.length;
      nowMs += PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS;
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      expect(broadcastConversationShell.mock.calls.length).toBeGreaterThan(publishedBefore);
      expect(shell().latestTurn?.providerActivityAt).toBe(new Date(nowMs).toISOString());

      runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();
      expect(shell().latestTurn).not.toHaveProperty("providerActivityAt");
    } finally {
      runtime.store.close();
    }
  });
});

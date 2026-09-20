// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { sidebarThreadView } from "../../src/renderer/src/utils/sidebarModel";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe.each(["codex", "claude", "cursor", "kimi", "opencode", "antigravity"] as const)(
  "%s terminal state presented to the user",
  (providerId) => {
    it.each(["completed", "failed", "cancelled"] as const)(
      "leaves Working after %s and cannot be revived by late provider events",
      async (status) => {
        const runtime = await createTurnControllerTestRuntime({}, {
          modelSelection: providerNativeModelSelection({ providerId }),
        });
        try {
          const queued = runtime.controller.queue({
            conversationId: runtime.conversationId,
            content: "Finish this response.",
          });
          runtime.controller.start(queued.turn.id);
          const identity = turnControllerTestIdentity(runtime);
          runtime.provider.emit({ ...identity, type: "text", text: "The answer is visible." });
          const view = () => sidebarThreadView(
            runtime.store.conversation(runtime.conversationId),
            runtime.conversationId,
            runtime.store.snapshot().runs,
          );
          // Text alone does not prove the provider or its children have stopped.
          expect(view().status).toBe("working");
          expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);

          runtime.provider.resolve({ status, text: "The answer is visible." });
          await flushTurnControllerTestPromises();
          const turn = runtime.store.agentTurn(queued.turn.id);
          expect(turn).toMatchObject({
            status,
            runState: { state: status },
            completedAt: expect.any(String),
          });
          expect(runtime.provider.stopOwnedCalls).toEqual([{
            conversationId: runtime.conversationId,
            identity: { runId: queued.turn.runId, turnId: queued.turn.id },
          }]);
          expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId))
            .toEqual([]);
          expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
          const visibleStatus = status === "cancelled" ? "idle" : status;
          expect(view().status).toBe(visibleStatus);

          runtime.provider.emit({ ...identity, type: "status", status: "running" });
          runtime.provider.emit({ ...identity, type: "text", text: "Late stale response." });
          await flushTurnControllerTestPromises();
          expect(runtime.store.agentTurn(queued.turn.id)).toEqual(turn);
          expect(view().status).toBe(visibleStatus);
          expect(runtime.store.conversationDetail(runtime.conversationId)!.messages
            .map((message) => message.content).join("\n"))
            .not.toContain("Late stale response.");
        } finally {
          await runtime.controller.dispose();
          runtime.store.close();
        }
      },
    );
  },
);

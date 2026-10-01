// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("project memory at provider dispatch", () => {
  it.each(["codex", "claude", "cursor", "kimi", "opencode", "antigravity"] as const)(
    "delivers current curated context to %s and freezes it with the turn",
    async (providerId) => {
      const runtime = await createTurnControllerTestRuntime({
        providerInfo: () => [{ ...turnControllerTestProviderInfo(), id: providerId }],
      }, { modelSelection: providerNativeModelSelection({ providerId, modelId: "gpt-test" }) });
      try {
        const { projectId } = runtime.store.conversation(runtime.conversationId);
        const id = randomUUID();
        const entry = { kind: "decision" as const, title: "Billing", text: "Preserve the snapshot", reason: "It protects prior-cycle changes" };
        // The shared dispatch preparation captures the project snapshot.
        const state = runtime.store.projectMemory.save({ projectId, conversationId: runtime.conversationId,
          expectedRevision: 0, id, mode: "create", entry });
        const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Fix the invoice." });
        expect(runtime.controller.start(queued.turn.id)).toBe(true);
        expect(runtime.provider.input?.providerId).toBe(providerId);
        expect(runtime.provider.input?.prompt).toContain(entry.reason);
        expect(runtime.store.message(queued.message.id).content).toBe("Fix the invoice.");
        const scope = { projectId, conversationId: runtime.conversationId, turnId: queued.turn.id };
        expect(runtime.store.projectMemory.sentContext(scope)).toBe(state.context);
        runtime.store.projectMemory.save({ projectId, expectedRevision: 1, id, mode: "update",
          entry: { ...entry, reason: "An updated reason for future turns" } });
        runtime.store.projectMemory.toggle({ projectId, conversationId: runtime.conversationId,
          expectedRevision: 2, expectedChatRevision: 0, id, enabled: false });
        expect(runtime.store.projectMemory.sentContext(scope)).toBe(state.context);
        runtime.provider.resolve();
        await flushTurnControllerTestPromises();
        const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Check again." });
        expect(runtime.controller.start(next.turn.id)).toBe(true);
        expect(runtime.provider.input?.prompt).not.toContain(entry.reason);
        expect(runtime.provider.input?.prompt).not.toContain("An updated reason");
        expect(runtime.store.projectMemory.sentContext({ ...scope, turnId: next.turn.id })).toContain('"entries": []');
        const foreign = runtime.store.createConversation(projectId, "Another chat");
        expect(() => runtime.store.projectMemory.sentContext({ ...scope, conversationId: foreign.id })).toThrow("does not belong");
        runtime.provider.resolve();
        await flushTurnControllerTestPromises();
      } finally { runtime.store.close(); }
    },
  );
});

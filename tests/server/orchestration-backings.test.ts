// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function handoffRuntime() {
  const runtime = await createTurnControllerTestRuntime();
  const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original context" });
  runtime.controller.start(first.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "original-native" });
  runtime.provider.resolve({ text: "Original answer", sessionId: "original-native" });
  await flushTurnControllerTestPromises();
  runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
  return runtime;
}

describe("durable native provider backings and context delivery", () => {
  it("switches back to an earlier provider session with only the missing context", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original Codex request" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ text: "Original Codex answer", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity };
      const original = runtime.store.orchestration.backings.find(lookup)!;
      expect(original.status).toBe("ready");
      expect(original.coveredItemIds).toContain(first.message.id);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
        modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
      const other = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Claude follow-up" });
      expect(runtime.store.orchestration.backings.handoff(other.turn.runId)?.state).toBe("prepared");
      runtime.controller.start(other.turn.id);
      expect(runtime.store.orchestration.backings.handoff(other.turn.runId)?.state).toBe("dispatching");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "claude-native" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Claude new answer" });
      expect(runtime.store.orchestration.backings.handoff(other.turn.runId)?.state).toBe("delivered");
      runtime.provider.resolve({ sessionId: "claude-native" });
      await flushTurnControllerTestPromises();
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(returned.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(returned.turn.runId)!;
      expect(handoff.targetBackingId).toBe(original.id);
      expect(handoff.itemIds).toContain(other.message.id);
      expect(handoff.itemIds).not.toContain(first.message.id);
      runtime.controller.start(returned.turn.id);
      expect(runtime.provider.input?.sessionId).toBe("codex-native");
      expect(runtime.provider.input?.prompt).toContain("Claude new answer");
      expect(runtime.provider.input?.prompt).not.toContain("Original Codex answer");
      runtime.provider.resolve({ sessionId: "codex-native", text: "Returned successfully" });
      await flushTurnControllerTestPromises();
      const updated = runtime.store.orchestration.backings.find(lookup)!;
      expect(updated.coveredItemIds).toContain(other.message.id);
      expect(updated.status).toBe("ready");
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.backings.find(lookup)).toEqual(updated);
    } finally { runtime.store.close(); }
  });

  it("retains uncertain delivery across a runtime restart and refuses native reuse", async () => {
    const runtime = await handoffRuntime();
    const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Request before crash" });
    runtime.controller.start(first.turn.id);
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "uncertain-native" });
    const lookup = { threadId: runtime.conversationId, providerId: "claude", workspaceKey: runtime.workspace,
      identity: first.turn.continuationIdentity };
    expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("uncertain");
    runtime.provider.resolve({ status: "failed", sessionId: "uncertain-native", text: "" });
    await flushTurnControllerTestPromises();
    runtime.store.close();
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(reopened.orchestration.backings.find(lookup)?.status).toBe("uncertain");
      expect(reopened.orchestration.backings.find({ ...lookup, workspaceKey: `${runtime.workspace}-different` })).toBeNull();
      expect(reopened.orchestration.backings.find({ ...lookup, threadId: "other-thread" })).toBeNull();
    } finally { reopened.close(); }
  });

  it("does not treat a failed, silent native request as delivered context", async () => {
    const runtime = await handoffRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "unconfirmed-native" });
      runtime.provider.resolve({ status: "failed", sessionId: "unconfirmed-native", text: "" });
      await flushTurnControllerTestPromises();
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Retry with fresh context" });
      expect(next.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)?.state).toBe("prepared");
      runtime.controller.start(next.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "second-unconfirmed" });
      runtime.provider.resolve({ status: "failed", sessionId: "second-unconfirmed", text: "" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)?.state).toBe("uncertain");
    } finally { runtime.store.close(); }
  });
});

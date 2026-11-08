// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderBackgroundWorkSession } from "../../src/server/provider/contracts";
import { ContextHandoffBackgroundWorkError } from "../../src/server/runtime/turns/turn-context-handoff";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const usage = (usedTokens: number) => ({
  usedTokens, totalProcessedTokens: usedTokens, totalProcessedScope: "run" as const, maxTokens: 128_000,
  inputTokens: usedTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
  reasoningOutputTokens: 0, compactsAutomatically: false,
});

async function exhaustedRuntime(options: { usedTokens?: number; codexAnswer?: string } = {}) {
  const runtime = await createTurnControllerTestRuntime();
  const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original Codex request" });
  runtime.controller.start(first.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
  if (options.usedTokens !== undefined) {
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "usage", usage: usage(options.usedTokens) });
  }
  runtime.provider.resolve({ text: options.codexAnswer ?? "Original Codex answer", sessionId: "codex-native" });
  await flushTurnControllerTestPromises();
  const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
    identity: first.turn.continuationIdentity };
  const original = runtime.store.orchestration.backings.find(lookup)!;
  expect(original.status).toBe("ready");
  runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
  const other = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Claude follow-up" });
  runtime.controller.start(other.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "claude-native" });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Claude intervening answer" });
  runtime.provider.resolve({ sessionId: "claude-native" });
  await flushTurnControllerTestPromises();
  runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
  return { runtime, first, other, lookup, original };
}

function threadEvents(runtime: TurnControllerTestRuntime) {
  const { projectId } = runtime.store.conversation(runtime.conversationId);
  return runtime.store.orchestration.events.readEvents({ projectId, threadId: runtime.conversationId, limit: 500 });
}

describe("context exhaustion on a resumed native session", () => {
  it("replaces an exhausted session with a fresh one carrying the full history under one handoff record", async () => {
    const { runtime, first, other, lookup, original } = await exhaustedRuntime({ usedTokens: 120_000 });
    try {
      const probes: ProviderBackgroundWorkSession[] = [];
      Object.assign(runtime.provider, { pendingBackgroundWork: (session: ProviderBackgroundWorkSession) => {
        probes.push(session);
        return "none";
      } });
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(probes).toEqual([expect.objectContaining({ conversationId: runtime.conversationId, providerId: "codex",
        nativeSessionId: "codex-native" })]);
      expect(returned.turn.providerSessionBefore).toBeNull();
      const handoff = runtime.store.orchestration.backings.handoff(returned.turn.runId)!;
      expect(handoff).toMatchObject({ targetBackingId: null, state: "prepared" });
      expect(handoff.itemIds).toEqual(expect.arrayContaining([first.message.id, other.message.id]));
      const events = threadEvents(runtime);
      expect(events.filter((event) => event.type === "context.handoff-prepared"
        && (event.payload as { runId: string }).runId === returned.turn.runId)).toHaveLength(1);
      expect(events.filter((event) => event.type === "provider.backing-invalidated").map(({ payload }) => payload))
        .toEqual([{ backingId: original.id, reason: "context-exhausted" }]);
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("retired");

      runtime.controller.start(returned.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("Original Codex answer");
      expect(runtime.provider.input?.prompt).toContain("Claude intervening answer");
      expect(runtime.provider.input?.prompt).toContain("restored because this provider session does not have them");
      expect(runtime.provider.input?.prompt.split("Return to Codex")).toHaveLength(2);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-fresh" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Fresh Codex answer" });
      runtime.provider.resolve({ sessionId: "codex-fresh" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)?.state).toBe("delivered");
      const replacement = runtime.store.orchestration.backings.find({ ...lookup, nativeSessionId: "codex-fresh" })!;
      expect(replacement).toMatchObject({ status: "ready", coverageComplete: true });
      expect(replacement.coveredItemIds).toEqual(expect.arrayContaining([first.message.id, other.message.id, returned.message.id]));
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("codex-fresh");
    } finally { runtime.store.close(); }
  });

  it("refuses with a typed error while the exhausted session still has background work", async () => {
    const { runtime, lookup, original } = await exhaustedRuntime({ usedTokens: 120_000 });
    try {
      Object.assign(runtime.provider, { pendingBackgroundWork: () => "pending" });
      const before = threadEvents(runtime).length;
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" }))
        .toThrow(ContextHandoffBackgroundWorkError);
      expect(threadEvents(runtime)).toHaveLength(before);
      expect(runtime.store.orchestration.backings.find(lookup)).toEqual(original);
      expect(runtime.store.conversation(runtime.conversationId).status).not.toBe("running");

      Object.assign(runtime.provider, { pendingBackgroundWork: () => "none" });
      const retried = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(retried.turn.providerSessionBefore).toBeNull();
    } finally { runtime.store.close(); }
  });

  it("treats a harness without the background-work probe as having none", async () => {
    const { runtime } = await exhaustedRuntime({ usedTokens: 120_000 });
    try {
      expect("pendingBackgroundWork" in runtime.provider).toBe(false);
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(returned.turn.providerSessionBefore).toBeNull();
    } finally { runtime.store.close(); }
  });

  it("estimates native occupancy from covered history when the session reported no usage", async () => {
    const { runtime, original } = await exhaustedRuntime({ codexAnswer: "x".repeat(100_000) });
    try {
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(returned.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("retired");
      runtime.controller.start(returned.turn.id);
      expect(runtime.provider.input?.prompt).toContain("Claude intervening answer");
      expect(runtime.provider.input?.prompt).not.toContain("x".repeat(1_000));
    } finally { runtime.store.close(); }
  });

  it("keeps resuming the native session while the delta fits", async () => {
    const { runtime, original, other } = await exhaustedRuntime({ usedTokens: 10_000 });
    try {
      Object.assign(runtime.provider, { pendingBackgroundWork: () => { throw new Error("probe must not run"); } });
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(returned.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId))
        .toMatchObject({ targetBackingId: original.id, itemIds: [other.message.id, expect.any(String)] });
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("ready");
    } finally { runtime.store.close(); }
  });
});

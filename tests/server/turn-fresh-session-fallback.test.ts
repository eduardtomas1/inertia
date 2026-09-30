// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { RESTORED_CHAT_HISTORY_LABEL } from "../../src/server/persistence/conversation-context-transport";
import { providerNativeModelSelection, type ModelSelection } from "../../src/shared/model-routing";
import { resolveNativeModelRoute } from "./model-route-fixture";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

const providers = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity"] as const;
const unavailable = {
  reason: "provider-error",
  message: "The saved provider session is no longer available.",
  sessionUnavailable: true,
} as const;

afterEach(cleanupTurnControllerTestDirectories);

async function establishedChat(providerId: (typeof providers)[number]) {
  let installation = "a".repeat(64);
  const runtime = await createTurnControllerTestRuntime({}, {
    modelSelection: providerNativeModelSelection({ providerId, modelId: "provider-default" }),
    resolveModelRoute: (selection: ModelSelection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        continuationIdentity: {
          ...route.continuationIdentity,
          providerCompatibilityToken: installation,
        },
      };
    },
  });
  const first = runtime.controller.queue({
    conversationId: runtime.conversationId,
    content: "Keep the public API unchanged.",
  });
  runtime.controller.start(first.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "saved-session" });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Understood, the API stays as it is." });
  runtime.provider.resolve({ status: "completed", sessionId: "saved-session", text: "Understood, the API stays as it is." });
  await flushTurnControllerTestPromises();
  return { runtime, updateProvider: () => { installation = "b".repeat(64); } };
}

function restoredLabels(runtime: TurnControllerTestRuntime, turnId: string): string[] {
  return (runtime.store.turnExecutionManifest(turnId)?.references ?? [])
    .map(({ label }) => label)
    .filter((label) => label.startsWith(RESTORED_CHAT_HISTORY_LABEL));
}

describe.each(providers)("%s session continuity across the turn controller", (providerId) => {
  it("resumes after an installation change and restarts in-turn when the provider rejects the session", async () => {
    const { runtime, updateProvider } = await establishedChat(providerId);
    try {
      updateProvider();
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Continue.",
      });
      expect(queued.turn).toMatchObject({
        providerSessionBefore: "saved-session",
        continuationReasonCode: "same-continuation",
        sessionRecovery: null,
      });
      runtime.controller.start(queued.turn.id);
      expect(runtime.provider.input?.sessionId).toBe("saved-session");
      expect(runtime.provider.input?.prompt).not.toContain("Keep the public API unchanged.");
      expect(runtime.provider.callbacks?.freshSessionFallback).toBeTypeOf("function");

      const replacement = runtime.provider.callbacks!.freshSessionFallback!();
      expect(replacement?.prompt).toContain("Keep the public API unchanged.");
      expect(replacement?.prompt).toContain("Understood, the API stays as it is.");
      expect(replacement?.prompt.split("Continue.").length).toBe(2);
      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        completedAt: null,
        providerSessionBefore: null,
        usageAtStart: null,
        continuationReasonCode: "stale-provider-session",
        sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 },
      });
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBeNull();
      expect(restoredLabels(runtime, queued.turn.id)).toEqual([`${RESTORED_CHAT_HISTORY_LABEL} · 2 messages`]);
      expect(runtime.events).toContainEqual({
        type: "conversation.detail.invalidated",
        conversationId: runtime.conversationId,
      });
      expect(runtime.provider.callbacks!.freshSessionFallback!()).toBeNull();

      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "session", sessionId: "fresh-session" });
      runtime.provider.emit({ ...identity, type: "text", text: "Continuing with the API unchanged." });
      runtime.provider.resolve({ status: "completed", sessionId: "fresh-session", text: "Continuing with the API unchanged." });
      await flushTurnControllerTestPromises();

      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "completed",
        providerSessionBefore: null,
        providerSessionAfter: "fresh-session",
        continuationReasonCode: "stale-provider-session",
      });
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("fresh-session");

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "And now?" });
      expect(next.turn).toMatchObject({
        providerSessionBefore: "fresh-session",
        continuationReasonCode: "same-continuation",
        sessionRecovery: null,
      });
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("releases a rejected session so the next turn starts fresh with its history", async () => {
    const { runtime } = await establishedChat(providerId);
    try {
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Continue.",
      });
      runtime.controller.start(queued.turn.id);
      runtime.provider.resolve({
        status: "failed",
        sessionId: "saved-session",
        error: unavailable.message,
        failure: unavailable,
      });
      await flushTurnControllerTestPromises();

      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "failed",
        providerSessionBefore: "saved-session",
        providerSessionAfter: null,
      });
      expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
        providerSessionId: null,
        continuationIdentity: null,
      });

      const retry = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again." });
      expect(retry.turn).toMatchObject({
        providerSessionBefore: null,
        continuationReasonCode: "missing-continuation-identity",
        sessionRecovery: { restoredMessageCount: 3, omittedMessageCount: 0 },
      });
      runtime.controller.start(retry.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("Keep the public API unchanged.");
      expect(runtime.provider.callbacks?.freshSessionFallback?.()).toBeNull();
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

describe("fresh session fallback guards", () => {
  it("keeps an ordinary failed resume attached to its session", async () => {
    const { runtime } = await establishedChat("codex");
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." });
      runtime.controller.start(queued.turn.id);
      runtime.provider.resolve({
        status: "failed",
        sessionId: "saved-session",
        error: "Quota reached.",
        failure: { reason: "provider-error", message: "Quota reached." },
      });
      await flushTurnControllerTestPromises();
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("saved-session");
      const retry = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again." });
      expect(retry.turn).toMatchObject({
        providerSessionBefore: "saved-session",
        continuationReasonCode: "same-continuation",
      });
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("refuses to restart once the provider has produced output or the turn has settled", async () => {
    const { runtime } = await establishedChat("claude");
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." });
      runtime.controller.start(queued.turn.id);
      const fallback = runtime.provider.callbacks!.freshSessionFallback!;
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Partial answer" });
      expect(fallback()).toBeNull();
      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        providerSessionBefore: "saved-session",
        continuationReasonCode: "same-continuation",
      });
      runtime.provider.resolve({ status: "completed", sessionId: "saved-session", text: "Partial answer" });
      await flushTurnControllerTestPromises();
      expect(fallback()).toBeNull();
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("saved-session");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("does not offer a fallback to a turn that already starts fresh", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start." });
      expect(queued.turn.continuationReasonCode).toBe("first-turn");
      runtime.controller.start(queued.turn.id);
      expect(runtime.provider.callbacks?.freshSessionFallback?.()).toBeNull();
      expect(runtime.store.agentTurn(queued.turn.id).continuationReasonCode).toBe("first-turn");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

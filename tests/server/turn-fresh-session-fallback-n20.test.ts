import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("N20 imported Claude session fresh-session fallback (2c4622efb)", () => {
  it("falls back in-turn to a fresh session with full portable summary when an imported Claude session is missing", async () => {
    const runtime = await createTurnControllerTestRuntime({}, {
      modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
    });
    try {
      const sessionId = randomUUID();
      const selection = providerNativeModelSelection({ providerId: "claude" });
      const continuationIdentity = runtime.provider.resolveModelRoute(selection).continuationIdentity;
      const conversationId = runtime.store.importCliConversation({
        projectId: runtime.store.conversation(runtime.conversationId).projectId,
        sourceKey: "e".repeat(64),
        providerId: "claude",
        sessionId,
        cwd: runtime.store.conversationPath(runtime.conversationId),
        title: "Imported Claude chat",
        messages: [
          { role: "user", content: "Original imported prompt", createdAt: "2026-09-25T10:00:00.000Z" },
          { role: "assistant", content: "Original imported reply", createdAt: "2026-09-25T10:00:05.000Z" },
        ],
        selection,
        continuationIdentity,
        omittedMessages: 0,
        omittedBytes: 0,
        droppedRecords: 0,
        continuation: "native",
      });

      const queued = runtime.controller.queue({ conversationId, content: "Continue imported work." });
      expect(queued.turn).toMatchObject({ providerSessionBefore: sessionId });
      runtime.controller.start(queued.turn.id);
      expect(runtime.provider.input?.sessionId).toBe(sessionId);

      // Even without sessionStoredElsewhere, missing imported Claude sessions fall back cleanly.
      const replacement = runtime.provider.freshSession({ priorCleanup: "confirmed" });
      expect(replacement).not.toBeNull();
      expect(replacement!.prompt).toContain("Original imported prompt");
      expect(replacement!.prompt).toContain("Original imported reply");
      expect(replacement!.prompt).toContain("Continue imported work.");

      const freshId = randomUUID();
      runtime.provider.emit({
        ...turnControllerTestIdentity(runtime),
        conversationId,
        type: "session",
        sessionId: freshId,
      });
      runtime.provider.resolve({
        status: "completed",
        sessionId: freshId,
        text: "Continued in fresh session",
      });
      await flushTurnControllerTestPromises();

      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "completed",
        providerSessionBefore: null,
        providerSessionAfter: freshId,
      });
      expect(runtime.store.conversation(conversationId).providerSessionId).toBe(freshId);
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("releases a missing imported Claude session when in-turn fallback is unavailable so the next turn starts fresh", async () => {
    const runtime = await createTurnControllerTestRuntime({}, {
      modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
    });
    try {
      const sessionId = randomUUID();
      const selection = providerNativeModelSelection({ providerId: "claude" });
      const continuationIdentity = runtime.provider.resolveModelRoute(selection).continuationIdentity;
      const conversationId = runtime.store.importCliConversation({
        projectId: runtime.store.conversation(runtime.conversationId).projectId,
        sourceKey: "f".repeat(64),
        providerId: "claude",
        sessionId,
        cwd: runtime.store.conversationPath(runtime.conversationId),
        title: "Imported Claude chat",
        messages: [
          { role: "user", content: "Imported requirement", createdAt: "2026-09-25T10:00:00.000Z" },
        ],
        selection,
        continuationIdentity,
        omittedMessages: 0,
        omittedBytes: 0,
        droppedRecords: 0,
        continuation: "native",
      });

      const queued = runtime.controller.queue({ conversationId, content: "Try resuming." });
      runtime.controller.start(queued.turn.id);
      runtime.provider.resolve({
        status: "failed",
        sessionId,
        error: "No conversation found",
        failure: { reason: "provider-error", message: "No conversation found", sessionUnavailable: true },
      });
      await flushTurnControllerTestPromises();

      const errors = (runtime.store.conversationDetail(conversationId)?.activities ?? [])
        .filter(({ kind, turnId }) => kind === "error" && turnId === queued.turn.id);
      expect(errors.map(({ title }) => title)).not.toContain(
        "The original Claude Code session for this imported chat is no longer available.",
      );
      expect(runtime.store.conversation(conversationId).providerSessionId).toBeNull();

      const retry = runtime.controller.queue({ conversationId, content: "Start fresh." });
      expect(retry.turn.providerSessionBefore).toBeNull();
      runtime.controller.start(retry.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("Imported requirement");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

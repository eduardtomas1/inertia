// @inertia-test-suite portable
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { FakeTurnProvider } from "../support/fake-turn-provider";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

const sessionId = "retained-native-session";
const restartWarning =
  "The previous run ended when Inertia closed. Send another message to continue.";
const providers = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity"] as const;
const closeModes = ["completed", "clean-active-close", "unclean-active-close"] as const;

afterEach(cleanupTurnControllerTestDirectories);

describe.each(providers)("%s durable turn restart", (providerId) => {
  it.each(closeModes)("preserves recovery and continuation policy after %s", async (mode) => {
    const runtime = await createTurnControllerTestRuntime({}, {
      modelSelection: providerNativeModelSelection({
        providerId,
        modelId: "provider-default",
      }),
    });
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Retain this visible history.",
    });
    let generation: string | undefined;
    try {
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({
        ...turnControllerTestIdentity(runtime),
        type: "session",
        sessionId,
      });
      runtime.provider.emit({
        ...turnControllerTestIdentity(runtime),
        type: "text",
        text: "Saved response fragment.",
      });
      if (mode === "completed") {
        runtime.provider.resolve({
          status: "completed",
          sessionId,
          text: "Saved complete response.",
        });
        await flushTurnControllerTestPromises();
      }
      if (mode !== "unclean-active-close") await runtime.controller.dispose();
      generation = runtime.store.providerRunOwnership.all()[0]?.runtimeGenerationId;
    } finally {
      runtime.store.close();
    }

    const reopened = new RuntimeStore(
      join(runtime.directory, "inertia.sqlite"),
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    try {
      // Simulate confirmed cleanup of the previous runtime generation. This
      // tests durable recovery; it does not substitute for native process tests.
      if (generation) reopened.providerRunOwnership.clearRuntimeGeneration(generation);
      reopened.recoverInterruptedRuns();
      const recovered = reopened.agentTurn(first.turn.id);
      expect(recovered.status).toBe(mode === "completed" ? "completed" : "interrupted");
      expect(recovered.terminalReason).toBe(
        mode === "completed" ? "provider-completed"
          : mode === "clean-active-close" ? "runtime-shutdown" : "runtime-restart",
      );
      expect(reopened.conversation(runtime.conversationId).providerSessionId).toBe(sessionId);
      const warnings = () => reopened.conversationDetail(runtime.conversationId)!
        .activities.filter((activity) => activity.title === restartWarning);
      expect(warnings()).toHaveLength(mode === "unclean-active-close" ? 1 : 0);
      reopened.recoverInterruptedRuns();
      expect(warnings()).toHaveLength(mode === "unclean-active-close" ? 1 : 0);
      expect(reopened.conversationDetail(runtime.conversationId)!.messages)
        .toContainEqual(expect.objectContaining({ content: "Retain this visible history." }));

      const provider = new FakeTurnProvider();
      const next = new TurnController(reopened, provider, new Map(), new Map(), new Map(), {
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        providerInfo: () => [turnControllerTestProviderInfo()],
      });
      try {
        expect(provider.runCount).toBe(0);
        const queued = next.queue({
          conversationId: runtime.conversationId,
          content: "Continue now.",
        });
        // An unfinished first turn has no settled after-session identity.
        // Recovery retains visible history but cannot authorize native resume.
        const canResume = mode !== "unclean-active-close";
        expect(queued.turn.providerSessionBefore).toBe(canResume ? sessionId : null);
        if (!canResume) {
          expect(queued.turn.continuationReasonCode).toBe("missing-continuation-identity");
          expect(reopened.conversation(runtime.conversationId).providerSessionId).toBeNull();
        }
        next.start(queued.turn.id);
        expect(provider.input?.sessionId).toBe(canResume ? sessionId : undefined);
      } finally {
        await next.dispose();
      }
    } finally {
      reopened.close();
    }
  });
});

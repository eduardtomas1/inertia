import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentHarness,
  AgentHarnessEvent,
  AgentHarnessRun,
  AgentHarnessStartOptions,
} from "../../src/server/provider/agent-harness";
import {
  providerRunTerminal,
  type ProviderRunCallbacks,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import { startHarnessWithFreshSessionFallback } from "../../src/server/provider/fresh-session-fallback";
import { providerNativeModelSelection, type ModelSelection } from "../../src/shared/model-routing";
import { FakeTurnProvider } from "../support/fake-turn-provider";
import { resolveNativeModelRoute } from "./model-route-fixture";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const unavailable = {
  reason: "provider-error",
  message: "The saved provider session is no longer available.",
  sessionUnavailable: true,
} as const;

interface Attempt {
  options: AgentHarnessStartOptions;
  cancelled: boolean[];
  emit(event: Record<string, unknown>): void;
  finish(result: Partial<ProviderRunResult>): void;
}

class WrappedProvider extends FakeTurnProvider {
  attempts: Attempt[] = [];
  wrapped: AgentHarnessRun | null = null;

  override run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult> {
    this.runCount += 1;
    this.input = input;
    this.callbacks = callbacks;
    const attempts = this.attempts;
    const harness = {
      id: input.harnessId,
      providerId: input.providerId,
      capabilities: {} as AgentHarness["capabilities"],
      supports: () => true,
      start: (options: AgentHarnessStartOptions): AgentHarnessRun => {
        let resolve!: (result: ProviderRunResult) => void;
        const cancelled: boolean[] = [];
        attempts.push({
          options,
          cancelled,
          emit: (event) => options.callbacks?.onEvent?.({
            providerId: options.input.providerId,
            conversationId: options.input.conversationId,
            runId: options.input.runId,
            turnId: options.input.turnId,
            ...event,
          } as AgentHarnessEvent),
          finish: (result) => resolve({
            ...providerRunTerminal(options.input, result.status ?? "completed", result.failure),
            text: "",
            textTruncated: false,
            exitCode: 0,
            signal: null,
            cleanupConfirmed: true,
            ...result,
          }),
        });
        return {
          harnessId: input.harnessId,
          providerId: input.providerId,
          result: new Promise((done) => { resolve = done; }),
          cancel: (force) => { cancelled.push(force); },
          extension: undefined as unknown as AgentHarnessRun["extension"],
        };
      },
    } as unknown as AgentHarness;
    this.wrapped = startHarnessWithFreshSessionFallback(harness, {
      input,
      executable: "provider",
      environment: {},
      providerNativeToolsAvailable: true,
      callbacks: { onEvent: (event) => callbacks.onEvent?.(event as never) },
    }, callbacks.freshSessionFallback);
    callbacks.onStarted?.();
    return this.wrapped.result;
  }

  override cancel(): boolean {
    this.cancelCount += 1;
    this.wrapped?.cancel(false);
    return true;
  }
}

async function establishedChat(providerId: "codex" | "claude" = "codex") {
  let installation = "a".repeat(64);
  const runtime = await createTurnControllerTestRuntime({}, {
    modelSelection: providerNativeModelSelection({ providerId, modelId: "provider-default" }),
    resolveModelRoute: (selection: ModelSelection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        continuationIdentity: { ...route.continuationIdentity, providerCompatibilityToken: installation },
      };
    },
  });
  const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Keep the API unchanged." });
  runtime.controller.start(first.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "saved-session" });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Understood." });
  runtime.provider.resolve({ status: "completed", sessionId: "saved-session", text: "Understood." });
  await flushTurnControllerTestPromises();
  return { runtime, updateProvider: () => { installation = "b".repeat(64); } };
}

function swapProvider(runtime: Awaited<ReturnType<typeof establishedChat>>["runtime"]): WrappedProvider {
  const wrapped = new WrappedProvider();
  const target = runtime.provider as unknown as WrappedProvider;
  target.attempts = wrapped.attempts;
  target.wrapped = null;
  target.run = WrappedProvider.prototype.run.bind(target);
  target.cancel = WrappedProvider.prototype.cancel.bind(target);
  return target;
}

describe("fresh-session fallback through the real wrapper and turn controller", () => {
  it("cancellation during the fresh attempt leaves one turn, one request, and a cancelled status", async () => {
    const { runtime } = await establishedChat();
    const provider = swapProvider(runtime);
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." });
      runtime.controller.start(queued.turn.id);
      expect(provider.attempts).toHaveLength(1);
      provider.attempts[0]!.emit({ type: "status", status: "running" });
      provider.attempts[0]!.emit({ type: "status", status: "failed", message: unavailable.message });
      provider.attempts[0]!.finish({ status: "failed", error: unavailable.message, failure: unavailable });
      await flushTurnControllerTestPromises();
      expect(provider.attempts).toHaveLength(2);
      expect(runtime.store.agentTurn(queued.turn.id).status).not.toBe("failed");
      provider.attempts[1]!.emit({ type: "status", status: "running" });
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      expect(provider.attempts[0]!.cancelled).toEqual([]);
      expect(provider.attempts[1]!.cancelled).toEqual([false]);
      provider.attempts[1]!.finish({ status: "cancelled" });
      await flushTurnControllerTestPromises();
      expect(provider.attempts).toHaveLength(2);
      const turns = runtime.store.agentTurnsForConversation(runtime.conversationId);
      expect(turns).toHaveLength(2);
      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "cancelled",
        runId: queued.turn.runId,
        userMessageId: queued.turn.userMessageId,
        continuationReasonCode: "stale-provider-session",
      });
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("a cancel that lands before the rejection keeps one attempt and does not release the session", async () => {
    const { runtime } = await establishedChat();
    const provider = swapProvider(runtime);
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." });
      runtime.controller.start(queued.turn.id);
      runtime.controller.cancel(runtime.conversationId);
      provider.attempts[0]!.finish({ status: "failed", error: unavailable.message, failure: unavailable });
      await flushTurnControllerTestPromises();
      expect(provider.attempts).toHaveLength(1);
      expect(runtime.store.agentTurn(queued.turn.id).status).toBe("cancelled");
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("saved-session");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it.each([
    ["a command", { kind: "command", phase: "completed", label: "rm -rf build", activityId: "cmd-1" }],
    ["a tool call", { kind: "tool", phase: "started", label: "Read file", activityId: "tool-1" }],
    ["a status notice", { kind: "system", phase: "info", label: "Compacting context" }],
  ])("%s before the rejection stops the restart and keeps one attempt", async (_label, activity) => {
    const { runtime } = await establishedChat();
    const provider = swapProvider(runtime);
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." });
      runtime.controller.start(queued.turn.id);
      provider.attempts[0]!.emit({ type: "activity", ...activity });
      provider.attempts[0]!.finish({ status: "failed", error: unavailable.message, failure: unavailable });
      await flushTurnControllerTestPromises();
      expect(provider.attempts).toHaveLength(1);
      expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
        status: "failed",
        providerSessionBefore: "saved-session",
      });
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBeNull();
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

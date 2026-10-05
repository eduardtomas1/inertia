import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentHarness,
  AgentHarnessEvent,
  AgentHarnessRun,
  AgentHarnessStartOptions,
} from "../../src/server/provider/agent-harness";
import {
  ProviderSteerDeliveryUnknownError,
  providerRunTerminal,
  type ProviderRunCallbacks,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import { startHarnessWithFreshSessionFallback } from "../../src/server/provider/fresh-session-fallback";
import { staleProviderSessionDecision } from "../../src/shared/continuation-policy";
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

describe("explaining a declined restart", () => {
  it.each([
    ["claude", "No conversation found with session ID: saved-session"],
    ["codex", "Codex rejected a protocol request."],
  ] as const)("reports the same explanation for %s when the restart is declined", async (providerId, providerMessage) => {
    const { runtime } = await establishedChat(providerId);
    const provider = swapProvider(runtime);
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." });
      runtime.controller.start(queued.turn.id);
      provider.attempts[0]!.emit({ type: "activity", kind: "tool", phase: "started", label: "Read file", activityId: "tool-1" });
      provider.attempts[0]!.finish({
        status: "failed",
        error: providerMessage,
        failure: { reason: "provider-error", message: providerMessage, sessionUnavailable: true },
      });
      await flushTurnControllerTestPromises();
      expect(provider.attempts).toHaveLength(1);
      const activities = runtime.store.conversationDetail(runtime.conversationId)?.activities ?? [];
      expect(activities.filter(({ kind, turnId }) => kind === "error" && turnId === queued.turn.id))
        .toEqual([expect.objectContaining({ title: staleProviderSessionDecision().reason })]);
      const errorDetail = activities.find(({ kind, turnId }) => kind === "error" && turnId === queued.turn.id)?.detail ?? "";
      expect(errorDetail).toContain(providerMessage);
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

describe("follow-ups and the in-turn restart", () => {
  async function runningResume(providerId: "codex" | "claude" = "claude") {
    const { runtime } = await establishedChat(providerId);
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." });
    runtime.controller.start(queued.turn.id);
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
    return runtime;
  }

  async function sendFollowUp(runtime: Awaited<ReturnType<typeof runningResume>>) {
    const admission = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
    try {
      return await runtime.controller.steer(admission, { content: "Also cover CSV.", imagePaths: [] });
    } finally {
      admission.release();
    }
  }

  it("keeps the restart available when the provider refused the follow-up", async () => {
    const runtime = await runningResume();
    try {
      runtime.provider.steerSupported = false;
      expect(await sendFollowUp(runtime)).toEqual({ kind: "refused" });
      expect(runtime.provider.callbacks!.freshSessionFallback!()).not.toBeNull();
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("switches the restart off once the provider accepted the follow-up", async () => {
    const runtime = await runningResume();
    try {
      expect(await sendFollowUp(runtime)).toMatchObject({ kind: "accepted" });
      expect(runtime.provider.callbacks!.freshSessionFallback!()).toBeNull();
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("keeps the restart off when the provider may have received the follow-up", async () => {
    const runtime = await runningResume();
    try {
      runtime.provider.steer = async () => {
        throw new ProviderSteerDeliveryUnknownError();
      };
      await expect(sendFollowUp(runtime)).rejects.toThrow("did not confirm whether it received this follow-up");
      expect(runtime.provider.callbacks!.freshSessionFallback!()).toBeNull();
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("holds the restart while the provider is still deciding and restores it after a refusal", async () => {
    const runtime = await runningResume();
    try {
      let answer!: (accepted: boolean) => void;
      runtime.provider.steer = async (_conversationId, input) => {
        runtime.provider.steerCalls.push(input.content);
        return await new Promise<boolean>((resolve) => { answer = resolve; });
      };
      const pending = sendFollowUp(runtime);
      await vi.waitFor(() => expect(runtime.provider.steerCalls).toHaveLength(1));
      expect(runtime.provider.callbacks!.freshSessionFallback!()).toBeNull();
      answer(false);
      expect(await pending).toEqual({ kind: "refused" });
      expect(runtime.provider.callbacks!.freshSessionFallback!()).not.toBeNull();
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

describe("retiring a saved session after repeated rejected resumes", () => {
  type Runtime = Awaited<ReturnType<typeof establishedChat>>["runtime"];

  async function failTurn(
    runtime: Runtime,
    content: string,
    failure: NonNullable<ProviderRunResult["failure"]>,
    options: { sessionId?: string } = {},
  ) {
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
    runtime.controller.start(queued.turn.id);
    if (options.sessionId) {
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: options.sessionId });
    }
    runtime.provider.resolve({
      status: "failed",
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      error: failure.message,
      failure,
    });
    await flushTurnControllerTestPromises();
    return runtime.store.agentTurn(queued.turn.id);
  }

  async function completeTurn(runtime: Runtime, content: string, sessionId: string) {
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
    runtime.controller.start(queued.turn.id);
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Done." });
    runtime.provider.resolve({ status: "completed", sessionId, text: "Done." });
    await flushTurnControllerTestPromises();
    return runtime.store.agentTurn(queued.turn.id);
  }

  const rejected = {
    reason: "provider-error",
    message: "The provider refused to load the saved session.",
    resumeRejected: true,
  } as const;
  const outage = { reason: "provider-error", message: "Network unreachable." } as const;

  it("starts fresh after two rejected resumes of the same session", async () => {
    const { runtime } = await establishedChat();
    try {
      expect(await failTurn(runtime, "1", rejected)).toMatchObject({
        providerSessionBefore: "saved-session",
        sessionRecovery: null,
      });
      expect((await failTurn(runtime, "2", rejected)).providerSessionBefore).toBe("saved-session");
      const third = runtime.controller.queue({ conversationId: runtime.conversationId, content: "3" });
      expect(third.turn).toMatchObject({ providerSessionBefore: null, continuationReasonCode: "stale-provider-session" });
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBeNull();
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("does not count a rejected resume followed by an ordinary failure", async () => {
    const { runtime } = await establishedChat();
    try {
      await failTurn(runtime, "1", rejected);
      await failTurn(runtime, "2", outage);
      const third = runtime.controller.queue({ conversationId: runtime.conversationId, content: "3" });
      expect(third.turn.providerSessionBefore).toBe("saved-session");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("keeps resuming the saved session while an outage lasts", async () => {
    const { runtime } = await establishedChat();
    try {
      for (const content of ["1", "2", "3", "4"]) {
        expect((await failTurn(runtime, content, outage)).providerSessionBefore).toBe("saved-session");
      }
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("saved-session");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("does not retire a session it started until that session completes a turn", async () => {
    const { runtime } = await establishedChat();
    try {
      await failTurn(runtime, "1", rejected);
      await failTurn(runtime, "2", rejected);
      const fresh = await failTurn(runtime, "3", outage, { sessionId: "second-session" });
      expect(fresh).toMatchObject({ providerSessionBefore: null, continuationReasonCode: "stale-provider-session" });
      expect((await failTurn(runtime, "4", rejected)).providerSessionBefore).toBe("second-session");
      expect((await failTurn(runtime, "5", rejected)).providerSessionBefore).toBe("second-session");
      const sixth = runtime.controller.queue({ conversationId: runtime.conversationId, content: "6" });
      expect(sixth.turn.providerSessionBefore).toBe("second-session");
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });

  it("retires a session it started once that session has completed a turn", async () => {
    const { runtime } = await establishedChat();
    try {
      await failTurn(runtime, "1", rejected);
      await failTurn(runtime, "2", rejected);
      const fresh = await completeTurn(runtime, "3", "second-session");
      expect(fresh).toMatchObject({ status: "completed", providerSessionBefore: null });
      await failTurn(runtime, "4", rejected);
      await failTurn(runtime, "5", rejected);
      const sixth = runtime.controller.queue({ conversationId: runtime.conversationId, content: "6" });
      expect(sixth.turn).toMatchObject({ providerSessionBefore: null, continuationReasonCode: "stale-provider-session" });
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

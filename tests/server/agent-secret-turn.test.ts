import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderHostToolCall, ProviderRunCallbacks, ProviderRunInput, ProviderRunResult } from "../../src/server/provider/contracts";
import { providerRunTerminal } from "../../src/server/provider/contracts";
import { AgentSecretService } from "../../src/server/runtime/agent-secrets/agent-secret-service";
import { createConversationTitleService } from "../../src/server/runtime/conversation-title-service";
import { createRestartContinuationRuntime } from "../../src/server/runtime/restart-continuation-runtime";
import { IsolatedRunController, type IsolatedRunProviderRuntime } from "../../src/server/runtime/reviews/isolated-run-controller";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { STREAM_PROJECTION_FLUSH_INTERVAL_MS } from "../../src/server/runtime/turns/turn-stream-channel";
import type { TurnSecretOutputFilter } from "../../src/server/runtime/turns/turn-secret-output";
import type { FakeTurnScheduler } from "../support/fake-turn-provider";
import { SECRET_REQUEST_TOOL_NAME } from "../../src/node/agent-secrets";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { resolveNativeModelRoute } from "./model-route-fixture";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

const SECRET = "fake-token-kQ9xZ2mB7vN4pL1sR8tW";

afterEach(cleanupTurnControllerTestDirectories);

function flushStreams(scheduler: FakeTurnScheduler): void {
  for (const [id, callback] of scheduler.callbacks) {
    if ((scheduler.delays.get(id) ?? 0) > STREAM_PROJECTION_FLUSH_INTERVAL_MS) continue;
    scheduler.callbacks.delete(id);
    scheduler.delays.delete(id);
    callback();
  }
}

function databaseBytes(directory: string): string {
  return ["inertia.sqlite", "inertia.sqlite-wal"].map((name) => {
    try {
      return readFileSync(join(directory, name)).toString("latin1");
    } catch {
      return "";
    }
  }).join("");
}

function call(signal = new AbortController().signal): ProviderHostToolCall {
  return {
    providerThreadId: "thread",
    providerTurnId: "turn",
    toolCallId: randomUUID(),
    tool: SECRET_REQUEST_TOOL_NAME,
    arguments: { title: "Tailscale auth key", description: "Create a reusable key in the admin console." },
    signal,
    requestApproval: async () => "approve",
  };
}

async function startedTurn() {
  const holder: { filter?: TurnSecretOutputFilter } = {};
  const runtime = await createTurnControllerTestRuntime({ secretOutput: () => holder.filter }, { id: randomUUID });
  const service = new AgentSecretService({
    store: runtime.store,
    dataDirectory: runtime.directory,
    turns: runtime.controller.secretRequests,
    broadcast: (event) => runtime.events.push(event),
    waitMs: () => 60_000,
  });
  service.start();
  holder.filter = service.output;
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Set up the VMs." });
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  const conversation = runtime.store.conversation(runtime.conversationId);
  const turn = runtime.store.agentTurn(queued.turn.id);
  return { runtime, service, conversation, turn };
}

describe("agent secret requests inside a live turn", () => {
  it("waits for input while the card is pending and returns to running when the value arrives", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Next I need the key." });
      const result = service.invoke({ conversation, turn }, call());
      const [pending] = runtime.store.transcriptRepository.secretRequests.pendingAll();
      expect(runtime.store.agentTurn(turn.id).status).toBe("waiting-for-input");
      expect(runtime.store.conversation(conversation.id)).toMatchObject({ status: "needs-input", attentionKind: "input" });
      await service.deliver({ conversationId: conversation.id, requestId: pending!.id, secret: SECRET, vaulted: false });
      expect(JSON.parse((await result).text)).toMatchObject({ status: "saved" });
      expect(runtime.store.agentTurn(turn.id).status).toBe("running");
      expect(runtime.store.conversation(conversation.id).status).toBe("running");
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("ends the pending request when the turn is stopped", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const controller = new AbortController();
      const result = service.invoke({ conversation, turn }, call(controller.signal));
      const [pending] = runtime.store.transcriptRepository.secretRequests.pendingAll();
      expect(runtime.controller.cancel(conversation.id)).toBe(true);
      controller.abort();
      expect(JSON.parse((await result).text)).toMatchObject({ status: "ended", reason: "cancelled" });
      expect(runtime.store.transcriptRepository.secretRequests.find(pending!.id)?.status).toBe("ended");
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("never persists or broadcasts a saved value from streamed text, tool output, activity labels or the final result", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const result = service.invoke({ conversation, turn }, call());
      const [pending] = runtime.store.transcriptRepository.secretRequests.pendingAll();
      await service.deliver({ conversationId: conversation.id, requestId: pending!.id, secret: SECRET, vaulted: false });
      await result;
      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: "The key is fake-token-kQ9x", itemId: "a" });
      runtime.provider.emit({ ...identity, type: "text", text: "Z2mB7vN4pL1sR8tW, logging in.", itemId: "a" });
      runtime.provider.emit({
        ...identity, type: "activity", kind: "command", phase: "started", activityId: "cmd-1",
        label: `tailscale up --authkey ${SECRET}`, detail: `tailscale up --authkey ${SECRET}`,
      });
      runtime.provider.emit({
        ...identity, type: "activity", kind: "command", phase: "completed", activityId: "cmd-1",
        label: `tailscale up --authkey ${SECRET}`, outputDelta: `${SECRET}\nok\n`,
      });
      runtime.scheduler.runAll();
      runtime.provider.resolve({ status: "completed", text: `The key is ${SECRET}, logging in.` });
      await flushTurnControllerTestPromises();
      runtime.scheduler.runAll();
      await flushTurnControllerTestPromises();
      const detail = runtime.store.conversationDetail(conversation.id);
      const serializedDetail = JSON.stringify(detail);
      expect(serializedDetail).not.toContain(SECRET);
      expect(serializedDetail).toContain("[redacted]");
      expect(JSON.stringify(runtime.events)).not.toContain(SECRET);
      const assistant = detail?.messages.filter(({ role }) => role === "assistant").map(({ content }) => content).join("\n");
      expect(assistant).toContain("The key is [redacted], logging in.");
      service.shutdown();
      runtime.store.close();
      const bytes = ["inertia.sqlite", "inertia.sqlite-wal"].map((name) => {
        try {
          return readFileSync(join(runtime.directory, name)).toString("latin1");
        } catch {
          return "";
        }
      }).join("");
      expect(bytes).not.toContain(SECRET);
    } finally {
      service.shutdown();
      try {
        runtime.store.close();
      } catch {
      }
    }
  });

  it("never stores or broadcasts a value split across one command's output deltas, before or after completion", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const result = service.invoke({ conversation, turn }, call());
      await service.deliver({ conversationId: conversation.id, requestId: runtime.store.transcriptRepository.secretRequests.pendingAll()[0]!.id, secret: SECRET, vaulted: false });
      await result;
      const identity = turnControllerTestIdentity(runtime);
      const assertClean = (): void => {
        flushStreams(runtime.scheduler);
        expect(JSON.stringify(runtime.store.conversationDetail(conversation.id))).not.toContain(SECRET);
        expect(JSON.stringify(runtime.events)).not.toContain(SECRET);
      };
      runtime.provider.emit({ ...identity, type: "activity", kind: "command", phase: "started", activityId: "cat", label: "cat key", detail: "cat key" });
      for (const delta of [SECRET.slice(0, 8), SECRET.slice(8, 16), SECRET.slice(16), "\nok\n"]) {
        runtime.provider.emit({ ...identity, type: "activity", kind: "command", phase: "started", activityId: "cat", label: "cat key", outputDelta: delta });
        assertClean();
      }
      runtime.provider.emit({ ...identity, type: "activity", kind: "command", phase: "completed", activityId: "cat", label: "cat key" });
      assertClean();
      runtime.provider.emit({ ...identity, type: "activity", kind: "command", phase: "started", activityId: "tail", label: "tail log", detail: "tail log" });
      runtime.provider.emit({ ...identity, type: "activity", kind: "command", phase: "started", activityId: "tail", label: "tail log", outputDelta: "last: fake-token-kQ9xZ" });
      runtime.provider.emit({ ...identity, type: "reasoning-summary", text: "The key fake-token-kQ9" });
      runtime.provider.emit({ ...identity, type: "reasoning-summary", text: "xZ2mB7vN4pL1sR8tW works." });
      assertClean();
      runtime.provider.resolve({ status: "completed", text: "" });
      await flushTurnControllerTestPromises();
      assertClean();
      await flushTurnControllerTestPromises();
      const detail = runtime.store.conversationDetail(conversation.id)!;
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain(SECRET);
      expect(detail.activities.find(({ title }) => title === "cat key")?.detail).toBe("cat key\n\nOutput:\n[redacted]\nok\n");
      expect(detail.activities.find(({ title }) => title === "tail log")?.detail).toBe("tail log\n\nOutput:\nlast: [redacted]");
      expect(serialized).toContain("The key [redacted] works.");
      expect(serialized).not.toContain("kQ9xZ2mB7vN4pL1sR8tW");
      service.shutdown();
      runtime.store.close();
      expect(databaseBytes(runtime.directory)).not.toContain(SECRET);
    } finally {
      service.shutdown();
      try {
        runtime.store.close();
      } catch {
      }
    }
  });

  it("drops held output when the turn is torn down without a provider result", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const result = service.invoke({ conversation, turn }, call());
      await service.deliver({ conversationId: conversation.id, requestId: runtime.store.transcriptRepository.secretRequests.pendingAll()[0]!.id, secret: SECRET, vaulted: false });
      await result;
      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: "Pasting fake-token-kQ9xZ2mB" });
      flushStreams(runtime.scheduler);
      expect(runtime.controller.cancel(conversation.id)).toBe(true);
      await flushTurnControllerTestPromises();
      runtime.scheduler.runAll();
      expect(service.output.result({ ...identity, status: "completed", text: "" } as never).events).toEqual([]);
      runtime.provider.emit({ ...identity, type: "text", text: "7vN4pL1sR8tW" });
      runtime.scheduler.runAll();
      expect(JSON.stringify(runtime.store.conversationDetail(conversation.id))).not.toContain("fake-token-kQ9xZ2mB7vN4");
      expect(JSON.stringify(runtime.events)).not.toContain(SECRET);
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("places the card after the assistant text that came before it, including a held tail", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const identity = turnControllerTestIdentity(runtime);
      const first = service.invoke({ conversation, turn }, call());
      await service.deliver({ conversationId: conversation.id, requestId: runtime.store.transcriptRepository.secretRequests.pendingAll()[0]!.id, secret: SECRET, vaulted: false });
      await first;
      runtime.provider.emit({ ...identity, type: "text", text: "That key worked. The old one was fake-token-kQ9x" });
      const second = service.invoke({ conversation, turn }, call());
      const card = runtime.store.transcriptRepository.secretRequests.pendingAll()[0]!;
      const messages = runtime.store.conversationDetail(conversation.id)!.messages
        .filter(({ role, secretRequest }) => role === "assistant" || secretRequest?.requestId === card.id);
      expect(messages.map(({ role }) => role)).toEqual(["assistant", "system"]);
      expect(messages[0]!.content).toBe("That key worked. The old one was [redacted]");
      expect(Date.parse(messages[1]!.createdAt)).toBeGreaterThan(Date.parse(messages[0]!.createdAt));
      await service.decline(conversation.id, card.id);
      await second;
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("ends the pending secret request immediately on turn cancel even when the provider does not abort call.signal", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const neverAborted = new AbortController();
      const result = service.invoke({ conversation, turn }, call(neverAborted.signal));
      const [pending] = runtime.store.transcriptRepository.secretRequests.pendingAll();
      expect(service.hasPending(conversation.id)).toBe(true);
      expect(runtime.controller.secretRequests.hasPending(conversation.id)).toBe(true);

      // Cancel turn WITHOUT aborting call.signal.
      expect(runtime.controller.cancel(conversation.id)).toBe(true);
      expect(JSON.parse((await result).text)).toMatchObject({ status: "ended", reason: "cancelled" });
      expect(runtime.store.transcriptRepository.secretRequests.find(pending!.id)?.status).toBe("ended");
      expect(service.hasPending(conversation.id)).toBe(false);
      expect(runtime.controller.secretRequests.hasPending(conversation.id)).toBe(false);
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("orders user message < secret card < post-secret assistant text even on the same clock tick", async () => {
    const holder: { filter?: TurnSecretOutputFilter } = {};
    const frozenMs = Date.parse("2026-10-29T12:00:00.000Z");
    const runtime = await createTurnControllerTestRuntime(
      { secretOutput: () => holder.filter },
      { id: randomUUID, clock: () => new Date(frozenMs) },
    );
    const service = new AgentSecretService({
      store: runtime.store,
      dataDirectory: runtime.directory,
      turns: runtime.controller.secretRequests,
      broadcast: (event) => runtime.events.push(event),
      clock: () => frozenMs,
      waitMs: () => 60_000,
    });
    service.start();
    holder.filter = service.output;
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Log into the cluster." });
      expect(runtime.controller.start(queued.turn.id)).toBe(true);
      const conversation = runtime.store.conversation(runtime.conversationId);
      const turn = runtime.store.agentTurn(queued.turn.id);
      // Open secret card immediately without prior assistant text.
      const pendingCall = service.invoke({ conversation, turn }, call());
      const [card] = runtime.store.transcriptRepository.secretRequests.pendingAll();
      await service.deliver({ conversationId: conversation.id, requestId: card!.id, secret: SECRET, vaulted: false });
      await pendingCall;

      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: "Logged in successfully." });
      runtime.provider.resolve({ status: "completed", text: "Logged in successfully." });
      await flushTurnControllerTestPromises();
      runtime.scheduler.runAll();
      await flushTurnControllerTestPromises();

      const messages = runtime.store.conversationDetail(conversation.id)!.messages;
      expect(messages.map(({ role }) => role)).toEqual(["user", "system", "assistant"]);
      expect(Date.parse(messages[1]!.createdAt)).toBeGreaterThan(Date.parse(messages[0]!.createdAt));
      expect(Date.parse(messages[2]!.createdAt)).toBeGreaterThan(Date.parse(messages[1]!.createdAt));
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("redacts active secrets from provider promise rejections, persistence errors, and native goal events", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const pending = service.invoke({ conversation, turn }, call());
      const [card] = runtime.store.transcriptRepository.secretRequests.pendingAll();
      await service.deliver({ conversationId: conversation.id, requestId: card!.id, secret: SECRET, vaulted: false });
      await pending;

      // Provider promise rejection carrying the secret in its error message.
      runtime.provider.reject(new Error(`Transport crashed while running --token=${SECRET}`));
      await flushTurnControllerTestPromises();
      runtime.scheduler.runAll();
      await flushTurnControllerTestPromises();

      const detail = runtime.store.conversationDetail(conversation.id)!;
      expect(JSON.stringify(detail)).not.toContain(SECRET);
      expect(JSON.stringify(runtime.events)).not.toContain(SECRET);
      const errorActivity = detail.activities.find(({ kind }) => kind === "error");
      expect(errorActivity?.detail).toContain("[redacted]");
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("redacts active secrets in turn-start publicTurnError messages", async () => {
    const holder: { filter?: TurnSecretOutputFilter } = {};
    const runtime = await createTurnControllerTestRuntime({ secretOutput: () => holder.filter }, { id: randomUUID });
    const service = new AgentSecretService({
      store: runtime.store,
      dataDirectory: runtime.directory,
      turns: runtime.controller.secretRequests,
      broadcast: (event) => runtime.events.push(event),
      waitMs: () => 60_000,
    });
    service.start();
    holder.filter = service.output;
    service.output.setValues([SECRET]);
    try {
      vi.spyOn(runtime.provider, "run").mockImplementation(() => {
        throw new Error(`Failed spawning with auth=${SECRET}`);
      });
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Deploy." });
      expect(runtime.controller.start(queued.turn.id)).toBe(false);
      await flushTurnControllerTestPromises();
      const detail = runtime.store.conversationDetail(runtime.conversationId)!;
      expect(JSON.stringify(detail)).not.toContain(SECRET);
      expect(JSON.stringify(runtime.events)).not.toContain(SECRET);
      expect(detail.activities.find(({ kind }) => kind === "error")?.title).toContain("[redacted]");
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("redacts active secrets in generated conversation titles and isolated review runs", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      service.output.setValues([SECRET]);

      // 1. ConversationTitleService redaction
      let updatedTitle = "";
      const codexSource = vi.fn(async () => `Fix auth with ${SECRET}`);
      const abort = new AbortController();
      const titleService = createConversationTitleService({
        conversation: () => ({ title: "New chat", archivedAt: null, providerSessionId: null }),
        firstUserMessage: () => ({ id: turn.userMessageId, content: `Use key ${SECRET}` }),
        keepsOwnTitle: () => false,
        updateTitle: (_id, title) => { updatedTitle = title; },
        sources: { claude: async () => undefined, codex: codexSource },
        isExternalTurn: () => false,
        redactTitle: (value) => service.output.text(value),
        track: (operation) => operation(),
        signal: abort.signal,
      });
      titleService.onTurnSettled({ ...turn, status: "completed", providerId: "codex" }, { providerSessionTitle: null });
      await flushTurnControllerTestPromises();
      expect(codexSource).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Use key [redacted]" }));
      expect(updatedTitle).toBe("Fix auth with [redacted]");
      expect(updatedTitle).not.toContain(SECRET);

      // 2. IsolatedRunController redaction (split chunks + final result)
      let capturedCallbacks: ProviderRunCallbacks | null = null;
      let capturedInput: ProviderRunInput | null = null;
      const fakeProvider: IsolatedRunProviderRuntime = {
        resolveModelRoute: resolveNativeModelRoute,
        harnessIdFor: (input) => input.harnessId,
        run: (input, callbacks) => {
          capturedInput = input;
          capturedCallbacks = callbacks;
          callbacks.onText?.({
            type: "text",
            providerId: input.providerId,
            conversationId: input.conversationId,
            runId: input.runId,
            turnId: input.turnId,
            text: `Summary prefix ${SECRET.slice(0, 12)}`,
          });
          callbacks.onText?.({
            type: "text",
            providerId: input.providerId,
            conversationId: input.conversationId,
            runId: input.runId,
            turnId: input.turnId,
            text: `${SECRET.slice(12)} suffix`,
          });
          const terminal: ProviderRunResult = {
            ...providerRunTerminal(input, "completed"),
            text: "",
            textTruncated: false,
            exitCode: 0,
            signal: null,
            cleanupConfirmed: true,
          };
          return Promise.resolve(terminal);
        },
        isRunning: () => false,
        ownsRun: () => false,
        stopOwned: async () => "settled",
      };
      const isolated = new IsolatedRunController(
        runtime.store,
        fakeProvider,
        runtime.directory,
        () => undefined,
        { secretOutput: () => service.output },
      );
      const completed = await isolated.run({
        kind: "diff-summary",
        projectId: conversation.projectId,
        conversationId: conversation.id,
        owner: {},
        selection: {
          modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
        },
        request: { visibleContent: null, executionPrompt: "Summarize diff" },
        label: "Diff summary",
        detail: "Summarizing",
        toolPolicy: "none",
        interactionPolicy: "fail-closed",
        onResult: (output) => output.text,
      });
      expect(capturedInput).not.toBeNull();
      expect(capturedCallbacks).not.toBeNull();
      expect(completed.text).toBe("Summary prefix [redacted] suffix");
      expect(completed.value).not.toContain(SECRET);
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("defers restart continuation while a secret request is pending", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    const abort = new AbortController();
    try {
      const pending = service.invoke({ conversation, turn }, call());
      expect(runtime.controller.secretRequests.hasPending(conversation.id)).toBe(true);
      const continuation = createRestartContinuationRuntime({
        store: runtime.store,
        turns: runtime.controller,
        pendingApprovals: new Map(),
        pendingInputs: new Map(),
        enableProviders: true,
        providerTerminalResumes: { isActive: () => false },
      } as unknown as TurnInteractionCommandDependencies, {
        signal: abort.signal,
        track: (operation) => operation(),
      });
      // Because pendingInteraction checks secretRequests.hasPending, scheduler skips dispatch.
      expect(continuation.scheduler).toBeDefined();
      await service.decline(conversation.id, runtime.store.transcriptRepository.secretRequests.pendingAll()[0]!.id);
      await pending;
      expect(runtime.controller.secretRequests.hasPending(conversation.id)).toBe(false);
    } finally {
      abort.abort();
      service.shutdown();
      runtime.store.close();
    }
  });
});

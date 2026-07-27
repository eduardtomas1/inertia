import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import type {
  ProviderEvent,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  TurnController,
  type TurnProviderRuntime,
  type TurnTimerScheduler,
} from "../../src/server/runtime/turns/turn-controller";
import {
  TurnStreamCoalescer,
  type StreamDeltaFlush,
} from "../../src/server/runtime/turns/turn-stream-coalescer";
import { resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];

class ManualScheduler implements TurnTimerScheduler {
  private sequence = 0;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.sequence;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  runThrough(maximumDelayMs: number): void {
    for (const [id, timer] of [...this.timers]) {
      if (timer.delayMs > maximumDelayMs) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }

  shortTimerCount(): number {
    return [...this.timers.values()].filter(({ delayMs }) => delayMs < 1_000).length;
  }
}

class ControlledProvider implements TurnProviderRuntime {
  input: ProviderRunInput | null = null;
  callbacks: ProviderRunCallbacks | null = null;
  cancelCount = 0;
  private resolveRun: ((result: ProviderRunResult) => void) | null = null;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult> {
    this.input = input;
    this.callbacks = callbacks;
    return new Promise((resolve) => {
      this.resolveRun = resolve;
    });
  }

  emit(event: ProviderEvent): void {
    this.callbacks?.onEvent?.(event);
  }

  resolve(result: Partial<ProviderRunResult> = {}): void {
    if (!this.input || !this.resolveRun) throw new Error("Provider is not running.");
    this.resolveRun({
      providerId: this.input.providerId,
      conversationId: this.input.conversationId ?? this.input.threadId,
      status: "completed",
      text: "",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      ...result,
    });
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  isRunning(): boolean {
    return this.input !== null;
  }

  respondToApproval(
    _conversationId: string,
    _requestId: string,
    _decision: AgentApprovalDecision,
  ): boolean {
    return true;
  }

  respondToInput(): boolean {
    return true;
  }

  async disposeAll(): Promise<void> {}
}

interface ControllerRuntime {
  store: RuntimeStore;
  provider: ControlledProvider;
  scheduler: ManualScheduler;
  controller: TurnController;
  conversationId: string;
  events: ServerEvent[];
}

function providerInfo(): ProviderInfo {
  const metadata = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex",
    label: "Codex",
    command: "fake-codex",
    available: true,
    version: "test",
    executable: "fake-codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      description: "Test model",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [],
      defaultReasoningEffort: "",
    }],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

async function controllerRuntime(): Promise<ControllerRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-stream-coalescer-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(
    join(directory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Streaming", workspace);
  const conversation = store.createConversation(project.id, "Coalesced turn", {
    providerId: "codex",
    model: "gpt-test",
  });
  const provider = new ControlledProvider();
  const scheduler = new ManualScheduler();
  const events: ServerEvent[] = [];
  const controller = new TurnController(
    store,
    provider,
    new Map<string, AgentApprovalRequest>(),
    new Map<string, AgentInputRequest>(),
    new Map<string, AgentPlan>(),
    {
      broadcast: (event) => events.push(event),
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo()],
    },
    {
      scheduler,
      id: (() => {
        let id = 0;
        return () => `stream-controller-${++id}`;
      })(),
      clock: (() => {
        let now = Date.parse("2030-01-01T00:00:00.000Z");
        return () => new Date(now++);
      })(),
      turnTimeoutMs: 10_000,
    },
  );
  return {
    store,
    provider,
    scheduler,
    controller,
    conversationId: conversation.id,
    events,
  };
}

function providerIdentity(runtime: ControllerRuntime) {
  const input = runtime.provider.input;
  if (!input?.runId || !input.turnId) throw new Error("Turn is not running.");
  return {
    providerId: input.providerId,
    conversationId: runtime.conversationId,
    runId: input.runId,
    turnId: input.turnId,
  } as const;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("TurnStreamCoalescer", () => {
  it("defers the first meaningful flush and preserves leading whitespace", () => {
    const scheduler = new ManualScheduler();
    const flushes: StreamDeltaFlush[] = [];
    const coalescer = new TurnStreamCoalescer({
      scheduler,
      onFlush: (flush) => flushes.push(flush),
      onTimerError: (error) => {
        throw error;
      },
    });

    coalescer.append(" \n");
    expect(scheduler.timers).toHaveLength(0);
    coalescer.append("A");
    expect(flushes).toEqual([]);
    expect(scheduler.timers).toHaveLength(1);

    scheduler.runThrough(24);
    expect(flushes).toEqual([{ delta: " \nA", replacement: false }]);
    expect(coalescer.hasPending).toBe(false);
    expect(coalescer.hasScheduledFlush).toBe(false);
  });

  it("uses the character safety valve and substantially reduces flushes", () => {
    const scheduler = new ManualScheduler();
    const chunks: string[] = [];
    const coalescer = new TurnStreamCoalescer({
      scheduler,
      maxBufferedChars: 100,
      onFlush: ({ delta }) => chunks.push(delta),
      onTimerError: (error) => {
        throw error;
      },
    });

    for (let index = 0; index < 275; index += 1) coalescer.append("x");
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100]);
    expect(scheduler.timers).toHaveLength(1);
    scheduler.runThrough(96);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 75]);
    expect(chunks.join("")).toBe("x".repeat(275));
    expect(chunks).toHaveLength(3);
  });

  it("contains timer failures, retains pending text, and cancels resources on dispose", () => {
    const scheduler = new ManualScheduler();
    const errors: unknown[] = [];
    const coalescer = new TurnStreamCoalescer({
      scheduler,
      onFlush: () => {
        throw new Error("persistence failed");
      },
      onTimerError: (error) => errors.push(error),
    });

    coalescer.append("pending");
    scheduler.runThrough(24);
    expect(errors).toEqual([expect.objectContaining({ message: "persistence failed" })]);
    expect(coalescer.hasPending).toBe(true);
    expect(coalescer.hasScheduledFlush).toBe(false);
    coalescer.dispose();
    expect(coalescer.hasPending).toBe(false);
    expect(scheduler.timers).toHaveLength(0);
  });
});

describe("TurnController coalesced streaming", () => {
  it("persists assistant prose on both sides of provider work as separate ordered messages", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Inspect, then explain.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);

    runtime.provider.emit({ ...identity, type: "text", text: "I’m checking the implementation." });
    runtime.provider.emit({
      ...identity,
      type: "activity",
      kind: "tool",
      phase: "started",
      label: "Read source",
    });
    runtime.provider.emit({
      ...identity,
      type: "activity",
      kind: "tool",
      phase: "completed",
      label: "Read source",
    });
    runtime.provider.emit({ ...identity, type: "text", text: "The source confirms the fix." });
    runtime.provider.resolve({
      status: "completed",
      text: "I’m checking the implementation.The source confirms the fix.",
    });
    await flushPromises();

    const turn = runtime.store.agentTurn(queued.turn.id);
    const assistantMessages = runtime.store.snapshot().messages
      .filter((message) => message.turnId === turn.id && message.role === "assistant");
    expect(assistantMessages.map(({ content }) => content)).toEqual([
      "I’m checking the implementation.",
      "The source confirms the fix.",
    ]);
    expect(turn.terminalAssistantMessageId).toBe(assistantMessages[1]?.id);
    const activity = runtime.store.snapshot().activities.find(({ turnId }) => turnId === turn.id);
    expect(activity).toMatchObject({
      turnId: turn.id,
      title: "Read source",
      status: "completed",
    });
    expect(Date.parse(assistantMessages[0]!.createdAt)).toBeLessThan(Date.parse(activity!.createdAt));
    expect(Date.parse(activity!.createdAt)).toBeLessThan(Date.parse(assistantMessages[1]!.createdAt));
    expect(runtime.events.filter(({ type }) =>
      type === "agent.text"
      || type === "agent.activity"
      || type === "agent.completed")).toEqual([
      expect.objectContaining({
        type: "agent.text",
        text: "I’m checking the implementation.",
      }),
      expect.objectContaining({
        type: "agent.activity",
        activity: expect.objectContaining({ status: "running" }),
      }),
      expect.objectContaining({
        type: "agent.activity",
        activity: expect.objectContaining({ status: "completed" }),
      }),
      expect.objectContaining({
        type: "agent.text",
        text: "The source confirms the fix.",
      }),
      expect.objectContaining({ type: "agent.completed" }),
    ]);

    const persistedAtSettlement = assistantMessages.map(({ id, content }) => ({ id, content }));
    expect(runtime.controller.handleProviderEvent({
      ...identity,
      type: "text",
      text: "late duplicate terminal text",
    })).toBe(false);
    expect(runtime.controller.handleProviderEvent({
      ...identity,
      type: "activity",
      kind: "tool",
      phase: "info",
      label: "Late activity",
    })).toBe(false);
    expect(runtime.store.snapshot().messages
      .filter((message) => message.turnId === turn.id && message.role === "assistant")
      .map(({ id, content }) => ({ id, content }))).toEqual(persistedAtSettlement);
    expect(runtime.events.filter(({ type }) => type === "agent.completed")).toHaveLength(1);
    runtime.store.close();
  });

  it("coalesces hundreds of interleaved deltas and drains both channels before approval", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Stream a long answer.",
    });
    const createMessage = vi.spyOn(runtime.store, "createMessage");
    const updateMessage = vi.spyOn(runtime.store, "updateMessageContent");
    const createReasoning = vi.spyOn(runtime.store, "createReasoning");
    const updateReasoning = vi.spyOn(runtime.store, "updateReasoning");
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);

    for (let index = 0; index < 600; index += 1) {
      runtime.provider.emit({ ...identity, type: "text", text: "a" });
      runtime.provider.emit({ ...identity, type: "reasoning-summary", text: "r" });
    }
    expect(runtime.events.filter(({ type }) =>
      type === "agent.text" || type === "agent.reasoning")).toEqual([]);
    expect(createMessage).not.toHaveBeenCalled();
    expect(createReasoning).not.toHaveBeenCalled();

    runtime.scheduler.runThrough(96);
    expect(runtime.events.filter(({ type }) => type === "agent.text")).toEqual([
      expect.objectContaining({ text: "a".repeat(600) }),
    ]);
    expect(runtime.events.filter(({ type }) => type === "agent.reasoning")).toEqual([
      expect.objectContaining({ text: "r".repeat(600) }),
    ]);

    for (let index = 0; index < 350; index += 1) {
      runtime.provider.emit({ ...identity, type: "text", text: "b" });
      runtime.provider.emit({ ...identity, type: "reasoning-summary", text: "s" });
    }
    runtime.provider.emit({
      ...identity,
      type: "approval",
      request: {
        requestId: "stream-approval",
        kind: "command",
        title: "Run the final check",
        permissionRoots: [],
        availableDecisions: ["approve", "cancel"],
      },
    });

    const streamed = runtime.events.filter(({ type }) =>
      type === "agent.text" || type === "agent.reasoning" || type === "agent.approval.requested");
    expect(streamed).toEqual([
      expect.objectContaining({ type: "agent.text", text: "a".repeat(600) }),
      expect.objectContaining({ type: "agent.reasoning", text: "r".repeat(600) }),
      expect.objectContaining({ type: "agent.text", text: "b".repeat(350) }),
      expect.objectContaining({ type: "agent.reasoning", text: "s".repeat(350) }),
      expect.objectContaining({ type: "agent.approval.requested" }),
    ]);
    expect(runtime.scheduler.shortTimerCount()).toBe(0);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(createReasoning).toHaveBeenCalledTimes(1);
    expect(updateReasoning).toHaveBeenCalledTimes(2);
    expect(
      createMessage.mock.calls.length
      + updateMessage.mock.calls.length
      + createReasoning.mock.calls.length
      + updateReasoning.mock.calls.length,
    ).toBeLessThan(10);

    runtime.provider.emit({
      ...identity,
      type: "approval-resolved",
      requestId: "stream-approval",
      decision: "approve",
    });
    runtime.provider.resolve({
      text: `${"a".repeat(600)}${"b".repeat(350)}`,
    });
    await flushPromises();

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(runtime.store.snapshot().messages).toContainEqual(expect.objectContaining({
      id: turn.terminalAssistantMessageId,
      content: `${"a".repeat(600)}${"b".repeat(350)}`,
    }));
    expect(runtime.store.snapshot().reasonings).toContainEqual(expect.objectContaining({
      turnId: queued.turn.id,
      content: `${"r".repeat(600)}${"s".repeat(350)}`,
      status: "completed",
    }));
    expect(runtime.scheduler.timers).toHaveLength(0);
    runtime.store.close();
  });

  it("flushes exact assistant and reasoning content when completion beats the timers", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Complete before the stream timer.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);
    for (const character of "pending assistant") {
      runtime.provider.emit({ ...identity, type: "text", text: character });
    }
    for (const character of "pending reasoning") {
      runtime.provider.emit({ ...identity, type: "reasoning-summary", text: character });
    }

    runtime.provider.resolve({
      status: "completed",
      text: "pending assistant",
    });
    await flushPromises();

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(runtime.store.snapshot().messages).toContainEqual(expect.objectContaining({
      id: turn.terminalAssistantMessageId,
      content: "pending assistant",
    }));
    expect(runtime.store.snapshot().reasonings).toContainEqual(expect.objectContaining({
      turnId: queued.turn.id,
      content: "pending reasoning",
      status: "completed",
    }));
    const streamEvents = runtime.events.filter(({ type }) =>
      type === "agent.text" || type === "agent.reasoning" || type === "agent.completed");
    expect(streamEvents).toEqual([
      expect.objectContaining({ type: "agent.text", text: "pending assistant" }),
      expect.objectContaining({ type: "agent.reasoning", text: "pending reasoning" }),
      expect.objectContaining({ type: "agent.completed" }),
    ]);
    expect(runtime.scheduler.timers).toHaveLength(0);
    runtime.store.close();
  });

  it("persists an authoritative terminal correction without appending it as a delta", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Correct the terminal value.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);
    runtime.provider.emit({ ...identity, type: "text", text: "draft value" });
    runtime.scheduler.runThrough(24);
    expect(runtime.events.filter(({ type }) => type === "agent.text")).toEqual([
      expect.objectContaining({ text: "draft value" }),
    ]);

    runtime.provider.resolve({
      status: "completed",
      text: "authoritative final value",
      textTruncated: false,
    });
    await flushPromises();

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(runtime.store.snapshot().messages).toContainEqual(expect.objectContaining({
      id: turn.terminalAssistantMessageId,
      content: "authoritative final value",
    }));
    expect(runtime.events.filter(({ type }) => type === "agent.text")).toHaveLength(1);
    expect(runtime.events.filter(({ type }) => type === "agent.completed")).toHaveLength(1);
    expect(runtime.scheduler.timers).toHaveLength(0);
    runtime.store.close();
  });

  it("flushes pending text before a cancellation wins a terminal race", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Cancel this turn.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);
    for (let index = 0; index < 400; index += 1) {
      runtime.provider.emit({ ...identity, type: "text", text: "z" });
    }

    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    runtime.provider.resolve({ status: "completed", text: "late provider result" });
    await flushPromises();

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(turn).toMatchObject({
      status: "cancelled",
      terminalReason: "user-cancelled",
    });
    expect(runtime.store.snapshot().messages).toContainEqual(expect.objectContaining({
      id: turn.terminalAssistantMessageId,
      content: "z".repeat(400),
    }));
    const terminalIndex = runtime.events.findIndex(({ type }) =>
      type === "agent.completed" || type === "agent.failed");
    const textIndex = runtime.events.findIndex(({ type }) => type === "agent.text");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeLessThan(terminalIndex);
    expect(runtime.events.filter(({ type }) =>
      type === "agent.completed" || type === "agent.failed")).toHaveLength(1);
    expect(runtime.scheduler.timers).toHaveLength(0);
    expect(runtime.controller.handleProviderEvent({
      ...identity,
      type: "text",
      text: "stale",
    })).toBe(false);
    expect(runtime.scheduler.timers).toHaveLength(0);
    runtime.store.close();
  });

  it("drains pending channels before runtime shutdown interrupts the turn", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Interrupt during shutdown.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);
    runtime.provider.emit({ ...identity, type: "text", text: "saved before shutdown" });
    runtime.provider.emit({
      ...identity,
      type: "reasoning-summary",
      text: "reasoning before shutdown",
    });

    await runtime.controller.dispose("runtime-shutdown");

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(turn).toMatchObject({
      status: "interrupted",
      terminalReason: "runtime-shutdown",
      terminalAssistantMessageId: expect.any(String),
    });
    expect(runtime.store.snapshot().messages).toContainEqual(expect.objectContaining({
      id: turn.terminalAssistantMessageId,
      content: "saved before shutdown",
    }));
    expect(runtime.store.snapshot().reasonings).toContainEqual(expect.objectContaining({
      turnId: turn.id,
      content: "reasoning before shutdown",
      status: "failed",
    }));
    expect(runtime.events.filter(({ type }) =>
      type === "agent.text" || type === "agent.reasoning" || type === "agent.failed")).toEqual([
      expect.objectContaining({ type: "agent.text", text: "saved before shutdown" }),
      expect.objectContaining({ type: "agent.reasoning", text: "reasoning before shutdown" }),
      expect.objectContaining({ type: "agent.failed" }),
    ]);
    expect(runtime.scheduler.timers).toHaveLength(0);
    runtime.store.close();
  });

  it("drains pending channels before a runtime crash interrupts the turn", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Preserve pending output across a runtime crash.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);
    runtime.provider.emit({
      ...identity,
      type: "text",
      text: "assistant output before crash",
    });
    runtime.provider.emit({
      ...identity,
      type: "reasoning-summary",
      text: "reasoning before crash",
    });

    await runtime.controller.dispose("runtime-crash");

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(turn).toMatchObject({
      status: "interrupted",
      terminalReason: "runtime-crash",
      terminalAssistantMessageId: expect.any(String),
    });
    expect(runtime.store.snapshot().messages).toContainEqual(expect.objectContaining({
      id: turn.terminalAssistantMessageId,
      turnId: turn.id,
      content: "assistant output before crash",
    }));
    expect(runtime.store.snapshot().reasonings).toContainEqual(expect.objectContaining({
      turnId: turn.id,
      content: "reasoning before crash",
      status: "failed",
    }));
    expect(runtime.events.filter(({ type }) =>
      type === "agent.text" || type === "agent.reasoning" || type === "agent.failed")).toEqual([
      expect.objectContaining({ type: "agent.text", text: "assistant output before crash" }),
      expect.objectContaining({ type: "agent.reasoning", text: "reasoning before crash" }),
      expect.objectContaining({ type: "agent.failed" }),
    ]);
    expect(runtime.scheduler.timers).toHaveLength(0);
    runtime.store.close();
  });

  it("settles a timer persistence error exactly once without leaking a timer exception", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Exercise persistence failure.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);
    const originalCreateMessage = runtime.store.createMessage.bind(runtime.store);
    vi.spyOn(runtime.store, "createMessage").mockImplementation((...args) => {
      if (args[2] === "assistant") throw new Error("forced assistant persistence failure");
      return originalCreateMessage(...args);
    });

    runtime.provider.emit({ ...identity, type: "text", text: "uncommitted text" });
    expect(() => runtime.scheduler.runThrough(24)).not.toThrow();
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: expect.stringContaining("stream-persistence-failed"),
    });
    expect(runtime.provider.cancelCount).toBe(1);
    expect(runtime.events.filter(({ type }) => type === "agent.failed")).toHaveLength(1);
    expect(runtime.events.filter(({ type }) => type === "agent.text")).toHaveLength(0);
    expect(runtime.scheduler.timers).toHaveLength(0);
    runtime.provider.emit({ ...identity, type: "text", text: "late" });
    expect(runtime.events.filter(({ type }) => type === "agent.failed")).toHaveLength(1);
    runtime.store.close();
  });
});

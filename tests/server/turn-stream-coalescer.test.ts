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
  type TurnControllerHooks,
  type TurnProviderRuntime,
  type TurnTimerScheduler,
} from "../../src/server/runtime/turns/turn-controller";
import { RuntimeSyncHub } from "../../src/server/runtime/runtime-sync-hub";
import {
  TurnStreamCoalescer,
  type StreamDeltaFlush,
} from "../../src/server/runtime/turns/turn-stream-coalescer";
import { TurnStreamChannel } from "../../src/server/runtime/turns/turn-stream-channel";
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
    for (const [id, timer] of this.timers) {
      if (timer.delayMs > maximumDelayMs) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }

  shortTimerCount(): number {
    return [...this.timers.values()].filter(({ delayMs }) => delayMs < 1_000).length;
  }
}

class ClockScheduler implements TurnTimerScheduler {
  private sequence = 0;
  private now = 0;
  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.sequence;
    this.timers.set(id, { callback, dueAt: this.now + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(delayMs: number): void {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) =>
          left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].dueAt;
      next[1].callback();
    }
    this.now = target;
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

  async stopOwned(): Promise<"settled"> {
    return "settled";
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
  databasePath: string;
  workspacePath: string;
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

async function controllerRuntime(
  hookOverrides: Partial<Pick<
    TurnControllerHooks,
    "broadcast" | "broadcastSnapshot"
  >> = {},
): Promise<ControllerRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-stream-coalescer-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(
    databasePath,
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
      broadcast: hookOverrides.broadcast ?? ((event) => events.push(event)),
      broadcastSnapshot: hookOverrides.broadcastSnapshot ?? (() => undefined),
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
    databasePath,
    workspacePath: workspace,
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

  it("keeps a sustained hundred-thousand-delta session bounded and lossless", () => {
    const scheduler = new ManualScheduler();
    const chunks: string[] = [];
    const coalescer = new TurnStreamCoalescer({
      scheduler,
      onFlush: ({ delta }) => chunks.push(delta),
      onTimerError: (error) => {
        throw error;
      },
    });

    for (let index = 0; index < 100_000; index += 1) {
      coalescer.append(String(index % 10));
    }
    coalescer.flush();

    expect(chunks.join("")).toBe(
      Array.from({ length: 100_000 }, (_, index) => String(index % 10)).join(""),
    );
    expect(chunks).toHaveLength(Math.ceil(100_000 / 1_024));
    expect(chunks.every((chunk) => chunk.length <= 1_024)).toBe(true);
    expect(coalescer.hasPending).toBe(false);
    expect(coalescer.hasScheduledFlush).toBe(false);
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

describe("TurnStreamChannel performance cadence", () => {
  it("reduces rewrites for a time-distributed stream without adding visible lag", () => {
    const oldScheduler = new ClockScheduler();
    const oldFlushes: string[] = [];
    const oldChannel = new TurnStreamCoalescer({
      scheduler: oldScheduler,
      onFlush: ({ delta }) => oldFlushes.push(delta),
      onTimerError: (error) => {
        throw error;
      },
    });
    const nextScheduler = new ClockScheduler();
    const projected: string[] = [];
    const persisted: string[] = [];
    const nextChannel = new TurnStreamChannel({
      scheduler: nextScheduler,
      onProjectionFlush: ({ delta }) => projected.push(delta),
      onPersistenceFlush: ({ delta }) => persisted.push(delta),
      onTimerError: (error) => {
        throw error;
      },
    });
    const chunk = "0123456789".repeat(10);

    for (let index = 0; index < 100; index += 1) {
      oldChannel.append(chunk);
      nextChannel.append(chunk);
      oldScheduler.advance(10);
      nextScheduler.advance(10);
    }
    oldChannel.flush();
    nextChannel.flush();

    expect(projected.join("")).toBe(chunk.repeat(100));
    expect(persisted).toEqual(projected);
    expect(projected.length).toBeLessThan(oldFlushes.length);
    expect(projected).toHaveLength(6);
    expect(oldFlushes).toHaveLength(11);
  });

  it("keeps projection responsive while reducing sustained persistence rewrites", () => {
    const scheduler = new ManualScheduler();
    const projected: string[] = [];
    const persisted: string[] = [];
    const channel = new TurnStreamChannel({
      scheduler,
      onProjectionFlush: ({ delta }) => projected.push(delta),
      onPersistenceFlush: ({ delta }) => persisted.push(delta),
      onTimerError: (error) => {
        throw error;
      },
    });

    for (let index = 0; index < 100_000; index += 1) channel.append("x");
    channel.flush();

    expect(projected.join("")).toBe("x".repeat(100_000));
    expect(persisted.join("")).toBe("x".repeat(100_000));
    expect(projected).toHaveLength(7);
    expect(persisted).toHaveLength(7);
    expect(persisted.length).toBeLessThan(
      Math.ceil(100_000 / 1_024) / 10,
    );
    expect(scheduler.timers).toHaveLength(0);
  });

  it("flushes durable state before every live and terminal projection", () => {
    const scheduler = new ManualScheduler();
    const order: string[] = [];
    const channel = new TurnStreamChannel({
      scheduler,
      onProjectionFlush: () => order.push("projected"),
      onPersistenceFlush: () => order.push("persisted"),
      onTimerError: (error) => {
        throw error;
      },
    });

    channel.append("terminal");
    scheduler.runThrough(24);

    expect(order).toEqual(["persisted", "projected"]);
    channel.append(" suffix");
    channel.flush();
    expect(order).toEqual([
      "persisted",
      "projected",
      "persisted",
      "projected",
    ]);
  });

  it("does not publish a suffix when its durable flush fails", () => {
    const scheduler = new ManualScheduler();
    const projected: string[] = [];
    const channel = new TurnStreamChannel({
      scheduler,
      onProjectionFlush: ({ delta }) => projected.push(delta),
      onPersistenceFlush: () => {
        throw new Error("disk unavailable");
      },
      onTimerError: () => undefined,
    });

    channel.append("not visible yet");
    scheduler.runThrough(24);

    expect(projected).toEqual([]);
    expect(channel.hasPending).toBe(true);
  });
});

describe("TurnController coalesced streaming", () => {
  it("reopens every suffix that was visible before an abrupt runtime loss", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Persist before projecting.",
    });
    runtime.controller.start(queued.turn.id);
    runtime.provider.emit({
      ...providerIdentity(runtime),
      type: "text",
      text: "This visible prefix must survive.",
    });
    runtime.scheduler.runThrough(24);
    expect(runtime.events).toContainEqual(expect.objectContaining({
      type: "agent.text",
      text: "This visible prefix must survive.",
    }));

    // Deliberately bypass TurnController.dispose(): this models a utility
    // process disappearing after projection rather than a graceful shutdown.
    runtime.store.close();
    const reopened = new RuntimeStore(
      runtime.databasePath,
      runtime.workspacePath,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.conversationDetail(runtime.conversationId)?.messages)
      .toContainEqual(expect.objectContaining({
        turnId: queued.turn.id,
        content: "This visible prefix must survive.",
      }));
    reopened.close();
  });

  it("hydrates an already projected live suffix exactly once for each renderer", async () => {
    const deliveries = new Map<string, ServerEvent[]>();
    const hub = new RuntimeSyncHub<string>((socket, event) => {
      const events = deliveries.get(socket) ?? [];
      events.push(event);
      deliveries.set(socket, events);
    });
    let runtime!: ControllerRuntime;
    runtime = await controllerRuntime({
      broadcast: (event) => hub.broadcast(event),
      broadcastSnapshot: () => hub.broadcastSnapshot((sync) => ({
        ...runtime.store.shellSnapshot([providerInfo()]),
        sync,
      })),
    });
    const hydration = () => ({
      beforeFreshSnapshot: () =>
        runtime.controller.flushActiveStreamsForHydration(),
      snapshot: (sync: ReturnType<typeof hub.cursor>) => ({
        ...runtime.store.shellSnapshot([providerInfo()]),
        sync,
      }),
      approvals: [],
      inputs: [],
      plans: [],
    });

    hub.connect("existing", { kind: "none" }, hydration());
    hub.setConversationSubscription(
      "existing",
      "primary",
      runtime.conversationId,
    );
    deliveries.set("existing", []);
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Reconnect during live projection.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);
    runtime.provider.emit({
      ...identity,
      type: "text",
      text: "Durable before visible.",
    });
    runtime.provider.emit({
      ...identity,
      type: "reasoning-summary",
      text: "Reasoning is durable too.",
    });
    runtime.scheduler.runThrough(24);

    const existingLive = deliveries.get("existing")?.filter(
      (event) => event.type === "runtime.event"
        && (
          event.event.type === "agent.text"
          || event.event.type === "agent.reasoning"
        ),
    ) ?? [];
    expect(existingLive).toHaveLength(2);
    expect(existingLive.map((frame) =>
      frame.type === "runtime.event" ? frame.event.type : null,
    )).toEqual(["agent.text", "agent.reasoning"]);

    hub.connect("fresh", { kind: "none" }, hydration());
    expect(deliveries.get("fresh")?.some(
      (event) => event.type === "server.welcome",
    )).toBe(true);
    const freshDetail = runtime.store.conversationDetail(
      runtime.conversationId,
    );
    expect(freshDetail?.messages).toContainEqual(
      expect.objectContaining({
        turnId: queued.turn.id,
        content: "Durable before visible.",
      }),
    );
    expect(freshDetail?.reasonings).toContainEqual(
      expect.objectContaining({
        turnId: queued.turn.id,
        content: "Reasoning is durable too.",
      }),
    );
    expect(deliveries.get("existing")?.filter(
      (event) => event.type === "runtime.event"
        && (
          event.event.type === "agent.text"
          || event.event.type === "agent.reasoning"
        ),
    )).toHaveLength(2);

    hub.setConversationSubscription(
      "fresh",
      "primary",
      runtime.conversationId,
    );
    runtime.provider.emit({ ...identity, type: "text", text: " Next." });
    runtime.scheduler.runThrough(240);
    for (const socket of ["existing", "fresh"]) {
      const suffixes = deliveries.get(socket)?.filter(
        (event): event is Extract<ServerEvent, { type: "runtime.event" }> =>
          event.type === "runtime.event"
          && event.event.type === "agent.text"
          && event.event.text === " Next.",
      ) ?? [];
      expect(suffixes).toHaveLength(1);
    }

    runtime.controller.cancel(runtime.conversationId);
    await flushPromises();
    runtime.store.close();
  });

  it("flushes live durable state before a fresh renderer hydration", async () => {
    const runtime = await controllerRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Reconnect while this answer is streaming.",
    });
    runtime.controller.start(queued.turn.id);
    const identity = providerIdentity(runtime);

    runtime.provider.emit({
      ...identity,
      type: "text",
      text: "Visible before the reconnect.",
    });
    runtime.scheduler.runThrough(24);
    expect(runtime.events).toContainEqual(expect.objectContaining({
      type: "agent.text",
      text: "Visible before the reconnect.",
    }));
    expect(runtime.store.snapshot().messages).toContainEqual(
      expect.objectContaining({
        turnId: queued.turn.id,
        content: "Visible before the reconnect.",
      }),
    );

    runtime.controller.flushActiveStreamsForHydration();

    expect(runtime.store.snapshot().messages).toContainEqual(
      expect.objectContaining({
        turnId: queued.turn.id,
        content: "Visible before the reconnect.",
      }),
    );
    runtime.controller.cancel(runtime.conversationId);
    await flushPromises();
    runtime.store.close();
  });

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
    expect(() => runtime.scheduler.runThrough(120)).not.toThrow();
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

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent, SubagentTaskUsage } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import type { ProviderSubagentEvent } from "../../src/server/provider/contracts";
import { defaultTurnScheduler } from "../../src/server/runtime/turns/turn-controller-support";
import type { ActiveTurn, TurnControllerHooks } from "../../src/server/runtime/turns/turn-controller-types";
import { TurnProviderEventProjector } from "../../src/server/runtime/turns/turn-provider-event-projector";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  emitTurnControllerTestSubagent,
  flushTurnControllerTestPromises,
} from "../support/turn-controller-runtime";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2030-01-01T00:00:00.000Z") });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
  await cleanupTurnControllerTestDirectories();
});

function usage(totalTokens: number): SubagentTaskUsage {
  return {
    totalTokens,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    contextTokens: null,
    maxContextTokens: null,
  };
}

async function projectorFixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-subagent-coalescing-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspacePath, {
    recoverInterruptedRuns: false,
  });
  stores.push(store);
  const project = store.createProject("Coalescing", workspacePath);
  const conversation = store.createConversation(project.id, "Delegated work", {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  const { turn } = store.beginAgentTurn({
    conversationId: conversation.id,
    runId: "run-coalescing",
    content: "Delegate.",
    providerId: "codex",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
  const writes = vi.spyOn(store, "upsertSubagentTrace");
  const broadcasts: ServerEvent[] = [];
  const observeSubagent = vi.fn(() => false);
  const projector = new TurnProviderEventProjector({
    store,
    hooks: {
      broadcast: (event: ServerEvent) => broadcasts.push(event),
      broadcastSnapshot: vi.fn(),
    } as unknown as TurnControllerHooks,
    agentPlans: new Map(),
    streams: {} as never,
    activities: {} as never,
    interactions: {} as never,
    scheduler: defaultTurnScheduler(),
    now: () => new Date().toISOString(),
    transition: () => false,
    observeSubagent,
  });
  const active = { conversation, turn } as unknown as ActiveTurn;
  const emit = (
    sequence: number,
    overrides: Partial<ProviderSubagentEvent> = {},
  ) => projector.project(active, {
    providerId: "codex",
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    type: "subagent",
    sequence,
    providerTaskId: null,
    providerAgentId: "child-1",
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "spawn-1",
    providerRole: "reviewer",
    providerName: "Reviewer",
    providerStatus: "running",
    status: "running",
    isLive: true,
    description: "Review the change.",
    progress: null,
    result: null,
    ...overrides,
  });
  const traceUpdates = () => broadcasts.filter((event) => event.type === "agent.subagent.updated");
  const stored = () => store.snapshot().subagents;
  return { store, active, writes, broadcasts, traceUpdates, observeSubagent, emit, stored };
}

describe("subagent telemetry coalescing", () => {
  it("bounds a telemetry burst to one write per second and delivers the final value", async () => {
    const { writes, traceUpdates, emit, stored } = await projectorFixture();
    emit(1);
    expect(writes).toHaveBeenCalledTimes(1);
    for (let index = 1; index <= 50; index += 1) {
      vi.advanceTimersByTime(4);
      emit(index + 1, {
        activity: `Step ${index}`,
        usage: usage(index * 10),
        toolUseCount: index,
        durationMs: index * 4,
      });
    }
    expect(writes).toHaveBeenCalledTimes(1);
    expect(traceUpdates()).toHaveLength(1);
    vi.advanceTimersByTime(799);
    expect(writes).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(traceUpdates()).toHaveLength(2);
    expect(stored()[0]).toMatchObject({
      sequence: 51,
      activity: "Step 50",
      usage: usage(500),
      toolUseCount: 50,
      durationMs: 200,
    });
    expect(traceUpdates().at(-1)).toMatchObject({ trace: { sequence: 51, activity: "Step 50" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("merges buffered usage field by field before writing", async () => {
    const { writes, emit, stored } = await projectorFixture();
    emit(1);
    emit(2, { usage: { ...usage(100), inputTokens: 80 }, activity: "Reading" });
    emit(3, { usage: { ...usage(150), inputTokens: null, outputTokens: 20 } });
    emit(4, { toolUseCount: 2 });
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(stored()[0]).toMatchObject({
      sequence: 4,
      activity: "Reading",
      usage: { ...usage(150), inputTokens: 80, outputTokens: 20 },
      toolUseCount: 2,
    });
  });

  it("writes telemetry immediately once the window has elapsed", async () => {
    const { writes, emit } = await projectorFixture();
    emit(1);
    vi.advanceTimersByTime(1_000);
    emit(2, { activity: "Searching" });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes buffered telemetry before a lifecycle patch in sequence order", async () => {
    const { writes, traceUpdates, emit, stored } = await projectorFixture();
    emit(1);
    emit(2, { activity: "Editing", usage: usage(40) });
    expect(writes).toHaveBeenCalledTimes(1);
    emit(3, { providerAgentId: "child-2", providerToolUseId: "spawn-2", providerName: "Second" });
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 2, 3]);
    emit(4, { providerAgentId: "child-2", providerToolUseId: "spawn-2", providerName: "Second", activity: "Testing" });
    expect(writes).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    emit(5, { progress: "Halfway there." });
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(traceUpdates().map((event) => event.type === "agent.subagent.updated" && event.trace.sequence))
      .toEqual([1, 2, 3, 4, 5]);
    expect(vi.getTimerCount()).toBe(0);
    expect(stored()).toHaveLength(2);
    expect(stored()).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerAgentId: "child-1", sequence: 5, progress: "Halfway there.", activity: "Editing" }),
      expect.objectContaining({ providerAgentId: "child-2", sequence: 4, activity: "Testing" }),
    ]));
  });

  it("writes status changes, terminal states and stale patches without delay", async () => {
    const { writes, emit, stored } = await projectorFixture();
    emit(1);
    emit(2, { status: "waiting", providerStatus: "waiting" });
    emit(3, { providerStatus: "waiting", status: "waiting", activity: "Waiting on input" });
    expect(writes).toHaveBeenCalledTimes(2);
    emit(2, { providerStatus: "waiting", status: "waiting", activity: "Stale" });
    expect(writes).toHaveBeenCalledTimes(4);
    emit(4, { status: "completed", isLive: false, providerStatus: "completed", usage: usage(90), result: "Done." });
    expect(writes).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(stored()[0]).toMatchObject({
      sequence: 4,
      status: "completed",
      activity: null,
      usage: usage(90),
    });
    emit(5, { status: "completed", isLive: false, providerStatus: "completed", usage: usage(95) });
    expect(writes).toHaveBeenCalledTimes(6);
    expect(stored()[0]).toMatchObject({ sequence: 5, usage: usage(95) });
  });

  it("flushes on settlement and never fires after the turn closes", async () => {
    const { active, writes, emit, stored } = await projectorFixture();
    emit(1);
    emit(2, { activity: "Compiling", toolUseCount: 9 });
    expect(vi.getTimerCount()).toBe(1);
    active.subagentTelemetry?.close();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(stored()[0]).toMatchObject({ sequence: 2, activity: "Compiling", toolUseCount: 9 });
    expect(vi.getTimerCount()).toBe(0);
    emit(3, { activity: "After close" });
    expect(writes).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(writes).toHaveBeenCalledTimes(3);
  });

  it("keeps buffered telemetry when a timed write fails and retries it at the next flush", async () => {
    const { active, writes, emit, stored } = await projectorFixture();
    emit(1);
    emit(2, { activity: "Retrying", toolUseCount: 4 });
    writes.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(stored()[0]).toMatchObject({ sequence: 1, activity: null });
    active.subagentTelemetry?.close();
    expect(stored()[0]).toMatchObject({ sequence: 2, activity: "Retrying", toolUseCount: 4 });
  });
});

describe("subagent telemetry settlement", () => {
  it("delivers buffered telemetry before the turn settles live work and leaves no timer", async () => {
    let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
    const runtime = await createTurnControllerTestRuntime({}, { clock: () => new Date(clockMs) });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Delegate this work.",
    });
    runtime.controller.start(queued.turn.id);
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1,
      providerTaskId: "task-1",
      status: "running",
      isLive: true,
    });
    clockMs += 10;
    emitTurnControllerTestSubagent(runtime, {
      sequence: 2,
      providerTaskId: "task-1",
      status: "running",
      isLive: true,
      activity: "Running tests",
      usage: usage(321),
    });
    expect([...runtime.scheduler.delays.values()]).toContain(990);
    expect(runtime.store.conversationDetail(runtime.conversationId)?.subagents[0])
      .toMatchObject({ sequence: 1, usage: null });

    runtime.provider.resolve();
    await flushTurnControllerTestPromises();

    expect(runtime.store.conversationDetail(runtime.conversationId)?.subagents[0]).toMatchObject({
      status: "lost",
      isLive: false,
      activity: null,
      usage: usage(321),
    });
    expect(runtime.scheduler.callbacks.size).toBe(0);
    runtime.store.close();
  });
});

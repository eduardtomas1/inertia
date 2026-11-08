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

  it("coalesces step snapshots like activity and keeps the latest one", async () => {
    const { writes, emit, stored } = await projectorFixture();
    emit(1);
    emit(2, { steps: [{ label: "Read · a.ts", status: "running" }], activity: "Read · a.ts" });
    emit(3, { steps: [{ label: "Read · a.ts", status: "completed" }, { label: "Bash · npm test", status: "running" }] });
    emit(4, { usage: usage(30) });
    expect(writes).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(stored()[0]).toMatchObject({
      sequence: 4,
      activity: "Read · a.ts",
      steps: [{ label: "Read · a.ts", status: "completed" }, { label: "Bash · npm test", status: "running" }],
      usage: usage(30),
    });
  });

  it("writes a new task shape at once instead of holding it with telemetry", async () => {
    const { writes, emit, stored } = await projectorFixture();
    emit(1, { taskKind: "shell", background: false, command: "npm test" });
    emit(2, { taskKind: "shell", background: false, command: "npm test", activity: "Running" });
    expect(writes).toHaveBeenCalledTimes(1);
    emit(3, { taskKind: "shell", background: true, command: "npm test" });
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 2, 3]);
    emit(4, { taskKind: "shell", background: true, command: "npm run build" });
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 2, 3, 4]);
    emit(5, { taskKind: "shell", background: true, command: "npm run build", effort: "low" });
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(stored()[0]).toMatchObject({ taskKind: "shell", background: true, command: "npm run build", sequence: 5 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes telemetry immediately once the window has elapsed", async () => {
    const { writes, emit } = await projectorFixture();
    emit(1);
    vi.advanceTimersByTime(1_000);
    emit(2, { activity: "Searching" });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes a task's buffered telemetry before its own lifecycle patch and keeps siblings held", async () => {
    const { writes, traceUpdates, emit, stored } = await projectorFixture();
    emit(1);
    emit(2, { activity: "Editing", usage: usage(40) });
    expect(writes).toHaveBeenCalledTimes(1);
    emit(3, { providerAgentId: "child-2", providerToolUseId: "spawn-2", providerName: "Second" });
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 3]);
    expect(vi.getTimerCount()).toBe(1);
    emit(4, { providerAgentId: "child-2", providerToolUseId: "spawn-2", providerName: "Second", activity: "Testing" });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);
    emit(5, { progress: "Halfway there." });
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 3, 2, 5]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(writes.mock.calls.map(([input]) => input.sequence)).toEqual([1, 3, 2, 5, 4]);
    expect(traceUpdates().map((event) => event.type === "agent.subagent.updated" && event.trace.sequence))
      .toEqual([1, 3, 2, 5, 4]);
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
  it("keeps telemetry held for a sub-agent the user stops", async () => {
    let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
    const runtime = await createTurnControllerTestRuntime({}, {
      clock: () => new Date(clockMs),
      modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Delegate this work.",
    });
    runtime.controller.start(queued.turn.id);
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1,
      providerTaskId: "task-1",
      providerToolUseId: "tool-1",
      status: "running",
      isLive: true,
    });
    clockMs += 10;
    emitTurnControllerTestSubagent(runtime, {
      sequence: 2,
      providerTaskId: "task-1",
      providerToolUseId: "tool-1",
      status: "running",
      isLive: true,
      activity: "Bash",
      usage: usage(5_000),
      toolUseCount: 12,
      durationMs: 9_000,
    });
    const traceId = runtime.store.conversationDetail(runtime.conversationId)!.subagents[0]!.id;
    expect(runtime.store.subagentTrace(traceId)).toMatchObject({ sequence: 1, usage: null });

    expect(await runtime.controller.stopSubagent(runtime.conversationId, traceId)).toBe(true);

    expect(runtime.store.subagentTrace(traceId)).toMatchObject({
      status: "cancelled",
      isLive: false,
      sequence: 2,
      activity: null,
      usage: usage(5_000),
      toolUseCount: 12,
      durationMs: 9_000,
    });
    expect([...runtime.scheduler.delays.values()]).not.toContain(990);
    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });

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

describe("remote agents at turn end", () => {
  it("completes the turn normally and leaves a live remote agent running in the cloud", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Review in the cloud." });
    runtime.controller.start(queued.turn.id);
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1, providerTaskId: "cloud-task", providerToolUseId: "tool-cloud", status: "running", isLive: true,
      providerStatus: "remote_launched", taskKind: "remote", background: true, description: "Review in the cloud",
    });
    await flushTurnControllerTestPromises();
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("running");
    runtime.provider.resolve({ status: "completed" });
    await flushTurnControllerTestPromises();
    await runtime.controller.drainSettlementTasks();
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed");
    expect(runtime.store.conversationDetail(runtime.conversationId)?.subagents).toEqual([
      expect.objectContaining({ taskKind: "remote", status: "unknown", isLive: false, progress: "Running in the cloud." }),
    ]);
    runtime.store.close();
  });
});

const STOP_UNCONFIRMED_NOTE = "The provider process could not be confirmed stopped; it may still be running.";

function notedActivities(runtime: Awaited<ReturnType<typeof createTurnControllerTestRuntime>>, turnId: string) {
  return (runtime.store.conversationDetail(runtime.conversationId)?.activities ?? []).filter((activity) =>
    activity.turnId === turnId && `${activity.title}
${activity.detail ?? ""}`.includes(STOP_UNCONFIRMED_NOTE));
}

describe("background commands at turn end", () => {
  it.each([
    ["confirmed", "settled", "Stopped", { status: "cancelled" }],
    ["unconfirmed", "force-detached", `Stopped. ${STOP_UNCONFIRMED_NOTE}`, { status: "unknown", progress: "May still be running: the provider did not confirm it stopped." }],
  ] as const)("settles a live background command by whether provider cleanup was %s", async (_label, outcome, detail, expected) => {
    const runtime = await createTurnControllerTestRuntime();
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Serve the app." });
    runtime.controller.start(queued.turn.id);
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1, providerTaskId: "shell-dev", status: "running", isLive: true,
      taskKind: "shell", background: true, command: "npm run dev",
    });
    await flushTurnControllerTestPromises();
    runtime.provider.deferOwnedStop(outcome);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    runtime.provider.resolveOwnedStop();
    await runtime.controller.waitForProviderCleanup([runtime.conversationId]);
    await flushTurnControllerTestPromises();
    const [trace] = runtime.store.conversationDetail(runtime.conversationId)!.subagents;
    expect(trace).toMatchObject({ taskKind: "shell", isLive: false, ...expected });
    expect(runtime.store.workspaceRun(queued.turn.runId).detail).toBe(detail);
    runtime.store.close();
  });

  it("notes a completed turn's unconfirmed cleanup once and leaves its live background command unknown", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Serve the app." });
    runtime.controller.start(queued.turn.id);
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1, providerTaskId: "shell-dev", status: "running", isLive: true,
      taskKind: "shell", background: true, command: "npm run dev",
    });
    await flushTurnControllerTestPromises();
    let released = false;
    const isRunning = runtime.provider.isRunning.bind(runtime.provider);
    vi.spyOn(runtime.provider, "isRunning").mockImplementation((id) => !released && isRunning(id));
    vi.spyOn(runtime.provider, "stopOwned").mockImplementation(async () => {
      released = true;
      return "force-detached";
    });
    runtime.provider.resolve({ status: "completed", sessionId: "provider-session" });
    await flushTurnControllerTestPromises();
    await runtime.controller.drainSettlementTasks();
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed");
    expect(runtime.store.workspaceRun(queued.turn.runId).detail).toBe(STOP_UNCONFIRMED_NOTE);
    expect(notedActivities(runtime, queued.turn.id)).toEqual([expect.objectContaining({
      kind: "status", title: STOP_UNCONFIRMED_NOTE, status: "completed",
    })]);
    expect(runtime.store.conversationDetail(runtime.conversationId)?.subagents).toEqual([
      expect.objectContaining({
        taskKind: "shell", status: "unknown", isLive: false,
        progress: "May still be running: the provider did not confirm it stopped.",
      }),
    ]);
    vi.restoreAllMocks();
    runtime.store.close();
  });
});

describe("subagent controls", () => {
  async function claudeRuntime() {
    const runtime = await createTurnControllerTestRuntime({}, {
      modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
    });
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Delegate." });
    runtime.controller.start(queued.turn.id);
    const traceFor = (providerToolUseId: string) => runtime.store.conversationDetail(runtime.conversationId)!
      .subagents.find((trace) => trace.providerToolUseId === providerToolUseId)!;
    return { runtime, traceFor };
  }

  it("keeps an agent Claude has not given a task id yet live while its Stop is held", async () => {
    const { runtime, traceFor } = await claudeRuntime();
    runtime.provider.queuedStopOutcome = "queued";
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1,
      providerTaskId: null,
      providerAgentId: "agent-early",
      providerToolUseId: "tool-early",
      status: "running",
      isLive: true,
      progress: "Reading",
    });
    const trace = traceFor("tool-early");
    const broadcasts = runtime.events.length;
    expect(await runtime.controller.stopSubagent(runtime.conversationId, trace.id)).toBe(true);
    expect(runtime.provider.stoppedSubagentIds).toEqual(["tool:tool-early"]);
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({ status: "running", isLive: true, progress: "Stop requested." });
    expect(runtime.events.slice(broadcasts)).toContainEqual(expect.objectContaining({
      type: "agent.subagent.updated",
      trace: expect.objectContaining({ id: trace.id, isLive: true, progress: "Stop requested." }),
    }));
    expect(await runtime.controller.stopSubagent(runtime.conversationId, trace.id)).toBe(true);
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({ isLive: true, progress: "Stop requested." });
    emitTurnControllerTestSubagent(runtime, {
      sequence: 2, providerTaskId: "task-early", providerAgentId: "agent-early", providerToolUseId: "tool-early",
      status: "cancelled", isLive: false, providerStatus: "stopped", progress: "Stopped by the user.",
    });
    await flushTurnControllerTestPromises();
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({ status: "cancelled", isLive: false, progress: "Stopped by the user." });
    expect(await runtime.controller.stopSubagent(runtime.conversationId, trace.id)).toBe(false);
    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });

  it("settles a held Stop's agent with the turn when Claude never starts its task", async () => {
    const { runtime, traceFor } = await claudeRuntime();
    runtime.provider.queuedStopOutcome = "queued";
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1, providerTaskId: null, providerAgentId: "agent-never", providerToolUseId: "tool-never",
      status: "running", isLive: true,
    });
    const trace = traceFor("tool-never");
    expect(await runtime.controller.stopSubagent(runtime.conversationId, trace.id)).toBe(true);
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({ isLive: true, progress: "Stop requested." });
    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    expect(runtime.store.subagentTrace(trace.id)).toMatchObject({ status: "lost", isLive: false });
    runtime.store.close();
  });

  it("moves only a live foreground Claude agent to the background and reports why it could not", async () => {
    const { runtime, traceFor } = await claudeRuntime();
    emitTurnControllerTestSubagent(runtime, {
      sequence: 1, providerTaskId: "task-fg", providerToolUseId: "tool-fg", status: "running", isLive: true, background: false,
    });
    emitTurnControllerTestSubagent(runtime, {
      sequence: 2, providerTaskId: "task-bg", providerToolUseId: "tool-bg", status: "running", isLive: true, background: true,
    });
    emitTurnControllerTestSubagent(runtime, {
      sequence: 3, providerTaskId: "task-shell", providerToolUseId: "tool-shell", status: "running", isLive: true,
      background: false, taskKind: "shell", command: "npm test",
    });
    expect(await runtime.controller.backgroundSubagent(runtime.conversationId, traceFor("tool-fg").id))
      .toMatchObject({ moved: true });
    expect(runtime.provider.backgroundedToolUseIds).toEqual(["tool-fg"]);
    for (const toolUseId of ["tool-bg", "tool-shell"]) {
      expect(await runtime.controller.backgroundSubagent(runtime.conversationId, traceFor(toolUseId).id))
        .toEqual({ moved: false, error: "That Claude agent is no longer running in the foreground." });
    }
    runtime.provider.backgroundResult = { moved: false, error: "Background tasks are disabled for this session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)" };
    expect(await runtime.controller.backgroundSubagent(runtime.conversationId, traceFor("tool-fg").id))
      .toEqual({ moved: false, error: "Background tasks are disabled for this session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)" });
    expect(runtime.provider.backgroundedToolUseIds).toEqual(["tool-fg", "tool-fg"]);
    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });
});

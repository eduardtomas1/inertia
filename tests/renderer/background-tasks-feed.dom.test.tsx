import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  BackgroundTasksSurface,
  type BackgroundTasksSurfaceProps,
} from "../../src/renderer/src/components/BackgroundTasksSurface";
import type { BackgroundTaskCursor, BackgroundTasksResult } from "../../src/shared/background-tasks";
import type { SubagentTrace } from "../../src/shared/contracts";
import { requestBackgroundTaskReveal, takeBackgroundTaskReveal } from "../../src/renderer/src/utils/backgroundTaskReveal";
import { taskTrace, taskTurn, workspaceRun } from "./background-task-fixtures";

const loadedTurn = taskTurn({ id: "turn-new", runId: "run-new", requestedAt: "2030-01-01T01:00:00.000Z" });

function finishedTrace(index: number, update: Partial<SubagentTrace> = {}): SubagentTrace {
  return taskTrace({
    id: `old-${String(index).padStart(2, "0")}`,
    turnId: "turn-old",
    runId: "run-old",
    providerTaskId: `task-old-${index}`,
    providerName: `Old ${index}`,
    status: "completed",
    createdAt: `2030-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    ...update,
  });
}

const old = Array.from({ length: 45 }, (_, index) => finishedTrace(index));
const live = taskTrace({ id: "live", turnId: "turn-new", runId: "run-new", providerName: "Live helper", createdAt: "2030-01-01T01:00:01.000Z" });

function page(before: BackgroundTaskCursor | null, update: Partial<BackgroundTasksResult> = {}): BackgroundTasksResult {
  const sorted = [...old].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const start = before ? sorted.findIndex(({ id }) => `agent:${id}` === before.key) + 1 : 0;
  const slice = sorted.slice(start, start + 20);
  const last = slice.at(-1)!;
  return {
    kind: "conversation.background-tasks",
    conversationId: "conversation-1",
    subagents: [live, ...slice],
    runs: [],
    finishedCount: 45,
    failedCount: 0,
    next: start + 20 < sorted.length ? { startedAt: last.createdAt, key: `agent:${last.id}` } : null,
    ...update,
  };
}

function surface(overrides: Partial<BackgroundTasksSurfaceProps>): React.JSX.Element {
  return (
    <BackgroundTasksSurface
      runtimeStatus="online"
      subagents={[live]}
      turns={[loadedTurn]}
      runs={[]}
      conversationId="conversation-1"
      onOpenSubagent={vi.fn()}
      {...overrides}
    />
  );
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2030-01-01T01:01:00.000Z") });
  vi.stubGlobal("matchMedia", () => ({
    matches: false, media: "", onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Background tasks for the whole chat", () => {
  it("shows whole-chat totals with only the newest transcript page loaded and pages the rest on request", async () => {
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => page(before, { failedCount: 2 }));
    render(surface({ loadTasks }));
    await flush();
    const finished = screen.getByRole("button", { name: "Finished 45 · 2 failed" });
    act(() => finished.click());
    const list = screen.getByRole("list", { name: "Finished" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Old 44");
    act(() => screen.getByRole("button", { name: "Show 25 more finished tasks" }).click());
    await flush();
    expect(loadTasks.mock.calls.map(([before]) => before?.key ?? null)).toEqual([null, "agent:old-25"]);
    expect(within(list).getAllByRole("listitem")).toHaveLength(40);
    act(() => screen.getByRole("button", { name: "Show 5 more finished tasks" }).click());
    await flush();
    expect(within(list).getAllByRole("listitem")).toHaveLength(45);
    expect(new Set(within(list).getAllByRole("listitem").map((item) => item.textContent)).size).toBe(45);
    expect(screen.getByRole("button", { name: "Show fewer finished tasks" })).toHaveAttribute("aria-expanded", "true");
    expect(within(list).getAllByRole("listitem")[44]).toHaveTextContent("Old 0");
  });

  it("loads further pages until a revealed turn's first card is found", async () => {
    const original = [...old];
    old.splice(3, 1, { ...old[3]!, turnId: "turn-deep" });
    onTestFinished(() => { old.splice(0, old.length, ...original); });
    const scrolled = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrolled);
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => page(before));
    const deepTurn = taskTurn({ id: "turn-deep", runId: "run-deep", requestedAt: "2030-01-01T00:00:00.000Z" });
    render(surface({ loadTasks, turns: [deepTurn, loadedTurn] }));
    await flush();
    act(() => requestBackgroundTaskReveal({ conversationId: "conversation-1", turnId: "turn-deep" }));
    for (let step = 0; step < 4; step += 1) await flush();
    expect(loadTasks).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: /^Finished 45/u })).toHaveAttribute("aria-expanded", "true");
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts[0]).toHaveTextContent("Old 3");
    takeBackgroundTaskReveal("conversation-1");
  });

  it("does not offer View turn for a task whose turn is not loaded", async () => {
    render(surface({ loadTasks: async (before) => page(before) }));
    await flush();
    act(() => screen.getByRole("button", { name: /^Finished 45/u }).click());
    act(() => screen.getByRole("button", { name: "View transcript for Old 44" }).click());
    expect(screen.queryByRole("button", { name: "View turn for Old 44" })).toBeNull();
    act(() => screen.getByRole("button", { name: "View transcript for Live helper" }).click());
    expect(screen.getByRole("button", { name: "View turn for Live helper" })).toBeVisible();
  });

  it("applies a live event to the fetched list once and refreshes the totals at most once a second", async () => {
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => page(before));
    const view = render(surface({ loadTasks }));
    await flush();
    expect(screen.getByRole("list", { name: "Running" })).toHaveTextContent("Live helper");
    view.rerender(surface({ loadTasks, subagents: [{ ...live, activity: "Reading", sequence: 2 }] }));
    view.rerender(surface({ loadTasks, subagents: [{ ...live, activity: "Editing", sequence: 3 }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(loadTasks).toHaveBeenCalledTimes(1);
    const done = { ...live, status: "completed" as const, isLive: false, sequence: 4 };
    loadTasks.mockImplementation(async (before) => ({ ...page(before), subagents: [done, ...page(before).subagents.slice(1)], finishedCount: 46 }));
    view.rerender(surface({ loadTasks, subagents: [done] }));
    expect(screen.queryByRole("list", { name: "Running" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Finished 46/u })).toBeVisible();
    view.rerender(surface({ loadTasks, subagents: [{ ...done, sequence: 5 }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(loadTasks).toHaveBeenCalledTimes(2);
    act(() => screen.getByRole("button", { name: /^Finished 46/u }).click());
    const items = within(screen.getByRole("list", { name: "Finished" })).getAllByRole("listitem");
    expect(items.filter((item) => item.textContent?.includes("Live helper"))).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Live helper");
  });

  it("takes a dismissed command out of the list and the totals at once", async () => {
    const lint = workspaceRun({ id: "lint", label: "npm run lint", status: "failed", canStop: false, startedAt: "2030-01-01T00:59:00.000Z", finishedAt: "2030-01-01T00:59:30.000Z" });
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => ({ ...page(before), runs: [lint], finishedCount: 46, failedCount: 1 }));
    const view = render(surface({ loadTasks }));
    await flush();
    expect(screen.getByRole("button", { name: "Finished 46 · 1 failed" })).toBeVisible();
    loadTasks.mockImplementation(async (before) => ({ ...page(before), runs: [], finishedCount: 45, failedCount: 0 }));
    view.rerender(surface({ loadTasks, runs: [{ ...lint, attentionState: "dismissed" }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("button", { name: "Finished 45" })).toBeVisible();
  });

  it("starts over for another chat and ignores the previous chat's late answer", async () => {
    let resolveFirst!: (value: BackgroundTasksResult) => void;
    const loadTasks = vi.fn((before: BackgroundTaskCursor | null) => before === null && loadTasks.mock.calls.length === 1
      ? new Promise<BackgroundTasksResult>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve({ ...page(null), conversationId: "conversation-2", subagents: [], finishedCount: 0 }));
    const view = render(surface({ loadTasks }));
    view.rerender(surface({ loadTasks, conversationId: "conversation-2", subagents: [], turns: [] }));
    await flush();
    await act(async () => { resolveFirst(page(null)); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("button", { name: /^Finished/u })).toBeNull();
    expect(screen.getByText("No background tasks.")).toBeVisible();
  });

  it("keeps showing what the transcript knows when the runtime cannot answer", async () => {
    const loadTasks = vi.fn(async () => { throw new Error("offline"); });
    render(surface({ loadTasks, subagents: [live, finishedTrace(1, { turnId: "turn-new" })] }));
    await flush();
    expect(screen.getByRole("button", { name: "Finished 1" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Running" })).toHaveTextContent("Live helper");
  });

  it("reveals a turn whose tasks are all still running with one read", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => page(before));
    render(surface({ loadTasks }));
    await flush();
    act(() => requestBackgroundTaskReveal({ conversationId: "conversation-1", turnId: "turn-new" }));
    for (let step = 0; step < 6; step += 1) await flush();
    takeBackgroundTaskReveal("conversation-1");
    expect(loadTasks).toHaveBeenCalledTimes(1);
  });

  it("stops a reveal after a failed page read instead of retrying on every update", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => {
      if (before) throw new Error("offline");
      return page(null);
    });
    const quiet = taskTurn({ id: "turn-quiet", runId: "run-quiet", requestedAt: "2030-01-01T00:00:00.000Z" });
    const turns = [quiet, loadedTurn];
    const view = render(surface({ loadTasks, turns }));
    await flush();
    act(() => requestBackgroundTaskReveal({ conversationId: "conversation-1", turnId: "turn-unloaded" }));
    for (let step = 0; step < 4; step += 1) await flush();
    expect(loadTasks).toHaveBeenCalledTimes(1);
    act(() => requestBackgroundTaskReveal({ conversationId: "conversation-1", turnId: "turn-quiet" }));
    for (let step = 0; step < 4; step += 1) await flush();
    expect(loadTasks).toHaveBeenCalledTimes(2);
    view.rerender(surface({ loadTasks, turns, subagents: [{ ...live, activity: "Reading", sequence: 2 }] }));
    for (let step = 0; step < 4; step += 1) await flush();
    expect(loadTasks).toHaveBeenCalledTimes(2);
  });

  it("removes a dismissed command that is only known from the whole-chat read", async () => {
    const lint = workspaceRun({ id: "lint", label: "npm run lint", status: "failed", canStop: false, startedAt: "2030-01-01T00:59:00.000Z", finishedAt: "2030-01-01T00:59:30.000Z" });
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => ({ ...page(before), runs: [lint], finishedCount: 46, failedCount: 1 }));
    const onDismissCommand = vi.fn();
    render(surface({ loadTasks, onDismissCommand }));
    await flush();
    expect(screen.getByRole("button", { name: "Finished 46 · 1 failed" })).toBeVisible();
    loadTasks.mockImplementation(async (before) => ({ ...page(before), runs: [], finishedCount: 45, failedCount: 0 }));
    act(() => screen.getByRole("button", { name: "Dismiss finished commands" }).click());
    expect(onDismissCommand).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Finished 45" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(loadTasks).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Finished 45" })).toBeVisible();
  });

  it("moves a command that finishes outside the snapshot into the fully loaded Finished list", async () => {
    const deploy = workspaceRun({ id: "deploy", label: "Deploy preview", status: "running", canStop: true, startedAt: "2030-01-01T00:00:10.500Z", finishedAt: null });
    let deployDone = false;
    const loadTasks = vi.fn(async (before: BackgroundTaskCursor | null) => {
      const base = page(before);
      if (!deployDone) return { ...base, runs: before ? [] : [deploy] };
      const finished = { ...deploy, status: "succeeded" as const, canStop: false, finishedAt: "2030-01-01T01:00:30.000Z" };
      const deep = before !== null && before.startedAt > finished.startedAt;
      return { ...base, finishedCount: 46, runs: deep ? [finished] : [] };
    });
    const onStopCommand = vi.fn();
    render(surface({ loadTasks, onStopCommand }));
    await flush();
    expect(screen.getByRole("list", { name: "Running" })).toHaveTextContent("Deploy preview");
    act(() => screen.getByRole("button", { name: "Stop Deploy preview" }).click());
    expect(onStopCommand).toHaveBeenCalledWith(deploy);
    act(() => screen.getByRole("button", { name: /^Finished 45/u }).click());
    act(() => screen.getByRole("button", { name: "Show 25 more finished tasks" }).click());
    await flush();
    act(() => screen.getByRole("button", { name: "Show 5 more finished tasks" }).click());
    await flush();
    expect(screen.getByRole("button", { name: "Show fewer finished tasks" })).toBeVisible();
    deployDone = true;
    for (let step = 0; step < 5; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.getByRole("list", { name: "Running" })).not.toHaveTextContent("Deploy preview");
    expect(screen.getByRole("list", { name: "Finished" })).toHaveTextContent("Deploy preview");
    expect(screen.getByRole("button", { name: "Finished 46" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Show fewer finished tasks" })).toBeVisible();
    const calls = loadTasks.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(loadTasks).toHaveBeenCalledTimes(calls);
  });

  it("keeps refreshing the newly opened chat after a superseded refresh timer fires", async () => {
    const pendingA: Array<(value: BackgroundTasksResult) => void> = [];
    const loadA = vi.fn((_before: BackgroundTaskCursor | null) => new Promise<BackgroundTasksResult>((resolve) => { pendingA.push(resolve); }));
    const view = render(surface({ loadTasks: loadA }));
    expect(loadA).toHaveBeenCalledTimes(1);
    const probe = workspaceRun({ id: "probe", status: "running", canStop: false });
    view.rerender(surface({ loadTasks: loadA, runs: [probe] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    view.rerender(surface({ loadTasks: loadA, runs: [{ ...probe, status: "failed" }] }));
    await act(async () => { pendingA.shift()!(page(null)); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(loadA).toHaveBeenCalledTimes(2);
    await act(async () => { pendingA.shift()!(page(null)); await Promise.resolve(); await Promise.resolve(); });

    const chatB = (update: Partial<SubagentTrace> = {}) => taskTrace({ id: "b-live", conversationId: "conversation-2", turnId: "turn-b", runId: "run-b", ...update });
    const loadB = vi.fn(async (_before: BackgroundTaskCursor | null) => ({
      ...page(null), conversationId: "conversation-2", subagents: [chatB()], finishedCount: 0, next: null,
    }));
    const turnB = taskTurn({ id: "turn-b", runId: "run-b", conversationId: "conversation-2" });
    view.rerender(surface({ loadTasks: loadB, conversationId: "conversation-2", subagents: [chatB()], turns: [turnB] }));
    await flush();
    expect(loadB).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const callsBefore = loadB.mock.calls.length;
    view.rerender(surface({ loadTasks: loadB, conversationId: "conversation-2", subagents: [chatB({ status: "completed", isLive: false, sequence: 2 })], turns: [turnB] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(loadB.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

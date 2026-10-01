import { describe, expect, it } from "vitest";

import type { WorkspaceRun } from "../../src/shared/contracts";

import {
  backgroundCommandElapsedMs,
  backgroundCommandStatusLabel,
  backgroundTaskContextUsage,
  backgroundTaskDoingNow,
  backgroundTaskElapsedMs,
  backgroundTaskEmptyNote,
  backgroundTaskGroups,
  backgroundTaskLatestStep,
  backgroundTaskSummaryLabel,
  backgroundTaskTitle,
  backgroundTaskTokens,
  backgroundTaskTokenTotalLabel,
  orderedBackgroundCommands,
} from "../../src/renderer/src/utils/backgroundTasks";
import {
  activeBackgroundTaskCount,
  activeBackgroundTasksLabel,
  backgroundCommandRuns,
} from "../../src/renderer/src/utils/backgroundTaskRuns";
import {
  subagentDisclosureRows,
  subagentTokensLabel,
  subagentHarnessLabel,
  subagentProviderLabel,
} from "../../src/renderer/src/utils/subagentDisclosure";
import {
  taskTrace,
  taskTurn,
  taskUsage,
  workspaceRun,
} from "./background-task-fixtures";

describe("background task rows", () => {
  it("titles a task by provider name, then role, then its mission", () => {
    expect(backgroundTaskTitle(taskTrace({ providerName: "code_reviewer" })))
      .toBe("Code reviewer");
    expect(backgroundTaskTitle(taskTrace({ providerName: null, providerRole: "explorer" })))
      .toBe("Explorer");
    expect(backgroundTaskTitle(taskTrace({
      providerName: null,
      providerRole: null,
      description: "Map the persistence layer",
    }))).toBe("Map the persistence layer");
    expect(backgroundTaskTitle(taskTrace({
      providerId: "cursor",
      providerName: null,
      providerRole: null,
      description: null,
    }))).toBe("Cursor delegated task");
  });

  it("says what a live task is doing now and what a settled task produced", () => {
    expect(backgroundTaskDoingNow(taskTrace({ activity: "Read", progress: "Scanning files" })))
      .toBe("Read");
    expect(backgroundTaskDoingNow(taskTrace({ progress: "Scanning files" })))
      .toBe("Scanning files");
    expect(backgroundTaskDoingNow(taskTrace({
      status: "completed",
      activity: null,
      progress: "Scanning files",
      result: "Found 3 call sites",
    }))).toBe("Found 3 call sites");
    expect(backgroundTaskDoingNow(taskTrace({ status: "completed", result: null }))).toBeNull();
  });

  it("prefers the provider-reported runtime once a task settles", () => {
    const now = Date.parse("2030-01-01T00:01:00.000Z");
    expect(backgroundTaskElapsedMs(taskTrace(), now)).toBe(60_000);
    expect(backgroundTaskElapsedMs(taskTrace({ durationMs: 5_000 }), now)).toBe(60_000);
    expect(backgroundTaskElapsedMs(taskTrace({ status: "completed" }), now)).toBe(30_000);
    expect(backgroundTaskElapsedMs(taskTrace({ status: "completed", durationMs: 12_345 }), now))
      .toBe(12_345);
  });

  it("does not report recovery downtime as the runtime of a lost task", () => {
    const now = Date.parse("2030-01-05T00:00:00.000Z");
    const lost = taskTrace({ status: "lost", isLive: false, updatedAt: "2030-01-04T00:00:00.000Z" });
    expect(backgroundTaskElapsedMs(lost, now)).toBeNull();
    expect(backgroundTaskElapsedMs({ ...lost, durationMs: 7_000 }, now)).toBe(7_000);
    expect(backgroundTaskElapsedMs({ ...lost, status: "failed" }, now)).toBe(3 * 86_400_000);
  });

  it("does not report recovery downtime as the runtime of an interrupted command", () => {
    const now = Date.parse("2030-01-05T00:00:00.000Z");
    expect(backgroundCommandElapsedMs(workspaceRun(), Date.parse("2030-01-01T00:01:10.000Z"))).toBe(60_000);
    expect(backgroundCommandElapsedMs(workspaceRun({
      status: "failed",
      finishedAt: "2030-01-01T00:00:40.000Z",
    }), now)).toBe(30_000);
    expect(backgroundCommandElapsedMs(workspaceRun({
      status: "failed",
      detail: "npm run dev · Interrupted when the local runtime stopped.",
      finishedAt: "2030-01-04T00:00:00.000Z",
    }), now)).toBeNull();
    expect(backgroundCommandElapsedMs(workspaceRun({ status: "succeeded", finishedAt: null }), now)).toBeNull();
  });

  it("formats reported tokens and names the reason when a harness does not report them", () => {
    const turns = [
      taskTurn({ id: "turn-codex", providerId: "codex" }),
      taskTurn({ id: "turn-claude", providerId: "claude" }),
      taskTurn({ id: "turn-cursor", providerId: "cursor" }),
      taskTurn({ id: "turn-opencode", providerId: "opencode" }),
    ];
    expect(backgroundTaskTokens(taskTrace({
      turnId: "turn-codex",
      providerId: "codex",
      usage: taskUsage({ totalTokens: 128_400 }),
    }), turns)).toEqual({ value: 128_400, text: "128.4K", reason: null });
    expect(backgroundTaskTokens(taskTrace({
      turnId: "turn-cursor",
      providerId: "cursor",
      status: "completed",
    }), turns)).toEqual({
      value: null,
      text: "—",
      reason: "Cursor does not report tokens for delegated tasks",
    });
    expect(backgroundTaskTokens(taskTrace({ turnId: "turn-claude" }), turns).reason)
      .toBe("Not reported yet");
    expect(backgroundTaskTokens(taskTrace({
      turnId: "turn-opencode",
      providerId: "opencode",
      status: "failed",
    }), turns).reason).toBe("Not reported for this task");
    expect(backgroundTaskTokens(taskTrace({ turnId: "turn-missing" }), turns).reason)
      .toBe("Not reported");
    expect(backgroundTaskTokens(taskTrace({
      turnId: "turn-claude",
      usage: taskUsage({ totalTokens: 0 }),
    }), turns)).toEqual({ value: 0, text: "0", reason: null });
  });

  it("describes the latest model step only from the fields a provider reported", () => {
    expect(backgroundTaskLatestStep(null)).toBeNull();
    expect(backgroundTaskLatestStep(taskUsage({ totalTokens: 9_000 }))).toBeNull();
    expect(backgroundTaskLatestStep(taskUsage({
      totalTokens: 21_500,
      inputTokens: 18_000,
      cachedInputTokens: 12_000,
      outputTokens: 3_200,
      reasoningOutputTokens: 300,
    }))).toEqual(["Input 18K", "Cached 12K", "Output 3.2K", "Reasoning 300"]);
    expect(backgroundTaskLatestStep(taskUsage({ cacheWriteInputTokens: 1_500 })))
      .toEqual(["Cache write 1.5K"]);
  });

  it("reports the context window remaining like the Usage surface, never rounding to an edge", () => {
    const context = (contextTokens: number, maxContextTokens = 200_000) =>
      backgroundTaskContextUsage(taskUsage({ contextTokens, maxContextTokens }));
    expect(backgroundTaskContextUsage(taskUsage({ contextTokens: 50_000 }))).toBeNull();
    expect(context(50_000, 0)).toBeNull();
    expect(context(50_000)).toEqual({ remainingPercent: 75, label: "75% of 200K remaining" });
    expect(context(799)).toEqual({ remainingPercent: 100, label: ">99% of 200K remaining" });
    expect(context(199_200)).toEqual({ remainingPercent: 0, label: "<1% of 200K remaining" });
    expect(context(0)?.label).toBe("100% of 200K remaining");
    expect(context(200_000)?.label).toBe("0% of 200K remaining");
  });

  it("summarizes agents and commands together without colour-only state", () => {
    expect(backgroundTaskSummaryLabel([], [])).toBe("");
    expect(backgroundTaskSummaryLabel([
      taskTrace({ id: "w", status: "waiting" }),
      taskTrace({ id: "q", status: "queued" }),
      taskTrace({ id: "u", status: "unknown", isLive: false }),
    ], [workspaceRun({ id: "wait", status: "waiting" })])).toBe("3 active · 1 needs review");
    expect(backgroundTaskSummaryLabel([
      taskTrace({ id: "a" }),
      taskTrace({ id: "b", status: "failed" }),
      taskTrace({ id: "c", status: "completed" }),
      taskTrace({ id: "d", status: "cancelled" }),
    ], [
      workspaceRun({ id: "x" }),
      workspaceRun({ id: "y", status: "failed", attentionState: "unseen" }),
      workspaceRun({ id: "z", status: "failed", attentionState: "acknowledged" }),
      workspaceRun({ id: "w", status: "succeeded" }),
    ])).toBe("2 active · 3 need review · 3 finished");
    expect(backgroundTaskSummaryLabel([taskTrace({ status: "lost" })], []))
      .toBe("1 needs review");
  });

  it("totals only the tokens providers reported and says how many tasks reported them", () => {
    expect(backgroundTaskTokenTotalLabel([taskTrace()])).toBeNull();
    expect(backgroundTaskTokenTotalLabel([
      taskTrace({ id: "a", usage: taskUsage({ totalTokens: 100_000 }) }),
      taskTrace({ id: "b", usage: taskUsage({ totalTokens: 28_400 }) }),
    ])).toBe("128.4K tokens reported");
    expect(backgroundTaskTokenTotalLabel([
      taskTrace({ id: "a", usage: taskUsage({ totalTokens: 100_000 }) }),
      taskTrace({ id: "b", usage: taskUsage({ totalTokens: 28_400 }) }),
      taskTrace({ id: "c", usage: taskUsage({ totalTokens: 0 }) }),
      taskTrace({ id: "d" }),
      taskTrace({ id: "e", usage: taskUsage({ inputTokens: 5 }) }),
    ])).toBe("128.4K tokens reported by 3 of 5 agents");
  });

  it("labels a delegated task's reported tokens for the timeline and Goal panel", () => {
    expect(subagentTokensLabel(taskTrace())).toBeNull();
    expect(subagentTokensLabel(taskTrace({ usage: taskUsage({ inputTokens: 4 }) }))).toBeNull();
    expect(subagentTokensLabel(taskTrace({ usage: taskUsage({ totalTokens: 18_600 }) })))
      .toBe("18.6K tokens");
  });

  it("groups live work first, then review, then finished work with relative tree depth", () => {
    const traces = [
      taskTrace({ id: "root", status: "completed", sequence: 1 }),
      taskTrace({ id: "child-live", parentTraceId: "root", sequence: 2 }),
      taskTrace({ id: "grandchild-live", parentTraceId: "child-live", sequence: 3 }),
      taskTrace({ id: "child-failed", parentTraceId: "root", status: "failed", sequence: 4 }),
      taskTrace({ id: "child-done", parentTraceId: "root", status: "completed", sequence: 5 }),
      taskTrace({ id: "other-live", sequence: 6 }),
    ];
    const { active, finished } = backgroundTaskGroups(subagentDisclosureRows(traces, []));
    expect(active.map(({ trace, depth }) => [trace.id, depth])).toEqual([
      ["child-live", 0],
      ["grandchild-live", 1],
      ["other-live", 0],
      ["child-failed", 0],
    ]);
    expect(finished.map(({ trace, depth }) => [trace.id, depth])).toEqual([
      ["root", 0],
      ["child-done", 1],
    ]);
  });

  it("names command states with the same words as agent states", () => {
    const statuses: WorkspaceRun["status"][] = ["running", "waiting", "succeeded", "failed", "cancelled"];
    expect(statuses.map(backgroundCommandStatusLabel)).toEqual(["Running", "Waiting", "Completed", "Failed", "Cancelled"]);
  });

  it("explains what each harness can report when the chat has no tasks", () => {
    expect(backgroundTaskEmptyNote("kimi-acp"))
      .toBe("Kimi Code does not report delegated agents. Commands it starts appear here.");
    expect(backgroundTaskEmptyNote("antigravity-cli"))
      .toBe("Antigravity does not report delegated agents. Commands it starts appear here.");
    expect(backgroundTaskEmptyNote("cursor-acp"))
      .toBe("Cursor reports a delegated task when it finishes.");
    expect(backgroundTaskEmptyNote("codex-app-server")).toBeNull();
    expect(backgroundTaskEmptyNote(null)).toBeNull();
  });

  it("labels Antigravity routes like every other provider", () => {
    const trace = taskTrace({ providerId: "antigravity", providerName: null, providerRole: null });
    expect(subagentProviderLabel(trace)).toBe("Antigravity");
    expect(subagentHarnessLabel(trace, [taskTurn({ providerId: "antigravity" })])).toBe("CLI");
  });
});

describe("background commands", () => {
  const turns = [
    taskTurn({ id: "turn-1", runId: "run-1", requestedAt: "2030-01-01T00:00:00.000Z" }),
    taskTurn({ id: "turn-2", runId: "run-2", requestedAt: "2030-01-01T00:05:00.000Z" }),
  ];

  it("keeps only background work, never the commands a provider ran inside its turn", () => {
    const providerCommands = Array.from({ length: 60 }, (_, index) => workspaceRun({
      id: `provider-${index}`,
      actionId: null,
      kind: index % 2 ? "check" : "service",
      label: index % 2 ? "rg usage src" : "npm run dev",
      status: index === 0 ? "running" : "succeeded",
    }));
    expect(backgroundCommandRuns(providerCommands, "conversation-1", turns)).toEqual([]);
    expect(activeBackgroundTaskCount([], providerCommands, "conversation-1", turns)).toBe(0);
    const gitPush = workspaceRun({ id: "push", kind: "source-control", actionId: null, label: "Push" });
    expect(backgroundCommandRuns([gitPush], "conversation-1", turns)).toEqual([gitPush]);
  });

  it("keeps this chat's commands and app-started reviews but never the agent turn itself", () => {
    const runs = [
      workspaceRun({ id: "run-1", kind: "agent", status: "succeeded" }),
      workspaceRun({ id: "run-2", kind: "agent" }),
      workspaceRun({ id: "review", kind: "agent", actionId: null, label: "Codex · read-only question", startedAt: "2030-01-01T00:06:00.000Z" }),
      workspaceRun({ id: "older-agent", kind: "agent", actionId: null, startedAt: "2029-12-31T23:00:00.000Z" }),
      workspaceRun({ id: "server", kind: "service", port: 5173, startedAt: "2030-01-01T00:02:00.000Z" }),
      workspaceRun({ id: "check-done", status: "succeeded", startedAt: "2030-01-01T00:07:00.000Z" }),
      workspaceRun({ id: "dismissed", status: "failed", attentionState: "dismissed" }),
      workspaceRun({ id: "other-chat", conversationId: "conversation-2" }),
      workspaceRun({ id: "project-wide", conversationId: null }),
    ];
    expect(backgroundCommandRuns(runs, "conversation-1", turns).map(({ id }) => id))
      .toEqual(["review", "server", "check-done"]);
    expect(backgroundCommandRuns(runs, null, turns)).toEqual([]);
    expect(backgroundCommandRuns(
      [workspaceRun({ id: "review", kind: "agent" })],
      "conversation-1",
      [],
    )).toEqual([]);
  });

  it("orders live commands first, newest first within each state", () => {
    const runs = [
      workspaceRun({ id: "done-new", status: "succeeded", startedAt: "2030-01-01T00:09:00.000Z" }),
      workspaceRun({ id: "live-old", startedAt: "2030-01-01T00:01:00.000Z" }),
      workspaceRun({ id: "waiting", status: "waiting", startedAt: "2030-01-01T00:03:00.000Z" }),
      workspaceRun({ id: "done-old", status: "cancelled", startedAt: "2030-01-01T00:02:00.000Z" }),
    ];
    expect(orderedBackgroundCommands(runs).map(({ id }) => id))
      .toEqual(["waiting", "live-old", "done-new", "done-old"]);
    expect(runs.map(({ id }) => id)).toEqual(["done-new", "live-old", "waiting", "done-old"]);
  });

  it("counts exactly the active rows the panel shows for the badges", () => {
    const subagents = [
      taskTrace({ id: "a" }),
      taskTrace({ id: "b", status: "completed" }),
      taskTrace({ id: "c", status: "waiting" }),
    ];
    const runs = [
      workspaceRun({ id: "x" }),
      workspaceRun({ id: "y", status: "succeeded" }),
      workspaceRun({ id: "z", actionId: null }),
      workspaceRun({ id: "other", conversationId: "conversation-2" }),
    ];
    expect(activeBackgroundTaskCount(subagents, runs, "conversation-1", turns)).toBe(3);
    expect(activeBackgroundTasksLabel(1)).toBe("1 background task active");
    expect(activeBackgroundTasksLabel(3)).toBe("3 background tasks active");
  });
});

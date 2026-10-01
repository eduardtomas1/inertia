import { describe, expect, it } from "vitest";

import {
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
} from "../../src/renderer/src/utils/backgroundTasks";
import {
  backgroundCommandRuns,
  runningBackgroundTaskCount,
  runningBackgroundTasksLabel,
} from "../../src/renderer/src/utils/backgroundTaskRuns";
import {
  subagentDisclosureRows,
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
    }))).toBe("Input 18K · Cached 12K · Output 3.2K · Reasoning 300");
    expect(backgroundTaskLatestStep(taskUsage({ cacheWriteInputTokens: 1_500 })))
      .toBe("Cache write 1.5K");
  });

  it("reports the context window only when the provider reports its size", () => {
    expect(backgroundTaskContextUsage(taskUsage({ contextTokens: 50_000 }))).toBeNull();
    expect(backgroundTaskContextUsage(taskUsage({ contextTokens: 50_000, maxContextTokens: 0 })))
      .toBeNull();
    expect(backgroundTaskContextUsage(taskUsage({
      contextTokens: 50_000,
      maxContextTokens: 200_000,
    }))).toEqual({ percent: 25, label: "25% of 200K used" });
    expect(backgroundTaskContextUsage(taskUsage({
      contextTokens: 1,
      maxContextTokens: 400_000,
    }))?.percent).toBe(0);
  });

  it("summarizes agents and commands together without colour-only state", () => {
    expect(backgroundTaskSummaryLabel([], [])).toBe("");
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
    ])).toBe("2 running · 2 need review · 4 finished");
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
    ])).toBe("128.4K tokens reported by 3 of 5 tasks");
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

  it("keeps this chat's commands and app-started reviews but never the agent turn itself", () => {
    const runs = [
      workspaceRun({ id: "run-1", kind: "agent", status: "succeeded" }),
      workspaceRun({ id: "run-2", kind: "agent" }),
      workspaceRun({ id: "review", kind: "agent", label: "Codex · read-only question", startedAt: "2030-01-01T00:06:00.000Z" }),
      workspaceRun({ id: "older-agent", kind: "agent", startedAt: "2029-12-31T23:00:00.000Z" }),
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
    expect(backgroundCommandRuns(runs, "conversation-1", turns).map(({ id }) => id))
      .toEqual(["waiting", "live-old", "done-new", "done-old"]);
  });

  it("counts live agents and live commands for the panel badges", () => {
    const subagents = [
      taskTrace({ id: "a" }),
      taskTrace({ id: "b", status: "completed" }),
      taskTrace({ id: "c", status: "waiting" }),
    ];
    const commands = [
      workspaceRun({ id: "x" }),
      workspaceRun({ id: "y", status: "succeeded" }),
    ];
    expect(runningBackgroundTaskCount(subagents, commands)).toBe(3);
    expect(runningBackgroundTasksLabel(1)).toBe("1 background task running");
    expect(runningBackgroundTasksLabel(3)).toBe("3 background tasks running");
  });
});

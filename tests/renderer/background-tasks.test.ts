import { describe, expect, it } from "vitest";

import {
  backgroundCommandElapsedMs,
  backgroundCommandStateWord,
  backgroundTaskContextLeft,
  backgroundTaskCurrentActivity,
  backgroundTaskDoingNow,
  backgroundTaskElapsedMs,
  backgroundTaskItems,
  backgroundTaskLatestStep,
  backgroundTaskStateWord,
  backgroundTaskTitle,
  backgroundTaskTokensNotReported,
  backgroundTaskTranscriptMeta,
} from "../../src/renderer/src/utils/backgroundTasks";
import {
  activeBackgroundTaskCount,
  activeBackgroundTasksLabel,
  backgroundCommandRuns,
} from "../../src/renderer/src/utils/backgroundTaskRuns";
import {
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
      .toBe("Scanning files");
    expect(backgroundTaskDoingNow(taskTrace({
      activity: "Searching src/server for usage parsers",
      progress: "Mapping the token usage pipeline",
    }))).toBe("Searching src/server for usage parsers");
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

  it("never shows a stale tool label while a live task waits or is queued", () => {
    for (const status of ["waiting", "queued"] as const) {
      expect(backgroundTaskDoingNow(taskTrace({ status, activity: "Edit fixture.ts", progress: null })))
        .toBeNull();
      expect(backgroundTaskDoingNow(taskTrace({ status, activity: "Edit fixture.ts", progress: "Waiting for review" })))
        .toBe("Waiting for review");
    }
    expect(backgroundTaskDoingNow(taskTrace({ status: "spawned", activity: "Read" }))).toBe("Read");
    expect(backgroundTaskCurrentActivity(taskTrace({ status: "waiting", activity: "Edit fixture.ts" }))).toBeNull();
    expect(backgroundTaskCurrentActivity(taskTrace({ status: "running", activity: "Edit fixture.ts" })))
      .toBe("Edit fixture.ts");
    expect(backgroundTaskCurrentActivity(taskTrace({ status: "completed", activity: "Edit fixture.ts" })))
      .toBeNull();
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
      backgroundTaskContextLeft(taskUsage({ contextTokens, maxContextTokens }));
    expect(backgroundTaskContextLeft(null)).toBeNull();
    expect(backgroundTaskContextLeft(taskUsage({ contextTokens: 50_000 }))).toBeNull();
    expect(context(50_000, 0)).toBeNull();
    expect(context(50_000)).toBe("75% context left");
    expect(context(799)).toBe(">99% context left");
    expect(context(199_200)).toBe("<1% context left");
    expect(context(0)).toBe("100% context left");
    expect(context(200_000)).toBe("0% context left");
  });

  it("sums up the latest step and context in one compact transcript line", () => {
    const turns = [
      taskTurn({ id: "turn-cursor", providerId: "cursor" }),
      taskTurn({ id: "turn-codex", providerId: "codex" }),
    ];
    expect(backgroundTaskTranscriptMeta(taskTrace({
      turnId: "turn-codex",
      usage: taskUsage({
        totalTokens: 128_400,
        inputTokens: 18_200,
        cachedInputTokens: 12_800,
        outputTokens: 1_900,
        reasoningOutputTokens: 640,
        contextTokens: 50_000,
        maxContextTokens: 200_000,
      }),
    }), turns)).toBe("Input 18.2K · Cached 12.8K · Output 1.9K · Reasoning 640 · 75% context left");
    expect(backgroundTaskTranscriptMeta(taskTrace({
      turnId: "turn-codex",
      usage: taskUsage({ contextTokens: 50_000, maxContextTokens: 200_000 }),
    }), turns)).toBe("75% context left");
    expect(backgroundTaskTranscriptMeta(taskTrace({
      turnId: "turn-codex",
      usage: taskUsage({ totalTokens: 9_000 }),
    }), turns)).toBeNull();
    expect(backgroundTaskTranscriptMeta(taskTrace({ turnId: "turn-cursor", providerId: "cursor" }), turns))
      .toBe("Tokens not reported by Cursor");
  });

  it("labels a delegated task's reported tokens for the timeline and Goal panel", () => {
    expect(subagentTokensLabel(taskTrace())).toBeNull();
    expect(subagentTokensLabel(taskTrace({ usage: taskUsage({ inputTokens: 4 }) }))).toBeNull();
    expect(subagentTokensLabel(taskTrace({ usage: taskUsage({ totalTokens: 18_600 }) })))
      .toBe("18.6K tokens");
  });

  it("names only the states that need a word, and marks failures as dangerous", () => {
    expect(backgroundTaskStateWord(taskTrace({ status: "running" }))).toBeNull();
    expect(backgroundTaskStateWord(taskTrace({ status: "completed" }))).toBeNull();
    expect(backgroundTaskStateWord(taskTrace({ status: "waiting" }))).toEqual({ word: "Waiting", danger: false });
    expect(backgroundTaskStateWord(taskTrace({ status: "queued" }))).toEqual({ word: "Queued", danger: false });
    expect(backgroundTaskStateWord(taskTrace({ status: "spawned" }))).toEqual({ word: "Starting", danger: false });
    expect(backgroundTaskStateWord(taskTrace({ status: "cancelled" }))).toEqual({ word: "Stopped", danger: false });
    expect(backgroundTaskStateWord(taskTrace({ status: "failed" }))).toEqual({ word: "Failed", danger: true });
    expect(backgroundTaskStateWord(taskTrace({ status: "lost", isLive: false }))).toEqual({ word: "Lost", danger: true });
    expect(backgroundTaskStateWord(taskTrace({ status: "interrupted" }))).toEqual({ word: "Interrupted", danger: true });
    expect(backgroundCommandStateWord(workspaceRun())).toBeNull();
    expect(backgroundCommandStateWord(workspaceRun({ status: "succeeded" }))).toBeNull();
    expect(backgroundCommandStateWord(workspaceRun({ status: "waiting" }))).toEqual({ word: "Waiting", danger: false });
    expect(backgroundCommandStateWord(workspaceRun({ status: "cancelled" }))).toEqual({ word: "Stopped", danger: false });
    expect(backgroundCommandStateWord(workspaceRun({ status: "failed" }))).toEqual({ word: "Failed", danger: true });
  });

  it("says a harness does not report tokens only when it never does", () => {
    const turns = [
      taskTurn({ id: "turn-cursor", providerId: "cursor" }),
      taskTurn({ id: "turn-claude", providerId: "claude" }),
    ];
    expect(backgroundTaskTokensNotReported(taskTrace({ turnId: "turn-cursor", providerId: "cursor" }), turns))
      .toBe("Tokens not reported by Cursor");
    expect(backgroundTaskTokensNotReported(taskTrace({ turnId: "turn-claude" }), turns)).toBeNull();
    expect(backgroundTaskTokensNotReported(taskTrace({
      turnId: "turn-cursor",
      providerId: "cursor",
      usage: taskUsage({ totalTokens: 5 }),
    }), turns)).toBeNull();
    expect(backgroundTaskTokensNotReported(taskTrace({ turnId: "turn-missing" }), turns)).toBeNull();
  });

  it("lists running work in a stable creation order and finished work newest first", () => {
    const traces = [
      taskTrace({ id: "b", createdAt: "2030-01-01T00:00:01.000Z", sequence: 9 }),
      taskTrace({ id: "a", createdAt: "2030-01-01T00:00:01.000Z", sequence: 1 }),
      taskTrace({ id: "early", createdAt: "2030-01-01T00:00:00.000Z" }),
      taskTrace({ id: "done", status: "completed", createdAt: "2030-01-01T00:00:02.000Z" }),
      taskTrace({ id: "failed", status: "failed", createdAt: "2030-01-01T00:00:05.000Z" }),
      taskTrace({ id: "lost", status: "lost", isLive: false, createdAt: "2030-01-01T00:00:03.000Z" }),
    ];
    const commands = [
      workspaceRun({ id: "dev", startedAt: "2030-01-01T00:00:02.000Z" }),
      workspaceRun({ id: "lint", status: "failed", startedAt: "2030-01-01T00:00:04.000Z" }),
      workspaceRun({ id: "build", status: "succeeded", startedAt: "2030-01-01T00:00:06.000Z" }),
    ];
    const items = backgroundTaskItems(traces, commands);
    expect(items.active.map(({ key }) => key))
      .toEqual(["agent:early", "agent:a", "agent:b", "command:dev"]);
    expect(items.finished.map(({ key }) => key))
      .toEqual(["command:build", "agent:failed", "command:lint", "agent:lost", "agent:done"]);
    expect(items.failed).toBe(3);
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
      workspaceRun({ id: "older-agent", kind: "agent", actionId: null, status: "succeeded", startedAt: "2029-12-31T23:00:00.000Z" }),
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
    const olderLiveReview = workspaceRun({ id: "older-review", kind: "agent", actionId: null, startedAt: "2029-12-31T23:00:00.000Z" });
    expect(activeBackgroundTaskCount(subagents, [...runs, olderLiveReview], "conversation-1", turns)).toBe(4);
    expect(activeBackgroundTaskCount([], [olderLiveReview], "conversation-1", [])).toBe(0);
    expect(activeBackgroundTasksLabel(1)).toBe("1 background task active");
    expect(activeBackgroundTasksLabel(3)).toBe("3 background tasks active");
  });
});

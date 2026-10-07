import { describe, expect, it } from "vitest";

import {
  groupWorkThreads,
  hasUnreadCompletion,
  nextSidebarNavigationIndex,
  sidebarThreadView,
  sidebarThreadViewMap,
  sortActivityThreads,
  sortSidebarThreadViews,
} from "../../src/renderer/src/utils/sidebarModel";
import type { Conversation, WorkspaceRun } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

function conversation(overrides: Partial<Conversation> & Pick<Conversation, "id" | "projectId">): Conversation {
  return {
    title: overrides.id,
    providerId: "codex",
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: "2026-07-20T10:00:00.000Z",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
    modelSelection: overrides.modelSelection
      ?? providerNativeModelSelection({ providerId: overrides.providerId ?? "codex" }),
    continuationIdentity: overrides.continuationIdentity ?? null,
  };
}

function workspaceRun(
  conversationId: string,
  overrides: Partial<WorkspaceRun> = {},
): WorkspaceRun {
  return {
    id: `run-${conversationId}`,
    kind: "agent",
    projectId: "p",
    conversationId,
    actionId: null,
    label: conversationId,
    detail: null,
    status: "succeeded",
    attentionState: "acknowledged",
    canStop: false,
    port: null,
    startedAt: "2026-07-22T10:00:00.000Z",
    finishedAt: "2026-07-22T10:01:00.000Z",
    ...overrides,
  };
}

describe("work-first chat model", () => {
  it("projects and groups a 1,000-chat catalog within the renderer budget", () => {
    const conversations = Array.from({ length: 1_000 }, (_, index) =>
      conversation({
        id: `catalog-${String(index).padStart(4, "0")}`,
        projectId: `project-${index % 20}`,
        status: index % 13 === 0 ? "running" : "idle",
        updatedAt: new Date(Date.UTC(2026, 6, 20, 10, 0, index))
          .toISOString(),
      }));
    const runs = conversations.map((entry, index) => workspaceRun(entry.id, {
      status: index % 13 === 0 ? "running" : "succeeded",
      finishedAt: index % 13 === 0
        ? null
        : "2026-07-22T10:01:00.000Z",
    }));
    const startedAt = performance.now();
    const views = sidebarThreadViewMap(conversations, null, runs);
    const sorted = sortSidebarThreadViews([...views.values()]);
    const sections = groupWorkThreads(sorted);
    const elapsed = performance.now() - startedAt;

    expect(views.size).toBe(1_000);
    expect(sections.flatMap(({ threads }) => threads)).toHaveLength(1_000);
    expect(elapsed).toBeLessThan(500);
  });

  it("distinguishes every visible state and prioritizes actionable work", () => {
    const entries = [
      conversation({ id: "idle", projectId: "p" }),
      conversation({ id: "completed", projectId: "p", status: "completed", completedAt: "2026-07-22T12:00:00.000Z" }),
      conversation({ id: "failed", projectId: "p", status: "failed" }),
      conversation({ id: "working", projectId: "p", status: "running" }),
      conversation({ id: "input", projectId: "p", status: "needs-input", attentionKind: "input" }),
      conversation({ id: "approval", projectId: "p", status: "needs-input", attentionKind: "approval" }),
    ];
    expect(entries.map((entry) => sidebarThreadView(entry, null).status)).toEqual([
      "idle",
      "completed",
      "failed",
      "working",
      "input",
      "approval",
    ]);
    expect(sortActivityThreads(entries, null).map(({ conversation: entry }) => entry.id)).toEqual([
      "approval",
      "input",
      "failed",
      "working",
      "completed",
      "idle",
    ]);
    const today = new Date(2026, 6, 20, 12).getTime();
    expect(groupWorkThreads(sortActivityThreads(entries, null), today).map(({ id, threads }) => ({
      id,
      threads: threads.map(({ conversation: entry }) => entry.id),
    }))).toEqual([
      { id: "recent", threads: ["approval", "input", "failed", "working", "completed", "idle"] },
      { id: "yesterday", threads: [] },
      { id: "earlier", threads: [] },
      { id: "done", threads: [] },
      { id: "snoozed", threads: [] },
    ]);
  });

  it("keeps mixed-provider working chats stable while activity timestamps change", () => {
    const entries = [
      conversation({
        id: "codex-working",
        projectId: "p",
        providerId: "codex",
        status: "running",
        createdAt: "2026-07-23T08:00:00.000Z",
        updatedAt: "2026-07-23T12:00:00.000Z",
      }),
      conversation({
        id: "claude-working",
        projectId: "p",
        providerId: "claude",
        status: "running",
        createdAt: "2026-07-23T08:01:00.000Z",
        updatedAt: "2026-07-23T12:01:00.000Z",
      }),
      conversation({
        id: "opencode-working",
        projectId: "p",
        providerId: "opencode",
        status: "running",
        createdAt: "2026-07-23T08:02:00.000Z",
        updatedAt: "2026-07-23T12:02:00.000Z",
      }),
    ];
    const runs = [
      workspaceRun("codex-working", {
        status: "running",
        startedAt: "2026-07-23T09:00:00.000Z",
        finishedAt: null,
      }),
      workspaceRun("claude-working", {
        status: "running",
        startedAt: "2026-07-23T10:00:00.000Z",
        finishedAt: null,
      }),
      workspaceRun("opencode-working", {
        status: "running",
        startedAt: "2026-07-23T11:00:00.000Z",
        finishedAt: null,
      }),
    ];
    const orderedIds = (
      conversations: readonly Conversation[],
      workspaceRuns: readonly WorkspaceRun[],
    ) => sortActivityThreads(conversations, null, workspaceRuns)
      .map(({ conversation: entry }) => entry.id);

    expect(orderedIds(entries, runs)).toEqual([
      "opencode-working",
      "claude-working",
      "codex-working",
    ]);

    const noisyActivityUpdates = entries.map((entry, index) => ({
      ...entry,
      updatedAt: [
        "2026-07-23T15:00:00.000Z",
        "2026-07-23T14:00:00.000Z",
        "2026-07-23T13:00:00.000Z",
      ][index]!,
    }));
    expect(orderedIds(noisyActivityUpdates, runs)).toEqual([
      "opencode-working",
      "claude-working",
      "codex-working",
    ]);

    const cursor = conversation({
      id: "cursor-working",
      projectId: "p",
      providerId: "cursor",
      status: "running",
      createdAt: "2026-07-23T08:03:00.000Z",
      updatedAt: "2026-07-23T12:03:00.000Z",
    });
    const cursorRun = workspaceRun(cursor.id, {
      status: "running",
      startedAt: "2026-07-23T12:00:00.000Z",
      finishedAt: null,
    });
    expect(orderedIds([...noisyActivityUpdates, cursor], [...runs, cursorRun]))
      .toEqual([
        "cursor-working",
        "opencode-working",
        "claude-working",
        "codex-working",
      ]);

    const meaningfulConversationChanges = [
      noisyActivityUpdates[0]!,
      {
        ...noisyActivityUpdates[1]!,
        status: "needs-input" as const,
        attentionKind: "approval" as const,
      },
      noisyActivityUpdates[2]!,
      cursor,
    ];
    const meaningfulRunChanges = [
      runs[0]!,
      {
        ...runs[1]!,
        status: "waiting" as const,
      },
      {
        ...runs[2]!,
        status: "succeeded" as const,
        attentionState: "acknowledged" as const,
        finishedAt: "2026-07-23T11:30:00.000Z",
      },
      cursorRun,
    ];
    expect(orderedIds(meaningfulConversationChanges, meaningfulRunChanges))
      .toEqual([
        "claude-working",
        "cursor-working",
        "codex-working",
        "opencode-working",
      ]);
  });

  it("uses shell creation time and conversation id for working chats without a run", () => {
    const entries = [
      conversation({
        id: "alpha",
        projectId: "p",
        status: "running",
        createdAt: "2026-07-23T09:00:00.000Z",
        updatedAt: "2026-07-23T15:00:00.000Z",
      }),
      conversation({
        id: "gamma",
        projectId: "p",
        status: "running",
        createdAt: "2026-07-23T10:00:00.000Z",
        updatedAt: "2026-07-23T14:00:00.000Z",
      }),
      conversation({
        id: "beta",
        projectId: "p",
        status: "running",
        createdAt: "2026-07-23T10:00:00.000Z",
        updatedAt: "2026-07-23T13:00:00.000Z",
      }),
    ];

    expect(sortActivityThreads(entries, null).map(({ conversation: entry }) => (
      entry.id
    ))).toEqual(["beta", "gamma", "alpha"]);
  });

  it("groups calm work by local day while keeping stale urgent work visible", () => {
    const now = new Date(2026, 7, 11, 12).getTime();
    const entries = [
      conversation({
        id: "today",
        projectId: "p",
        updatedAt: new Date(2026, 7, 11, 9).toISOString(),
      }),
      conversation({
        id: "yesterday",
        projectId: "p",
        updatedAt: new Date(2026, 7, 10, 17).toISOString(),
      }),
      conversation({
        id: "earlier",
        projectId: "p",
        updatedAt: new Date(2026, 7, 7, 17).toISOString(),
      }),
      conversation({
        id: "stale-running",
        projectId: "p",
        status: "running",
        updatedAt: new Date(2026, 7, 5, 17).toISOString(),
      }),
      conversation({
        id: "done",
        projectId: "p",
        settledAt: new Date(2026, 7, 9, 17).toISOString(),
        updatedAt: new Date(2026, 7, 9, 17).toISOString(),
      }),
    ];

    expect(groupWorkThreads(sortActivityThreads(entries, null), now).map((section) => ({
      id: section.id,
      threads: section.threads.map(({ conversation: entry }) => entry.id),
    }))).toEqual([
      { id: "recent", threads: ["stale-running", "today"] },
      { id: "yesterday", threads: ["yesterday"] },
      { id: "earlier", threads: ["earlier"] },
      { id: "done", threads: ["done"] },
      { id: "snoozed", threads: [] },
    ]);
  });

  it("groups ordinary snoozed work separately while keeping actionable snoozed work visible", () => {
    const now = new Date(2026, 7, 11, 12).getTime();
    const snoozedUntil = new Date(2026, 7, 12, 12).toISOString();
    const entries = [
      conversation({ id: "idle", projectId: "p", snoozedUntil }),
      conversation({
        id: "done",
        projectId: "p",
        settledAt: new Date(2026, 7, 10, 12).toISOString(),
        snoozedUntil,
      }),
      conversation({ id: "working", projectId: "p", status: "running", snoozedUntil }),
      conversation({
        id: "approval",
        projectId: "p",
        status: "needs-input",
        attentionKind: "approval",
        snoozedUntil,
      }),
      conversation({
        id: "dismissed",
        projectId: "p",
        settledAt: new Date(2026, 7, 10, 12).toISOString(),
        snoozedUntil,
      }),
    ];
    const runs = [workspaceRun("dismissed", {
      status: "failed",
      attentionState: "dismissed",
    })];

    expect(groupWorkThreads(sortActivityThreads(entries, null, runs), now).map((section) => ({
      id: section.id,
      threads: section.threads.map(({ conversation: entry }) => entry.id),
    }))).toEqual([
      { id: "recent", threads: ["approval", "working"] },
      { id: "yesterday", threads: [] },
      { id: "earlier", threads: [] },
      { id: "done", threads: [] },
      { id: "snoozed", threads: ["idle", "dismissed", "done"] },
    ]);
    expect(groupWorkThreads(
      sortActivityThreads(entries, null, runs),
      Date.parse(snoozedUntil) + 1,
    ).flatMap(({ threads }) => threads.map(({ conversation: entry }) => entry.id)))
      .not.toContain("dismissed");
  });

  it("keeps actionable work above pins and pins above ordinary recency", () => {
    const entries = [
      conversation({
        id: "newer",
        projectId: "p",
        updatedAt: "2026-07-23T12:00:00.000Z",
      }),
      conversation({
        id: "pinned",
        projectId: "p",
        pinnedAt: "2026-07-23T09:00:00.000Z",
        updatedAt: "2026-07-23T09:00:00.000Z",
      }),
      conversation({
        id: "approval",
        projectId: "p",
        status: "needs-input",
        attentionKind: "approval",
      }),
    ];

    expect(sortActivityThreads(entries, null).map(({ conversation: entry }) => (
      entry.id
    ))).toEqual(["approval", "pinned", "newer"]);
  });

  it("tracks unseen completions without marking legacy, active, or visited work unread", () => {
    const completed = conversation({
      id: "done",
      projectId: "p",
      status: "completed",
      completedAt: "2026-07-22T12:00:00.000Z",
      lastViewedAt: "2026-07-22T11:00:00.000Z",
    });
    expect(hasUnreadCompletion(completed, null)).toBe(true);
    expect(hasUnreadCompletion(completed, completed.id)).toBe(false);
    expect(hasUnreadCompletion({ ...completed, lastViewedAt: completed.completedAt }, null)).toBe(false);
    expect(hasUnreadCompletion({ ...completed, completedAt: null }, null)).toBe(false);
  });

  it("joins Work to the persisted workspace-run attention state", () => {
    const entries = ["failed", "acknowledged", "completed", "dismissed", "working"]
      .map((id) => conversation({ id, projectId: "p" }));
    const runs = [
      workspaceRun("failed", { status: "failed", attentionState: "seen" }),
      workspaceRun("acknowledged", { status: "failed", attentionState: "acknowledged" }),
      workspaceRun("completed", { attentionState: "unseen" }),
      workspaceRun("dismissed", { status: "failed", attentionState: "dismissed" }),
      workspaceRun("working", {
        status: "running",
        attentionState: "acknowledged",
        finishedAt: null,
      }),
    ];
    const threads = sortActivityThreads(entries, null, runs);

    expect(sidebarThreadView(entries[2]!, entries[2]!.id, runs)).toMatchObject({
      status: "completed",
      unread: true,
      needsAttention: false,
    });
    const today = new Date(2026, 6, 20, 12).getTime();
    expect(groupWorkThreads(threads, today).map(({ id, threads: sectionThreads }) => ({
      id,
      threads: sectionThreads.map(({ conversation: entry }) => entry.id),
    }))).toEqual([
      { id: "recent", threads: ["failed", "working", "acknowledged", "completed"] },
      { id: "yesterday", threads: [] },
      { id: "earlier", threads: [] },
      { id: "done", threads: [] },
      { id: "snoozed", threads: [] },
    ]);
  });

  it("provides wrapping Arrow and bounded Home/End keyboard navigation", () => {
    expect(nextSidebarNavigationIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextSidebarNavigationIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextSidebarNavigationIndex(1, "Home", 3)).toBe(0);
    expect(nextSidebarNavigationIndex(1, "End", 3)).toBe(2);
    expect(nextSidebarNavigationIndex(-1, "ArrowDown", 0)).toBe(-1);
  });
});

describe("usage-limited work", () => {
  it("shows a chat stopped by a usage limit as Limited rather than Failed", () => {
    const failed = conversation({ id: "limited", projectId: "p", status: "failed" });
    const turn = (usageLimited?: boolean) => ({ ...failed, latestTurn: { id: "turn", status: "failed" as const, ...(usageLimited === undefined ? {} : { usageLimited }) } });
    expect(sidebarThreadView(turn(true), null)).toMatchObject({ status: "limited", needsAttention: true });
    expect(sidebarThreadView(turn(), null).status).toBe("failed");
    expect(sidebarThreadView({ ...turn(true), status: "running" }, null).status).toBe("working");
  });
});

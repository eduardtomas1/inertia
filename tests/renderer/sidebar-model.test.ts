import { describe, expect, it } from "vitest";

import {
  buildLogicalProjectGroups,
  classicSidebarSearch,
  groupWorkThreads,
  hasUnreadCompletion,
  logicalProjectKey,
  nextSidebarNavigationIndex,
  sidebarThreadView,
  sidebarThreadViewMap,
  sortActivityThreads,
  sortSidebarThreadViews,
} from "../../src/renderer/src/utils/sidebarModel";
import type { Conversation, Project, WorkspaceRun } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

function project(overrides: Partial<Project> & Pick<Project, "id" | "name" | "path">): Project {
  return {
    normalizedPath: overrides.path,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 128,
    color: "#000",
    status: "ready",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

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
      ?? nativeModelSelection({ providerId: overrides.providerId ?? "codex" }),
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

describe("sidebar logical project grouping", () => {
  it("groups only matching canonical Git identities and honors repository-relative scope", () => {
    const root = project({
      id: "one",
      name: "Same display name",
      path: "/work/repo",
      normalizedPath: "/work/repo",
      repositoryIdentity: "git:/work/repo/.git",
      repositoryRoot: "/work/repo",
    });
    const packageProject = project({
      id: "two",
      name: "Package",
      path: "/work/repo/packages/app",
      normalizedPath: "/work/repo/packages/app",
      repositoryIdentity: "git:/work/repo/.git",
      repositoryRoot: "/work/repo",
      repositoryRelativePath: "packages/app",
    });
    const unrelated = project({
      id: "three",
      name: "Same display name",
      path: "/other/repo",
      normalizedPath: "/other/repo",
      repositoryIdentity: "git:/other/repo/.git",
      repositoryRoot: "/other/repo",
    });

    expect(buildLogicalProjectGroups([root, packageProject, unrelated], "repository").map(({ projects }) => projects.map(({ id }) => id).sort())).toEqual([
      ["three"],
      ["one", "two"],
    ]);
    expect(buildLogicalProjectGroups([root, packageProject, unrelated], "repository-path")).toHaveLength(3);
    expect(logicalProjectKey(root, "repository")).not.toBe(logicalProjectKey(unrelated, "repository"));
  });

  it("keeps non-Git projects and explicit per-project overrides safely separate", () => {
    const first = project({ id: "one", name: "Shared", path: "/one", normalizedPath: "/one" });
    const second = project({ id: "two", name: "Shared", path: "/two", normalizedPath: "/two" });
    const sameRepository = project({
      id: "three",
      name: "Third",
      path: "/repo/sub",
      normalizedPath: "/repo/sub",
      repositoryIdentity: "git:/repo/.git",
      repositoryRoot: "/repo",
      repositoryRelativePath: "sub",
      groupingMode: "separate",
    });
    const repositoryRoot = project({
      id: "four",
      name: "Fourth",
      path: "/repo",
      normalizedPath: "/repo",
      repositoryIdentity: "git:/repo/.git",
      repositoryRoot: "/repo",
    });

    expect(buildLogicalProjectGroups([first, second], "repository")).toHaveLength(2);
    expect(buildLogicalProjectGroups([sameRepository, repositoryRoot], "repository")).toHaveLength(2);
  });
});

describe("classic sidebar search", () => {
  const first = project({
    id: "one",
    name: "Inertia",
    path: "/work/inertia",
  });
  const second = project({
    id: "two",
    name: "Openbravo",
    path: "/work/openbravo",
  });
  const activeMatch = conversation({
    id: "active-match",
    projectId: first.id,
    title: "Fix provider routing",
    updatedAt: "2026-07-23T10:00:00.000Z",
  });
  const activeSibling = conversation({
    id: "active-sibling",
    projectId: first.id,
    title: "Unrelated work",
    updatedAt: "2026-07-23T11:00:00.000Z",
  });
  const archivedMatch = conversation({
    id: "archived-match",
    projectId: second.id,
    title: "Fix provider routing",
    archivedAt: "2026-07-23T12:00:00.000Z",
  });

  it("shows only the matching active chat for a chat-only match", () => {
    const result = classicSidebarSearch(
      [first, second],
      [activeMatch, activeSibling, archivedMatch],
      "provider",
    );

    expect(result.projects.map(({ id }) => id)).toEqual([first.id]);
    expect(
      result.conversationsByProject.get(first.id)?.map(({ id }) => id),
    ).toEqual([activeMatch.id]);
  });

  it("shows every active chat for a project match and never renders archived chats", () => {
    const result = classicSidebarSearch(
      [first, second],
      [activeMatch, activeSibling, archivedMatch],
      "inertia",
    );

    expect(result.projects.map(({ id }) => id)).toEqual([first.id]);
    expect(
      result.conversationsByProject.get(first.id)?.map(({ id }) => id),
    ).toEqual([activeSibling.id, activeMatch.id]);
    expect(
      [...result.conversationsByProject.values()].flat()
        .some(({ id }) => id === archivedMatch.id),
    ).toBe(false);
  });

  it("does not let an archived chat create a false-positive project match", () => {
    const result = classicSidebarSearch(
      [first, second],
      [activeMatch, activeSibling, archivedMatch],
      "provider",
    );

    expect(result.projects.some(({ id }) => id === second.id)).toBe(false);
  });
});

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
    expect(groupWorkThreads(sortActivityThreads(entries, null)).map(({ id, threads }) => ({
      id,
      threads: threads.map(({ conversation: entry }) => entry.id),
    }))).toEqual([
      { id: "needs-you", threads: ["approval", "input", "failed"] },
      { id: "in-progress", threads: ["working"] },
      { id: "recent", threads: ["completed", "idle"] },
    ]);
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

  it("joins Work to the same persisted run attention state used by Runs", () => {
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
    expect(groupWorkThreads(threads).map(({ id, threads: sectionThreads }) => ({
      id,
      threads: sectionThreads.map(({ conversation: entry }) => entry.id),
    }))).toEqual([
      { id: "needs-you", threads: ["failed"] },
      { id: "in-progress", threads: ["working"] },
      { id: "recent", threads: ["acknowledged", "completed"] },
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

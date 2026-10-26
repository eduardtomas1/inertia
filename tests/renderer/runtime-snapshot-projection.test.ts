import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ConversationShell,
  type WorkspaceRun,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { applyConversationShellEvent, applyTodosEvent } from "../../src/renderer/src/utils/runtimeSnapshotProjection";
import type { Todo } from "../../src/shared/todos";

function conversation(id: string, updatedAt: string): ConversationShell {
  return {
    id,
    projectId: `${id}-project`,
    title: `Conversation ${id}`,
    providerId: "codex",
    modelSelection: providerNativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    model: "default",
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: updatedAt,
    completedAt: updatedAt,
    lastViewedAt: updatedAt,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  };
}

function run(
  id: string,
  conversationId: string,
  startedAt: string,
): WorkspaceRun {
  return {
    id,
    kind: "agent",
    projectId: `${conversationId}-project`,
    conversationId,
    actionId: null,
    label: `Run ${id}`,
    detail: null,
    status: "running",
    attentionState: "unseen",
    canStop: true,
    port: null,
    startedAt,
    finishedAt: null,
  };
}

describe("bounded conversation shell projection", () => {
  it("replaces only the affected conversation and its owned runs", () => {
    const primary = conversation("primary", "2026-07-30T10:00:00.000Z");
    const secondary = conversation("secondary", "2026-07-30T10:01:00.000Z");
    const secondaryRun = run(
      "secondary-run",
      secondary.id,
      "2026-07-30T10:01:00.000Z",
    );
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [secondary, primary],
      runs: [
        secondaryRun,
        run("old-primary-run", primary.id, "2026-07-30T10:00:00.000Z"),
      ],
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: primary.projectId,
      activeConversationId: primary.id,
    };
    const updatedPrimary = {
      ...primary,
      status: "running" as const,
      updatedAt: "2026-07-30T10:02:00.000Z",
    };
    const nextRun = run(
      "new-primary-run",
      primary.id,
      "2026-07-30T10:02:00.000Z",
    );

    const next = applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: updatedPrimary,
      runs: [nextRun],
    });

    expect(next).not.toBe(snapshot);
    expect(next.projects).toBe(snapshot.projects);
    expect(next.providers).toBe(snapshot.providers);
    expect(next.conversations).toEqual([updatedPrimary, secondary]);
    expect(next.conversations[1]).toBe(secondary);
    expect(next.runs).toEqual([nextRun, secondaryRun]);
    expect(next.runs[1]).toBe(secondaryRun);
  });

  it("keeps the global shell run projection bounded", () => {
    const primary = conversation("primary", "2026-07-30T10:00:00.000Z");
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [primary],
      runs: Array.from({ length: 200 }, (_, index) =>
        run(
          `background-${index}`,
          `background-${index}`,
          new Date(Date.parse("2026-07-30T09:00:00.000Z") + index).toISOString(),
        )),
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: primary.projectId,
      activeConversationId: primary.id,
    };

    const next = applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: primary,
      runs: [run("latest", primary.id, "2026-07-30T11:00:00.000Z")],
    });

    expect(next.runs).toHaveLength(200);
    expect(next.runs[0]?.id).toBe("latest");
  });

  it("returns the same snapshot when a shell event changes nothing", () => {
    const primary = conversation("primary", "2026-07-30T10:00:00.000Z");
    const secondary = conversation("secondary", "2026-07-30T10:01:00.000Z");
    const primaryRuns = [
      run("primary-new", primary.id, "2026-07-30T10:02:00.000Z"),
      run("primary-old", primary.id, "2026-07-30T10:00:00.000Z"),
    ];
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [secondary, primary],
      runs: [
        primaryRuns[0]!,
        run("secondary-run", secondary.id, "2026-07-30T10:01:00.000Z"),
        primaryRuns[1]!,
      ],
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: primary.projectId,
      activeConversationId: primary.id,
    };
    const reordered = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;

    const next = applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: reordered(structuredClone(primary)),
      runs: structuredClone([...primaryRuns].reverse()).map(reordered),
    });

    expect(next).toBe(snapshot);
  });

  it("projects a shell event that changes one nested field or run", () => {
    const primary = conversation("primary", "2026-07-30T10:00:00.000Z");
    const primaryRun = run("primary-run", primary.id, "2026-07-30T10:00:00.000Z");
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [primary],
      runs: [primaryRun],
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: primary.projectId,
      activeConversationId: primary.id,
    };
    const event = (
      conversationValue: ConversationShell,
      runs: WorkspaceRun[],
    ) => applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: conversationValue,
      runs,
    });

    expect(event({
      ...primary,
      modelSelection: { ...primary.modelSelection, modelId: "other" },
    }, [primaryRun])).not.toBe(snapshot);
    expect(event(primary, [{ ...primaryRun, label: "Renamed" }]))
      .not.toBe(snapshot);
    expect(event(primary, [])).not.toBe(snapshot);
    expect(event(primary, [primaryRun, run("extra", primary.id, "2026-07-30T09:00:00.000Z")]))
      .not.toBe(snapshot);
    expect(event({ ...primary, pendingApproval: true }, [primaryRun]))
      .not.toBe(snapshot);
  });

  it("keeps unchanged conversation and run identities when a command run starts", () => {
    const primary = conversation("primary", "2026-07-30T10:00:00.000Z");
    const secondary = conversation("secondary", "2026-07-30T10:01:00.000Z");
    const primaryRun = run("primary-run", primary.id, "2026-07-30T10:00:00.000Z");
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [secondary, primary],
      runs: [primaryRun],
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: primary.projectId,
      activeConversationId: primary.id,
    };
    const command: WorkspaceRun = {
      ...run("command", primary.id, "2026-07-30T10:00:30.000Z"),
      kind: "check",
    };

    const next = applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: structuredClone(primary),
      runs: [command, structuredClone(primaryRun)],
    });

    expect(next).not.toBe(snapshot);
    expect(next.conversations).toBe(snapshot.conversations);
    expect(next.runs).toEqual([command, primaryRun]);
    expect(next.runs[1]).toBe(primaryRun);
  });
});

describe("task list projection", () => {
  const task: Todo = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Clean the downloads folder",
    note: "",
    priority: null,
    dueDate: null,
    dueTime: null,
    projectId: null,
    completedAt: null,
    conversationId: null,
    linkedAt: null,
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
  };
  const snapshot: AppSnapshot = {
    projects: [],
    conversations: [conversation("primary", "2026-07-30T10:00:00.000Z")],
    runs: [],
    providers: [],
    settings: { ...defaultSettings },
    activeProjectId: null,
    activeConversationId: null,
    todos: [task],
  };

  it("replaces the tasks and keeps every other collection", () => {
    const done = { ...task, completedAt: "2026-10-21T11:00:00.000Z" };
    const next = applyTodosEvent(snapshot, { type: "todos.updated", todos: [done] });
    expect(next.todos).toEqual([done]);
    expect(next.conversations).toBe(snapshot.conversations);
    expect(applyTodosEvent({ ...snapshot, todos: undefined }, { type: "todos.updated", todos: [] }).todos).toEqual([]);
  });

  it("keeps the snapshot identity when the tasks did not change", () => {
    expect(applyTodosEvent(snapshot, { type: "todos.updated", todos: [{ ...task }] })).toBe(snapshot);
  });
});

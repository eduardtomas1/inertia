import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMultiSpawn } from "../../src/renderer/src/hooks/useMultiSpawn";
import {
  useAsyncOperationQueue,
  useAuthoritativeConversationCreateQueue,
  useWorkspaceAuthorityCommandQueue,
} from "../../src/renderer/src/hooks/useConversationSelectionQueue";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { MultiSpawnDraft } from "../../src/renderer/src/utils/multiSpawn";
import type { AppSnapshot, Project, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const projectIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;
const conversationIds = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const;
const turnIds = [
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
] as const;
const comparisonConversationId = "77777777-7777-4777-8777-777777777777";
const now = "2026-08-08T12:00:00.000Z";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/workspace/${name.toLowerCase()}`,
    normalizedPath: `/workspace/${name.toLowerCase()}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#777777",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
}

const settings = {
  ...defaultSettings,
  defaultProvider: "codex" as const,
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
};
const snapshot: AppSnapshot = {
  projects: [project(projectIds[0], "Alpha"), project(projectIds[1], "Beta")],
  conversations: [],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  settings,
  activeProjectId: projectIds[0],
  activeConversationId: null,
};

function draft(): MultiSpawnDraft {
  const selection = providerNativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  return {
    prompt: "Compare these two results.",
    rememberPreset: false,
    sides: [
      { projectId: projectIds[0], title: "Alpha", selection, accessMode: "supervised", interactionMode: "build" },
      { projectId: projectIds[1], title: "Beta", selection, accessMode: "supervised", interactionMode: "build" },
    ],
    comparison: {
      enabled: true,
      side: { projectId: projectIds[0], title: "Judge", selection, accessMode: "supervised", interactionMode: "plan" },
    },
  };
}

function runtime(): (key: string, command: CommandWithoutId) => Promise<ServerEvent> {
  return vi.fn(async (_key: string, command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "duo.pending") {
      return { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "duo.pending", launchIds: [], hasMore: false } };
    }
    if (command.type === "duo.prepare") {
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.prepared",
          launchId: command.payload.launchId,
          state: "prepared",
          sides: [
            { ordinal: 0, conversationId: conversationIds[0], turnId: turnIds[0] },
            { ordinal: 1, conversationId: conversationIds[1], turnId: turnIds[1] },
          ],
          comparison: { conversationId: comparisonConversationId },
        },
      };
    }
    if (command.type === "duo.dispatch") {
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId: command.payload.launchId,
          state: "running",
          error: null,
          sides: [
            { ordinal: 0, conversationId: conversationIds[0], turnId: turnIds[0], dispatchState: "started" },
            { ordinal: 1, conversationId: conversationIds[1], turnId: turnIds[1], dispatchState: "started" },
          ],
          comparison: {
            state: "completed",
            conversationId: comparisonConversationId,
            turnId: "88888888-8888-4888-8888-888888888888",
            attempt: 1,
            error: null,
          },
        },
      };
    }
    return { type: "request.ok", requestId: crypto.randomUUID() };
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("Duo comparison navigation", () => {
  it.each([
    {
      label: "conversation",
      selection: {
        type: "conversation.select" as const,
        payload: { conversationId: conversationIds[1] },
      },
      published: {
        ...snapshot,
        activeConversationId: conversationIds[1],
      },
      unrelated: {
        ...snapshot,
        activeConversationId: conversationIds[0],
      },
      createProjectId: projectIds[0],
    },
    {
      label: "project",
      selection: {
        type: "project.select" as const,
        payload: { projectId: projectIds[1] },
      },
      published: {
        ...snapshot,
        activeProjectId: projectIds[1],
      },
      unrelated: {
        ...snapshot,
        activeProjectId: projectIds[0],
      },
      createProjectId: projectIds[1],
    },
  ])("releases an authoritative $label selection without hiding its delayed rejection", async ({
    selection,
    published,
    unrelated,
    createProjectId,
  }) => {
    const usesSyncCursor = selection.type === "conversation.select";
    const syncAtDispatch = {
      runtimeGeneration: "runtime-selection-queue",
      latestSequence: 7,
    };
    let currentSnapshot: AppSnapshot = usesSyncCursor
      ? { ...snapshot, sync: syncAtDispatch }
      : snapshot;
    let rejectSelection!: (error: Error) => void;
    const delayedFailure = new Error("Selection settlement failed.");
    const run = vi.fn((
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (run.mock.calls.length === 1) {
        expect(command).toEqual(selection);
        return new Promise<ServerEvent>((_resolve, reject) => {
          rejectSelection = reject;
        });
      }
      expect(command.type).toBe("conversation.create");
      return Promise.resolve({
        type: "request.ok",
        requestId: crypto.randomUUID(),
      });
    });
    const hook = renderHook(() => {
      const enqueue = useAsyncOperationQueue();
      return {
        create: useAuthoritativeConversationCreateQueue(
          run,
          currentSnapshot,
          enqueue,
        ),
        select: useWorkspaceAuthorityCommandQueue(
          run,
          currentSnapshot,
          enqueue,
        ),
      };
    });

    let selected!: Promise<ServerEvent>;
    let created!: Promise<void>;
    await act(async () => {
      selected = hook.result.current.select("selection", selection);
      created = hook.result.current.create("conversation.create", {
        type: "conversation.create",
        payload: { projectId: createProjectId, title: "After selection" },
      });
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    let selectionSettled = false;
    void selected.then(
      () => { selectionSettled = true; },
      () => { selectionSettled = true; },
    );

    currentSnapshot = usesSyncCursor
      ? { ...published, sync: syncAtDispatch }
      : unrelated;
    hook.rerender();
    await act(async () => Promise.resolve());
    expect(run).toHaveBeenCalledTimes(1);

    currentSnapshot = usesSyncCursor
      ? {
        ...published,
        sync: { ...syncAtDispatch, latestSequence: syncAtDispatch.latestSequence + 1 },
      }
      : published;
    hook.rerender();
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await expect(created).resolves.toBeUndefined();
    expect(selectionSettled).toBe(false);

    rejectSelection(delayedFailure);
    await expect(selected).rejects.toBe(delayedFailure);
  });

  it("does not strand legacy work behind a delayed re-selection of the active conversation", async () => {
    let rejectSelection!: (error: Error) => void;
    const delayedFailure = new Error("Repeated selection settlement failed.");
    const run = vi.fn((
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "conversation.select") {
        return new Promise<ServerEvent>((_resolve, reject) => {
          rejectSelection = reject;
        });
      }
      expect(command.type).toBe("conversation.create");
      return Promise.resolve({
        type: "request.ok",
        requestId: crypto.randomUUID(),
      });
    });
    const hook = renderHook(() => {
      const enqueue = useAsyncOperationQueue();
      return {
        create: useAuthoritativeConversationCreateQueue(run, snapshot, enqueue),
        select: useWorkspaceAuthorityCommandQueue(run, snapshot, enqueue),
      };
    });

    let selected!: Promise<ServerEvent>;
    let created!: Promise<void>;
    await act(async () => {
      selected = hook.result.current.select("selection", {
        type: "conversation.select",
        payload: { conversationId: snapshot.activeConversationId! },
      });
      created = hook.result.current.create("conversation.create", {
        type: "conversation.create",
        payload: { projectId: projectIds[0], title: "After repeated selection" },
      });
    });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await expect(created).resolves.toBeUndefined();
    rejectSelection(delayedFailure);
    await expect(selected).rejects.toBe(delayedFailure);
  });

  it("releases a published create into the shared workspace-authority order", async () => {
    const createdConversationId = "88888888-8888-4888-8888-888888888888";
    let currentSnapshot = snapshot;
    let settleFirstCreate!: (event: ServerEvent) => void;
    const operations: string[] = [];
    const run = vi.fn((
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      operations.push(command.type);
      if (run.mock.calls.length === 1) {
        return new Promise<ServerEvent>((resolve) => {
          settleFirstCreate = resolve;
        });
      }
      if (command.type === "conversation.select") {
        return Promise.resolve({ type: "request.ok", requestId: crypto.randomUUID() });
      }
      expect(command.type).toBe("conversation.create");
      return Promise.resolve({ type: "request.ok", requestId: crypto.randomUUID() });
    });
    const hook = renderHook(() => {
      const enqueue = useAsyncOperationQueue();
      return {
        create: useAuthoritativeConversationCreateQueue(
          run,
          currentSnapshot,
          enqueue,
        ),
        select: (conversationId: string) => enqueue(() => run("conversation.select", {
          type: "conversation.select",
          payload: { conversationId },
        })),
      };
    });
    const create = (title: string) => hook.result.current.create("conversation.create", {
      type: "conversation.create",
      payload: { projectId: projectIds[0], title },
    });

    let first!: Promise<void>;
    let selection!: Promise<ServerEvent>;
    let second!: Promise<void>;
    await act(async () => {
      first = create("First new chat");
      selection = hook.result.current.select(conversationIds[1]);
      second = create("Second new chat");
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    currentSnapshot = {
      ...snapshot,
      activeConversationId: createdConversationId,
      conversations: [{
        id: createdConversationId,
        projectId: projectIds[0],
      }] as AppSnapshot["conversations"],
    };
    hook.rerender();

    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(operations).toEqual([
      "conversation.create",
      "conversation.select",
      "conversation.create",
    ]);
    await expect(first).resolves.toBeUndefined();
    await expect(selection).resolves.toMatchObject({ type: "request.ok" });
    await expect(second).resolves.toBeUndefined();
    settleFirstCreate({ type: "request.ok", requestId: crypto.randomUUID() });
  });
  it("polls a live comparison without entering the foreground action runner", async () => {
    vi.useFakeTimers();
    const baseRuntime = runtime();
    let launchId = "";
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      const event = await baseRuntime(key, command);
      if (
        command.type !== "duo.dispatch"
        || event.type !== "request.result"
        || event.result.kind !== "duo.status"
      ) return event;
      launchId = command.payload.launchId;
      return {
        ...event,
        result: {
          ...event.result,
          comparison: {
            state: "waiting",
            conversationId: comparisonConversationId,
            turnId: null,
            attempt: 0,
            error: null,
          },
        },
      };
    });
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      expect(command).toEqual({
        type: "duo.status",
        payload: { launchId },
      });
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: "running",
          error: null,
          sides: [
            { ordinal: 0, conversationId: conversationIds[0], turnId: turnIds[0], dispatchState: "started" },
            { ordinal: 1, conversationId: conversationIds[1], turnId: turnIds[1], dispatchState: "started" },
          ],
          comparison: {
            state: "completed",
            conversationId: comparisonConversationId,
            turnId: "88888888-8888-4888-8888-888888888888",
            attempt: 1,
            error: null,
          },
        },
      };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      request,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.submit(draft()));
    expect(hook.result.current.open).toBe(false);
    expect(hook.result.current.launchBlocked).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(request).toHaveBeenCalledTimes(1);
    expect(hook.result.current.open).toBe(false);
    expect(hook.result.current.launchBlocked).toBe(false);
    expect(run.mock.calls.some(([, command]) => command.type === "duo.status"))
      .toBe(false);
  });

  it("leaves the user on the launched pair when the verdict lands", async () => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const focusWorkspace = vi.fn();
    const run = runtime();
    const hook = renderHook(() => useMultiSpawn({
      snapshot: currentSnapshot,
      settings,
      run,
      request: (command) => run("multi-spawn:background", command),
      splitConversationId,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId,
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace,
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.submit(draft()));
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    expect(vi.mocked(run).mock.calls.some(([, command]) =>
      command.type === "conversation.select"
      && command.payload.conversationId === comparisonConversationId)).toBe(false);
    expect(updateSplitConversationId).toHaveBeenLastCalledWith(conversationIds[1]);
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
    expect(hook.result.current.judgeNotices.comparisonForConversation(conversationIds[0]))
      .toMatchObject({ role: "side", comparison: { state: "completed" } });
  });

  it.each([
    { split: conversationIds[1], closesSplit: true },
    { split: "99999999-9999-4999-8999-999999999999", closesSplit: false },
  ])("opens the judge on request and closes the split only when it holds a source: $closesSplit", async ({ split, closesSplit }) => {
    let splitConversationId: string | null = null;
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const transitions = { current: 0 };
    const focusWorkspace = vi.fn();
    const run = runtime();
    const hook = renderHook(() => useMultiSpawn({
      snapshot: { ...snapshot, activeConversationId: conversationIds[0] },
      settings,
      run,
      request: (command) => run("multi-spawn:background", command),
      splitConversationId,
      splitSelectionTransitionsRef: transitions,
      updateSplitConversationId,
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace,
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));
    await act(async () => hook.result.current.submit(draft()));
    splitConversationId = split;
    hook.rerender();
    updateSplitConversationId.mockClear();

    await act(async () => hook.result.current.judgeNotices.openJudge(comparisonConversationId));

    await waitFor(() => expect(focusWorkspace).toHaveBeenCalledTimes(2));
    expect(vi.mocked(run).mock.calls.at(-1)?.[1]).toEqual({
      type: "conversation.select",
      payload: { conversationId: comparisonConversationId },
    });
    if (closesSplit) expect(updateSplitConversationId).toHaveBeenCalledWith(null);
    else expect(updateSplitConversationId).not.toHaveBeenCalled();
    expect(transitions.current).toBe(0);
  });
});

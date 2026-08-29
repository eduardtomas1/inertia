import { useCallback } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMultiSpawn } from "../../src/renderer/src/hooks/useMultiSpawn";
import {
  useAsyncOperationQueue,
  useAuthoritativeConversationCreateQueue,
  useConversationSelectionQueue,
  useRuntimeCommandQueue,
} from "../../src/renderer/src/hooks/useConversationSelectionQueue";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { MultiSpawnDraft } from "../../src/renderer/src/utils/multiSpawn";
import type { AppSnapshot, Project, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

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
  const selection = nativeModelSelection({
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

  it.each([
    { navigatedAway: false, shouldOpen: true },
    { navigatedAway: true, shouldOpen: false },
  ])("opens the judge only when the user stayed on the launched pair: $shouldOpen", async ({ navigatedAway, shouldOpen }) => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    const generation = { current: 4 };
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
      conversationSelectionGenerationRef: generation,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId,
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace,
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.submit(draft()));
    if (navigatedAway) generation.current += 1;
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await act(async () => Promise.resolve());

    const selectedJudge = vi.mocked(run).mock.calls.some(([, command]) =>
      command.type === "conversation.select"
      && command.payload.conversationId === comparisonConversationId);
    if (shouldOpen) {
      await waitFor(() => expect(vi.mocked(run).mock.calls.some(([, command]) =>
        command.type === "conversation.select"
        && command.payload.conversationId === comparisonConversationId)).toBe(true));
      expect(updateSplitConversationId).toHaveBeenLastCalledWith(null);
      expect(focusWorkspace).toHaveBeenCalledTimes(2);
    } else {
      expect(selectedJudge).toBe(false);
      expect(updateSplitConversationId).not.toHaveBeenCalledWith(null);
    }
  });

  it("keeps a newer user selection authoritative when judge selection is pending", async () => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    const generation = { current: 2 };
    let finishJudgeSelection: (() => void) | null = null;
    let activeConversationId: string | null = conversationIds[0];
    const userConversationId = "99999999-9999-4999-8999-999999999999";
    const baseRuntime = runtime();
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (
        command.type === "conversation.select"
        && command.payload.conversationId === comparisonConversationId
      ) {
        await new Promise<void>((resolve) => {
          finishJudgeSelection = resolve;
        });
      }
      const event = await baseRuntime(key, command);
      if (command.type === "conversation.select") {
        activeConversationId = command.payload.conversationId;
      }
      return event;
    });
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const focusWorkspace = vi.fn();
    const hook = renderHook(() => {
      const selectConversationCommand = useConversationSelectionQueue(run);
      return {
        selectConversationCommand,
        multiSpawn: useMultiSpawn({
          snapshot: currentSnapshot,
          settings,
          run,
          request: (command) => run("multi-spawn:background", command),
          selectConversationCommand,
          splitConversationId,
          conversationSelectionGenerationRef: generation,
          splitSelectionTransitionsRef: { current: 0 },
          updateSplitConversationId,
          showWorkspace: vi.fn(),
          closeSidebar: vi.fn(),
          focusWorkspace,
          discardDraftConversation: vi.fn(),
          setActionError: vi.fn(),
        }),
      };
    });

    await act(async () => hook.result.current.multiSpawn.submit(draft()));
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await waitFor(() => expect(finishJudgeSelection).not.toBeNull());

    generation.current += 1;
    const userSelection = hook.result.current.selectConversationCommand(
      "conversation.select",
      userConversationId,
    );
    await act(async () => finishJudgeSelection?.());
    await act(async () => userSelection);

    expect(activeConversationId).toBe(userConversationId);
    expect(updateSplitConversationId).not.toHaveBeenCalledWith(null);
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
  });

  it("restores the source chat after split-only navigation during judge selection", async () => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    const generation = { current: 5 };
    let finishJudgeSelection: (() => void) | null = null;
    let activeConversationId: string | null = conversationIds[0];
    const baseRuntime = runtime();
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (
        command.type === "conversation.select"
        && command.payload.conversationId === comparisonConversationId
      ) {
        await new Promise<void>((resolve) => {
          finishJudgeSelection = resolve;
        });
      }
      const event = await baseRuntime(key, command);
      if (command.type === "conversation.select") {
        activeConversationId = command.payload.conversationId;
      }
      return event;
    });
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const focusWorkspace = vi.fn();
    const hook = renderHook(() => {
      const selectConversationCommand = useConversationSelectionQueue(run);
      return useMultiSpawn({
        snapshot: currentSnapshot,
        settings,
        run,
        request: (command) => run("multi-spawn:background", command),
        selectConversationCommand,
        splitConversationId,
        conversationSelectionGenerationRef: generation,
        splitSelectionTransitionsRef: { current: 0 },
        updateSplitConversationId,
        showWorkspace: vi.fn(),
        closeSidebar: vi.fn(),
        focusWorkspace,
        discardDraftConversation: vi.fn(),
        setActionError: vi.fn(),
      });
    });

    await act(async () => hook.result.current.submit(draft()));
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await waitFor(() => expect(finishJudgeSelection).not.toBeNull());

    splitConversationId = null;
    hook.rerender();
    await act(async () => finishJudgeSelection?.());

    await waitFor(() => expect(activeConversationId).toBe(conversationIds[0]));
    expect(vi.mocked(run).mock.calls
      .filter(([, command]) => command.type === "conversation.select")
      .map(([, command]) => command.type === "conversation.select"
        ? command.payload.conversationId
        : null))
      .toEqual([
        conversationIds[0],
        comparisonConversationId,
        conversationIds[0],
      ]);
    expect(updateSplitConversationId).not.toHaveBeenCalledWith(null);
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
  });

  it("queues activating chat creation after a pending judge handoff", async () => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    const generation = { current: 9 };
    const createdConversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let finishJudgeSelection: (() => void) | null = null;
    let activeConversationId: string | null = conversationIds[0];
    const baseRuntime = runtime();
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (
        command.type === "conversation.select"
        && command.payload.conversationId === comparisonConversationId
      ) {
        await new Promise<void>((resolve) => {
          finishJudgeSelection = resolve;
        });
      }
      const event = await baseRuntime(key, command);
      if (command.type === "conversation.select") {
        activeConversationId = command.payload.conversationId;
      } else if (command.type === "conversation.create") {
        activeConversationId = createdConversationId;
      }
      return event;
    });
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const hook = renderHook(() => {
      const commandQueue = useRuntimeCommandQueue(run);
      const selectConversationCommand = useCallback((
        key: string,
        conversationId: string,
      ) => commandQueue(key, {
        type: "conversation.select",
        payload: { conversationId },
      }), [commandQueue]);
      return {
        commandQueue,
        multiSpawn: useMultiSpawn({
          snapshot: currentSnapshot,
          settings,
          run,
          request: (command) => run("multi-spawn:background", command),
          selectConversationCommand,
          splitConversationId,
          conversationSelectionGenerationRef: generation,
          splitSelectionTransitionsRef: { current: 0 },
          updateSplitConversationId,
          showWorkspace: vi.fn(),
          closeSidebar: vi.fn(),
          focusWorkspace: vi.fn(),
          discardDraftConversation: vi.fn(),
          setActionError: vi.fn(),
        }),
      };
    });

    await act(async () => hook.result.current.multiSpawn.submit(draft()));
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await waitFor(() => expect(finishJudgeSelection).not.toBeNull());

    generation.current += 1;
    const creation = hook.result.current.commandQueue("conversation.create", {
      type: "conversation.create",
      payload: {
        projectId: projectIds[0],
        title: "New chat",
      },
    });
    await act(async () => finishJudgeSelection?.());
    await act(async () => creation);

    expect(activeConversationId).toBe(createdConversationId);
    expect(vi.mocked(run).mock.calls
      .filter(([, command]) => (
        command.type === "conversation.select"
        || command.type === "conversation.create"
      ))
      .map(([, command]) => command.type === "conversation.select"
        ? command.payload.conversationId
        : "conversation.create"))
      .toEqual([
        conversationIds[0],
        comparisonConversationId,
        "conversation.create",
      ]);
    expect(updateSplitConversationId).not.toHaveBeenCalledWith(null);
  });

  it("queues an activating source send after a pending judge handoff", async () => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    const generation = { current: 9 };
    let finishJudgeSelection: (() => void) | null = null;
    let activeConversationId: string | null = conversationIds[0];
    const operations: string[] = [];
    const baseRuntime = runtime();
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (
        command.type === "conversation.select"
        && command.payload.conversationId === comparisonConversationId
      ) {
        await new Promise<void>((resolve) => {
          finishJudgeSelection = resolve;
        });
      }
      const event = await baseRuntime(key, command);
      if (command.type === "conversation.select") {
        activeConversationId = command.payload.conversationId;
        operations.push(`select:${command.payload.conversationId}`);
      }
      return event;
    });
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const hook = renderHook(() => {
      const enqueue = useAsyncOperationQueue();
      const selectConversationCommand = useCallback((
        key: string,
        conversationId: string,
      ) => enqueue(() => run(key, {
        type: "conversation.select",
        payload: { conversationId },
      })), [enqueue]);
      return {
        sendSourceMessage: () => {
          generation.current += 1;
          return enqueue(async () => {
            activeConversationId = conversationIds[0];
            operations.push(`send:${conversationIds[0]}`);
          });
        },
        multiSpawn: useMultiSpawn({
          snapshot: currentSnapshot,
          settings,
          run,
          request: (command) => run("multi-spawn:background", command),
          selectConversationCommand,
          splitConversationId,
          conversationSelectionGenerationRef: generation,
          splitSelectionTransitionsRef: { current: 0 },
          updateSplitConversationId,
          showWorkspace: vi.fn(),
          closeSidebar: vi.fn(),
          focusWorkspace: vi.fn(),
          discardDraftConversation: vi.fn(),
          setActionError: vi.fn(),
        }),
      };
    });

    await act(async () => hook.result.current.multiSpawn.submit(draft()));
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await waitFor(() => expect(finishJudgeSelection).not.toBeNull());

    const send = hook.result.current.sendSourceMessage();
    await act(async () => finishJudgeSelection?.());
    await act(async () => send);

    expect(activeConversationId).toBe(conversationIds[0]);
    expect(operations.slice(-2)).toEqual([
      `select:${comparisonConversationId}`,
      `send:${conversationIds[0]}`,
    ]);
    expect(updateSplitConversationId).not.toHaveBeenCalledWith(null);
  });

  it("restores the source chat when Settings opens during judge selection", async () => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    let workspaceVisible = true;
    const generation = { current: 7 };
    let finishJudgeSelection: (() => void) | null = null;
    let activeConversationId: string | null = conversationIds[0];
    const baseRuntime = runtime();
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (
        command.type === "conversation.select"
        && command.payload.conversationId === comparisonConversationId
      ) {
        await new Promise<void>((resolve) => {
          finishJudgeSelection = resolve;
        });
      }
      const event = await baseRuntime(key, command);
      if (command.type === "conversation.select") {
        activeConversationId = command.payload.conversationId;
      }
      return event;
    });
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const focusWorkspace = vi.fn();
    const hook = renderHook(() => {
      const selectConversationCommand = useConversationSelectionQueue(run);
      return useMultiSpawn({
        snapshot: currentSnapshot,
        settings,
        run,
        request: (command) => run("multi-spawn:background", command),
        selectConversationCommand,
        workspaceVisible,
        splitConversationId,
        conversationSelectionGenerationRef: generation,
        splitSelectionTransitionsRef: { current: 0 },
        updateSplitConversationId,
        showWorkspace: vi.fn(),
        closeSidebar: vi.fn(),
        focusWorkspace,
        discardDraftConversation: vi.fn(),
        setActionError: vi.fn(),
      });
    });

    await act(async () => hook.result.current.submit(draft()));
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await waitFor(() => expect(finishJudgeSelection).not.toBeNull());

    workspaceVisible = false;
    generation.current += 1;
    hook.rerender();
    await act(async () => finishJudgeSelection?.());

    await waitFor(() => expect(activeConversationId).toBe(conversationIds[0]));
    expect(vi.mocked(run).mock.calls
      .filter(([, command]) => command.type === "conversation.select")
      .map(([, command]) => command.type === "conversation.select"
        ? command.payload.conversationId
        : null))
      .toEqual([
        conversationIds[0],
        comparisonConversationId,
        conversationIds[0],
      ]);
    expect(updateSplitConversationId).not.toHaveBeenCalledWith(null);
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
  });
});

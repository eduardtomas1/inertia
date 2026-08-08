import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMultiSpawn } from "../../src/renderer/src/hooks/useMultiSpawn";
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

describe("Duo comparison navigation", () => {
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

  it("does not collapse the split when navigation changes during judge selection", async () => {
    let currentSnapshot = snapshot;
    let splitConversationId: string | null = null;
    const generation = { current: 2 };
    let finishJudgeSelection: (() => void) | null = null;
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
      return baseRuntime(key, command);
    });
    const updateSplitConversationId = vi.fn((next: string | null) => {
      splitConversationId = next;
    });
    const focusWorkspace = vi.fn();
    const hook = renderHook(() => useMultiSpawn({
      snapshot: currentSnapshot,
      settings,
      run,
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
    currentSnapshot = { ...snapshot, activeConversationId: conversationIds[0] };
    hook.rerender();
    await waitFor(() => expect(finishJudgeSelection).not.toBeNull());

    generation.current += 1;
    await act(async () => finishJudgeSelection?.());

    expect(updateSplitConversationId).not.toHaveBeenCalledWith(null);
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
  });
});

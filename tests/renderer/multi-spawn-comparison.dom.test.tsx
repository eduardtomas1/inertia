import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MultiSpawnDialog } from "../../src/renderer/src/components/MultiSpawnDialog";
import { useMultiSpawn } from "../../src/renderer/src/hooks/useMultiSpawn";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import {
  readPendingMultiSpawnLaunchId,
  type MultiSpawnDraft,
  writePendingMultiSpawnLaunchId,
} from "../../src/renderer/src/utils/multiSpawn";
import {
  type AppSnapshot,
  defaultSettings,
  type Project,
  type ProviderInfo,
  type ServerEvent,
} from "../../src/shared/contracts";

function pendingLaunchesEvent(launchIds: string[] = []): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: { kind: "duo.pending", launchIds, hasMore: false },
  };
}

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";
const firstConversationId = "33333333-3333-4333-8333-333333333333";
const secondConversationId = "44444444-4444-4444-8444-444444444444";
const comparisonConversationId = "77777777-7777-4777-8777-777777777777";
const firstTurnId = "55555555-5555-4555-8555-555555555555";
const secondTurnId = "66666666-6666-4666-8666-666666666666";
const now = "2026-08-08T10:00:00.000Z";

function project(id: string, name: string): Project {
  const path = `/workspace/${name.toLocaleLowerCase("en-US")}`;
  return {
    id,
    name,
    path,
    normalizedPath: path,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6366f1",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
}

const provider: ProviderInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
  installState: "installed",
  authState: "authenticated",
  canRun: true,
  statusMessage: null,
  models: [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Test model",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [{
      value: "high",
      label: "High",
      description: "Deep reasoning",
    }],
    defaultReasoningEffort: "high",
  }],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "fresh",
      provenance: "provider",
      updatedAt: now,
      lastAttemptedAt: now,
      refreshing: false,
    },
    rateLimits: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
  },
};

const settings = {
  ...defaultSettings,
  defaultProvider: "codex" as const,
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
};
const snapshot: AppSnapshot = {
  projects: [
    project(firstProjectId, "Inertia"),
    project(secondProjectId, "Companion"),
  ],
  conversations: [],
  providers: [provider],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  settings,
  activeProjectId: firstProjectId,
  activeConversationId: null,
};

describe("Duo third-model comparison dialog", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("makes the lock explicit and collects an independent judge route", async () => {
    const onSubmit = vi.fn(async (_draft: MultiSpawnDraft) => undefined);
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", {
      name: "Compare with a third model",
    }));
    expect(screen.getAllByText("GPT-5.6-Sol")).toHaveLength(3);
    const judgeConfiguration = screen.getByText("Configure judge")
      .closest("details");
    expect(judgeConfiguration).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Configure judge"));
    expect(judgeConfiguration).toHaveAttribute("open");
    const sharingDetails = screen.getByText("What is shared with the judge?")
      .closest("details");
    expect(sharingDetails).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("What is shared with the judge?"));
    expect(screen.getByText(/up to 5,500 characters/u)).toBeVisible();
    expect(screen.getByText(/no source session, reasoning, tool history/u))
      .toBeVisible();
    fireEvent.change(screen.getByLabelText("Comparison chat project"), {
      target: { value: secondProjectId },
    });
    fireEvent.change(screen.getByLabelText("Chat 2 project"), {
      target: { value: secondProjectId },
    });
    fireEvent.change(screen.getByLabelText("Comparison chat access"), {
      target: { value: "full" },
    });
    expect(screen.getByText("Judge can edit a source checkout")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Audit the lifecycle." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch duo" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      comparison: {
        enabled: true,
        side: {
          projectId: secondProjectId,
          title: "Duo comparison",
          accessMode: "full",
          interactionMode: "plan",
        },
      },
    });
  });

  it("shows explicit retry and lock-release actions for a failed judge", () => {
    const onRetryComparison = vi.fn(async () => undefined);
    const onCancelComparison = vi.fn(async () => undefined);
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error="The judge turn failed."
        recoveryStatus={{
          launchId: crypto.randomUUID(),
          state: "running",
          error: null,
          sides: [
            {
              ordinal: 0,
              conversationId: firstConversationId,
              turnId: firstTurnId,
              dispatchState: "started",
            },
            {
              ordinal: 1,
              conversationId: secondConversationId,
              turnId: secondTurnId,
              dispatchState: "started",
            },
          ],
          comparison: {
            state: "failed",
            conversationId: comparisonConversationId,
            turnId: crypto.randomUUID(),
            attempt: 1,
            error: "The judge turn failed.",
          },
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onRetryComparison={onRetryComparison}
        onCancelComparison={onCancelComparison}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", {
      name: "Third-model comparison status",
    })).toHaveTextContent("explicit retry available");
    fireEvent.click(screen.getByRole("button", {
      name: "Retry judge explicitly",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "Cancel comparison and release lock",
    }));
    expect(onRetryComparison).toHaveBeenCalledTimes(1);
    expect(onCancelComparison).toHaveBeenCalledTimes(1);
  });

  it("disables only Launch while a waiting comparison holds the lock", async () => {
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        launchBlocked
        error="The third-model comparison is still waiting."
        recoveryStatus={{
          launchId: crypto.randomUUID(),
          state: "running",
          error: null,
          sides: [
            { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
            { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
          ],
          comparison: {
            state: "waiting",
            conversationId: comparisonConversationId,
            turnId: null,
            attempt: 0,
            error: null,
          },
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onCancelComparison={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Launch duo" }))
      .toBeDisabled();
    expect(screen.getByRole("button", {
      name: "Cancel comparison and release lock",
    })).toBeEnabled();
  });

  it("blocks a new launch while a running cancellation finishes cleanup", async () => {
    vi.useFakeTimers();
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac";
    let statusReads = 0;
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type !== "duo.status") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      statusReads += 1;
      const cancellationFinished = statusReads > 1;
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: cancellationFinished ? "cancelled" : "running",
          cancelRequested: !cancellationFinished,
          error: null,
          sides: [
            { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
            { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
          ],
        },
      };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      request: (command) => run("multi-spawn:background", command),
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.openDialog());

    expect(hook.result.current.launchBlocked).toBe(true);
    expect(hook.result.current.recoveryStatus).toMatchObject({
      launchId,
      cancelRequested: true,
    });
    expect(hook.result.current.error).toContain("waiting for provider cleanup");

    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(hook.result.current.launchBlocked).toBe(false);
    expect(hook.result.current.recoveryStatus?.state).toBe("cancelled");
    expect(hook.result.current.error).toContain("cancelled before both providers");
  });

  it("re-enables the dialog when a judge retry is closed mid-flight", async () => {
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad";
    let releaseRetry: (() => void) | null = null;
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type === "duo.comparison.retry") {
        // Hold the retry in flight so the dialog can be closed underneath it.
        await new Promise<void>((resolve) => { releaseRetry = resolve; });
        throw new Error("The judge retry outcome never arrived.");
      }
      if (command.type !== "duo.status") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: "running",
          error: null,
          sides: [
            { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
            { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
          ],
          comparison: {
            state: "failed",
            conversationId: comparisonConversationId,
            turnId: crypto.randomUUID(),
            attempt: 1,
            error: "The judge failed and awaits an explicit retry.",
          },
        },
      };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      request: (command) => run("multi-spawn:background", command),
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.openDialog());
    expect(hook.result.current.recoveryStatus?.comparison?.state).toBe("failed");

    act(() => { void hook.result.current.retryComparison(); });
    expect(hook.result.current.retryingComparison).toBe(true);

    // Closing bumps the operation generation, which invalidates the guard the
    // retry's finally uses to clear this flag. The dialog itself folds the flag
    // into `busy`, so leaving it set disables every control permanently.
    await act(async () => { hook.result.current.closeDialog(); });
    expect(hook.result.current.retryingComparison).toBe(false);

    await act(async () => {
      releaseRetry?.();
      await Promise.resolve();
    });
    expect(hook.result.current.retryingComparison).toBe(false);

    await act(async () => hook.result.current.openDialog());
    expect(hook.result.current.retryingComparison).toBe(false);
    expect(hook.result.current.cancellingComparison).toBe(false);
  });

  it("keeps monitoring a live judge after the dialog closes", async () => {
    vi.useFakeTimers();
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae";
    const judgeError = "The judge failed after the dialog was closed.";
    const status = (comparisonState: "waiting" | "failed"): ServerEvent => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "duo.status",
        launchId,
        state: "running",
        error: null,
        sides: [
          { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
          { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
        ],
        comparison: {
          state: comparisonState,
          conversationId: comparisonConversationId,
          turnId: comparisonState === "failed" ? crypto.randomUUID() : null,
          attempt: comparisonState === "failed" ? 1 : 0,
          error: comparisonState === "failed" ? judgeError : null,
        },
      },
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type === "duo.status") return status("waiting");
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const request = vi.fn(async (): Promise<ServerEvent> => status("failed"));
    const setActionError = vi.fn();
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
      setActionError,
    }));

    await act(async () => hook.result.current.openDialog());
    expect(hook.result.current.recoveryStatus?.comparison?.state).toBe("waiting");
    act(() => hook.result.current.closeDialog());
    expect(hook.result.current.recoveryStatus).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(request).toHaveBeenCalledWith({
      type: "duo.status",
      payload: { launchId },
    });
    expect(setActionError).toHaveBeenCalledWith(judgeError);
    expect(hook.result.current.recoveryStatus).toBeNull();
  });

  it("does not let an old comparison poll overwrite a newly reconciled launch", async () => {
    vi.useFakeTimers();
    const oldLaunchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaabc";
    let pendingReads = 0;
    let resolveOldPoll: ((event: ServerEvent) => void) | null = null;
    const status = (
      launchId: string,
      comparisonState: "waiting" | "failed",
      error: string | null,
    ): ServerEvent => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "duo.status",
        launchId,
        state: "running",
        error: null,
        sides: [
          { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
          { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
        ],
        comparison: {
          state: comparisonState,
          conversationId: comparisonConversationId,
          turnId: comparisonState === "failed" ? crypto.randomUUID() : null,
          attempt: comparisonState === "failed" ? 1 : 0,
          error,
        },
      },
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        pendingReads += 1;
        return pendingLaunchesEvent(pendingReads === 1 ? [oldLaunchId] : []);
      }
      if (command.type !== "duo.status") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      return status(oldLaunchId, "waiting", null);
    });
    const request = vi.fn(() => new Promise<ServerEvent>((resolve) => {
      resolveOldPoll = resolve;
    }));
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

    await act(async () => hook.result.current.openDialog());
    expect(hook.result.current.recoveryStatus?.launchId).toBe(oldLaunchId);
    act(() => hook.result.current.closeDialog());
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => hook.result.current.openDialog());
    expect(hook.result.current.recoveryStatus).toBeNull();
    expect(hook.result.current.launchBlocked).toBe(false);

    await act(async () => {
      resolveOldPoll?.(status(
        oldLaunchId,
        "failed",
        "The older judge failed after the newer launch was shown.",
      ));
      await Promise.resolve();
    });

    expect(hook.result.current.recoveryStatus).toBeNull();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.launchBlocked).toBe(false);
  });

  it("does not let a late old poll steal a newer live comparison watch", async () => {
    vi.useFakeTimers();
    const oldLaunchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaabf";
    const newLaunchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac0";
    let pendingReads = 0;
    let resolveOldPoll: ((event: ServerEvent) => void) | null = null;
    const status = (
      launchId: string,
      state: "waiting" | "failed" | "completed",
    ): ServerEvent => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "duo.status",
        launchId,
        state: "running",
        error: null,
        sides: [
          { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
          { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
        ],
        comparison: {
          state,
          conversationId: comparisonConversationId,
          turnId: state === "waiting" ? null : crypto.randomUUID(),
          attempt: state === "waiting" ? 0 : 1,
          error: state === "failed" ? "The older judge failed." : null,
        },
      },
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        pendingReads += 1;
        return pendingLaunchesEvent([
          pendingReads === 1 ? oldLaunchId : newLaunchId,
        ]);
      }
      if (command.type !== "duo.status") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      return status(command.payload.launchId, "waiting");
    });
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type !== "duo.status") {
        return Promise.reject(new Error(`Unexpected command: ${command.type}`));
      }
      if (command.payload.launchId === oldLaunchId) {
        return new Promise((resolve) => { resolveOldPoll = resolve; });
      }
      return Promise.resolve(status(newLaunchId, "completed"));
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

    await act(async () => hook.result.current.openDialog());
    act(() => hook.result.current.closeDialog());
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });
    await act(async () => hook.result.current.openDialog());
    expect(hook.result.current.recoveryStatus?.launchId).toBe(newLaunchId);

    await act(async () => {
      resolveOldPoll?.(status(oldLaunchId, "failed"));
      await Promise.resolve();
    });
    expect(hook.result.current.recoveryStatus?.launchId).toBe(newLaunchId);

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(request).toHaveBeenLastCalledWith({
      type: "duo.status",
      payload: { launchId: newLaunchId },
    });
    expect(hook.result.current.recoveryStatus?.comparison?.state).toBe("completed");
  });

  it("explains why a waiting comparison blocks a new launch", async () => {
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf";
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type !== "duo.status") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: "running",
          error: null,
          sides: [
            { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
            { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
          ],
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
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      request: (command) => run("multi-spawn:background", command),
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.openDialog());

    expect(hook.result.current.error).toMatch(/comparison is still waiting/i);
    expect(hook.result.current.error).toMatch(/cancel.*release.*lock/i);
    expect(hook.result.current.launchBlocked).toBe(true);
  });

  it("reconciles an ambiguous judge retry before reporting its outcome", async () => {
    vi.useFakeTimers();
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaba";
    let statusReads = 0;
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type === "duo.comparison.retry") {
        throw new RuntimeCommandError("The retry response timed out.", "ambiguous");
      }
      if (command.type !== "duo.status") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      statusReads += 1;
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: "running",
          error: null,
          sides: [
            { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
            { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
          ],
          comparison: {
            state: "failed",
            conversationId: comparisonConversationId,
            turnId: crypto.randomUUID(),
            attempt: 1,
            error: "The first judge attempt failed.",
          },
        },
      };
    });
    const request = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "duo.status",
        launchId,
        state: "running",
        error: null,
        sides: [
          { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
          { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
        ],
        comparison: {
          state: "running",
          conversationId: comparisonConversationId,
          turnId: crypto.randomUUID(),
          attempt: 2,
          error: null,
        },
      },
    }));
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

    await act(async () => hook.result.current.openDialog());
    await act(async () => hook.result.current.retryComparison());

    expect(statusReads).toBe(2);
    expect(hook.result.current.recoveryStatus?.comparison?.state).toBe("failed");
    expect(hook.result.current.error).toMatch(/still pending/i);
    expect(hook.result.current.error).not.toContain("The first judge attempt failed.");

    await act(async () => hook.result.current.recheckRecovery());
    expect(statusReads).toBe(3);

    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(request).toHaveBeenCalledTimes(1);
    expect(hook.result.current.recoveryStatus?.comparison?.state).toBe("running");
    expect(hook.result.current.error).toBeNull();
  });

  it("reconciles an ambiguous judge cancellation before reporting its outcome", async () => {
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaabb";
    writePendingMultiSpawnLaunchId(window.localStorage, launchId);
    let statusReads = 0;
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type === "duo.comparison.cancel") {
        throw new RuntimeCommandError("The cancellation response timed out.", "ambiguous");
      }
      if (command.type !== "duo.status") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      statusReads += 1;
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: "running",
          error: null,
          sides: [
            { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
            { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
          ],
          comparison: statusReads === 1
            ? {
                state: "failed",
                conversationId: comparisonConversationId,
                turnId: crypto.randomUUID(),
                attempt: 1,
                error: "The judge failed.",
              }
            : {
                state: "completed",
                conversationId: comparisonConversationId,
                turnId: crypto.randomUUID(),
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
      request: (command) => run("multi-spawn:background", command),
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.openDialog());
    await act(async () => hook.result.current.cancelComparison());

    expect(statusReads).toBe(2);
    expect(hook.result.current.recoveryStatus?.comparison?.state).toBe("completed");
    expect(hook.result.current.error).toBeNull();
    expect(readPendingMultiSpawnLaunchId(window.localStorage)).toBeNull();
  });

  it("clears the pending identity after a synchronous judge cancellation", async () => {
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaabe";
    writePendingMultiSpawnLaunchId(window.localStorage, launchId);
    const status = (state: "failed" | "cancelled"): ServerEvent => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "duo.status",
        launchId,
        state: "running",
        error: null,
        sides: [
          { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
          { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
        ],
        comparison: {
          state,
          conversationId: comparisonConversationId,
          turnId: state === "failed" ? crypto.randomUUID() : null,
          attempt: 1,
          error: state === "failed" ? "The judge failed." : null,
        },
      },
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type === "duo.status") return status("failed");
      if (command.type === "duo.comparison.cancel") return status("cancelled");
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      request: (command) => run("multi-spawn:background", command),
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    await act(async () => hook.result.current.openDialog());
    await act(async () => hook.result.current.cancelComparison());

    expect(hook.result.current.recoveryStatus?.comparison?.state).toBe("cancelled");
    expect(hook.result.current.launchBlocked).toBe(false);
    expect(readPendingMultiSpawnLaunchId(window.localStorage)).toBeNull();
  });

  it("keeps an ambiguous Duo acknowledgement uncertain until status advances", async () => {
    vi.useFakeTimers();
    const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1";
    const status = (state: "interrupted" | "failed"): ServerEvent => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "duo.status",
        launchId,
        state,
        error: state === "failed" ? "Acknowledgement completed." : null,
        sides: [
          { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: state === "failed" ? "failed" : "uncertain" },
          { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: state === "failed" ? "failed" : "uncertain" },
        ],
      },
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") return pendingLaunchesEvent([launchId]);
      if (command.type === "duo.status") return status("interrupted");
      if (command.type === "duo.acknowledge") {
        throw new RuntimeCommandError("Acknowledgement timed out.", "ambiguous");
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const request = vi.fn(async (): Promise<ServerEvent> => status("failed"));
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

    await act(async () => hook.result.current.openDialog());
    await act(async () => hook.result.current.acknowledgeRecovery());
    expect(hook.result.current.error).toMatch(/may still be finishing/i);

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(request).toHaveBeenCalledTimes(1);
    expect(hook.result.current.recoveryStatus?.state).toBe("failed");
    expect(hook.result.current.error).toBe("Acknowledgement completed.");
  });
});

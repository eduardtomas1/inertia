import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatusToastStack } from "../../src/renderer/src/components/AppStatusOverlays";
import { MultiSpawnRecoveryPanel } from "../../src/renderer/src/components/MultiSpawnRecoveryPanel";
import {
  DuoJudgeNoticeContext,
  DuoJudgeNoticeSlot,
} from "../../src/renderer/src/components/DuoJudgeNoticeContext";
import { useMultiSpawn } from "../../src/renderer/src/hooks/useMultiSpawn";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import {
  MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
  writePendingMultiSpawnLaunchId,
} from "../../src/renderer/src/utils/multiSpawn";
import {
  type AppSnapshot,
  defaultSettings,
  type DuoComparisonStatus,
  type DuoLaunchStatus,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";

const now = "2026-10-21T10:00:00.000Z";
const projectIds = [
  "11111111-1111-4111-8111-111111111111",
  "11111111-1111-4111-8111-111111111112",
  "11111111-1111-4111-8111-111111111113",
  "11111111-1111-4111-8111-111111111114",
] as const;
const launchA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const launchB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const storedLaunch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const folderNotice = "The judge is waiting for its folder; a resumed terminal is using it.";
const busyMessage = "A chat in this Duo is still working, or Inertia has not confirmed its agent stopped. Let it finish or stop it, then try again.";

function project(id: string, index: number): Project {
  const path = `/workspace/project-${index}`;
  return {
    id,
    name: `Project ${index}`,
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

const judgeTitle = "Updater verdict";
const snapshot: AppSnapshot = {
  projects: projectIds.map(project),
  conversations: [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
    projectId: projectIds[0],
    title: judgeTitle,
  }] as AppSnapshot["conversations"],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  settings: defaultSettings,
  activeProjectId: projectIds[0],
  activeConversationId: null,
};

function conversationIdFor(launchId: string, slot: "0" | "1" | "j"): string {
  const suffix = { "0": "1", "1": "2", j: "9" }[slot];
  return `${launchId.slice(0, 35)}${suffix}`;
}

function duoStatus(
  launchId: string,
  comparison: Partial<DuoComparisonStatus> & Pick<DuoComparisonStatus, "state">,
  launch: Partial<DuoLaunchStatus> = {},
): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: {
      kind: "duo.status",
      launchId,
      state: "running",
      error: null,
      sides: [
        { ordinal: 0, conversationId: conversationIdFor(launchId, "0"), turnId: null, dispatchState: "started" },
        { ordinal: 1, conversationId: conversationIdFor(launchId, "1"), turnId: null, dispatchState: "started" },
      ],
      comparison: {
        conversationId: conversationIdFor(launchId, "j"),
        turnId: null,
        attempt: 1,
        error: null,
        ...comparison,
      },
      ...launch,
    },
  };
}

function pending(launchIds: string[]): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: { kind: "duo.pending", launchIds, hasMore: false },
  };
}

type Handler = (command: CommandWithoutId) => ServerEvent | Promise<ServerEvent>;

const appUpdate = {
  status: null,
  checking: false,
  visible: false,
  error: null,
  check: vi.fn(async () => undefined),
  download: vi.fn(async () => undefined),
  cancelDownload: vi.fn(async () => undefined),
  install: vi.fn(async () => undefined),
  dismiss: vi.fn(),
  dismissError: vi.fn(),
  openRelease: vi.fn(async () => undefined),
};

function setup({
  run: runHandler = () => {
    throw new Error("Unexpected foreground command.");
  },
  request: requestHandler,
  startupSweep = false,
  slotConversationId = null,
  activeConversationId = null,
  conversations = snapshot.conversations,
  detachedConversationIds,
}: {
  run?: Handler;
  request: Handler;
  startupSweep?: boolean;
  slotConversationId?: string | null;
  activeConversationId?: string | null;
  conversations?: AppSnapshot["conversations"];
  detachedConversationIds?: ReadonlySet<string>;
}) {
  const run = vi.fn(async (_key: string, command: CommandWithoutId) =>
    runHandler(command));
  const request = vi.fn(async (command: CommandWithoutId) =>
    requestHandler(command));
  const setActionError = vi.fn();
  const controller: { current: ReturnType<typeof useMultiSpawn> | null } = {
    current: null,
  };
  let currentActiveConversationId = activeConversationId;
  function Harness(): React.JSX.Element {
    const multiSpawn = useMultiSpawn({
      snapshot: { ...snapshot, conversations, activeConversationId: currentActiveConversationId },
      settings: defaultSettings,
      run,
      request,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError,
      startupSweep,
      detachedConversationIds,
    });
    controller.current = multiSpawn;
    return (
      <DuoJudgeNoticeContext.Provider value={multiSpawn.judgeNotices}>
        <StatusToastStack
          appUpdate={appUpdate}
          providerQuotaNotices={{ notices: [], dismiss: vi.fn() }}
          error={null}
          onDismissError={vi.fn()}
          databaseRecoveryNotice={null}
          onDismissDatabaseRecoveryNotice={vi.fn()}
          onImportRecovery={vi.fn(async () => undefined)}
          onCopyRecoveryReport={vi.fn(async () => undefined)}
        />
        {slotConversationId && (
          <DuoJudgeNoticeSlot
            conversationId={slotConversationId}
            conversationStatus="idle"
          />
        )}
      </DuoJudgeNoticeContext.Provider>
    );
  }
  const view = render(<Harness />);
  return {
    run,
    request,
    setActionError,
    hook: () => controller.current!,
    show: (conversationId: string | null) => {
      currentActiveConversationId = conversationId;
      view.rerender(<Harness />);
    },
  };
}

function commandsOf(mock: ReturnType<typeof vi.fn>): CommandWithoutId[] {
  return mock.mock.calls.map((call) => call.at(-1) as CommandWithoutId);
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("Duo launch watch", () => {
  it("sweeps every project at startup and restores the stored launch read-only", async () => {
    writePendingMultiSpawnLaunchId(window.localStorage, storedLaunch);
    const judgeA = conversationIdFor(launchA, "j");
    const { request, run, hook } = setup({
      startupSweep: true,
      slotConversationId: judgeA,
      run: (command) => {
        if (command.type === "conversation.select") {
          return { type: "request.ok", requestId: crypto.randomUUID() };
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
      request: (command) => {
        if (command.type === "duo.pending") {
          return pending(command.payload.projectIds.includes(projectIds[3])
            ? [launchB]
            : [launchA]);
        }
        if (command.type !== "duo.status") {
          throw new Error(`Unexpected command: ${command.type}`);
        }
        if (command.payload.launchId === launchA) {
          return duoStatus(launchA, {
            state: "failed",
            error: "The judge could not start: provider missing.",
          });
        }
        if (command.payload.launchId === launchB) {
          return duoStatus(launchB, { state: "waiting", error: folderNotice, attempt: 0 });
        }
        return duoStatus(storedLaunch, { state: "completed" });
      },
    });

    expect(await screen.findByText("“Updater verdict” didn't finish.")).toBeVisible();
    expect(commandsOf(request).map((command) => command.type === "duo.pending"
      ? command.payload.projectIds
      : command.type === "duo.status" ? command.payload.launchId : command.type))
      .toEqual([
        [projectIds[0], projectIds[1], projectIds[2]],
        [projectIds[3]],
        launchA,
        launchB,
        storedLaunch,
      ]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(window.localStorage.getItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY))
      .toBeNull();
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchB, "0")))
      .toMatchObject({ launchId: launchB, role: "side", comparison: { state: "waiting", error: folderNotice } });
    expect(await screen.findByText("Judge didn't finish")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open judge" }));
    await waitFor(() => expect(commandsOf(run)).toContainEqual({
      type: "conversation.select",
      payload: { conversationId: judgeA },
    }));
    expect(screen.queryByText("“Updater verdict” didn't finish.")).not.toBeInTheDocument();
    expect(commandsOf(request).some((command) => command.type === "duo.cancel"))
      .toBe(false);
  });

  it("knows when the other chats of a waiting Duo have finished", async () => {
    const sourceA = conversationIdFor(launchA, "0");
    const sourceB = conversationIdFor(launchA, "1");
    const judge = conversationIdFor(launchA, "j");
    const { hook } = setup({
      startupSweep: true,
      conversations: [
        { id: sourceA, projectId: projectIds[0], title: "Duo A", status: "completed" },
        { id: sourceB, projectId: projectIds[0], title: "Duo B", status: "running" },
        { id: judge, projectId: projectIds[0], title: judgeTitle, status: "idle" },
      ] as AppSnapshot["conversations"],
      request: (command) => command.type === "duo.pending"
        ? pending([launchA])
        : duoStatus(launchA, { state: "waiting", attempt: 0 }),
    });
    await waitFor(() => expect(hook().judgeNotices.comparisonForConversation(sourceB))
      .not.toBeNull());
    expect(hook().judgeNotices.comparisonForConversation(sourceA)?.othersFinished).toBe(false);
    expect(hook().judgeNotices.comparisonForConversation(sourceB)?.othersFinished).toBe(true);
    expect(hook().judgeNotices.comparisonForConversation(judge)?.othersFinished).toBe(false);
  });

  it("dismisses a startup toast for the rest of the session", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const { hook } = setup({
      startupSweep: true,
      request: (command) => {
        if (command.type === "duo.pending") return pending([launchA]);
        reads += 1;
        return duoStatus(launchA, { state: "interrupted" }, { cancelRequested: true });
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", {
      name: "Dismiss Duo judge notice",
    }));
    expect(screen.queryByText("“Updater verdict” was interrupted.")).not.toBeInTheDocument();
    const readsAtDismissal = reads;

    await act(async () => vi.advanceTimersByTimeAsync(3 * 750));

    expect(reads).toBeGreaterThan(readsAtDismissal);
    expect(screen.queryByText("“Updater verdict” was interrupted.")).not.toBeInTheDocument();
    expect(hook().judgeNotices.alerts).toEqual([]);
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "j"))
      ?.comparison.state).toBe("interrupted");
  });

  it("lets the pane notice own a startup failure while a chat of that Duo is visible", async () => {
    const sourceA = conversationIdFor(launchA, "0");
    const { hook, show } = setup({
      startupSweep: true,
      activeConversationId: sourceA,
      slotConversationId: sourceA,
      request: (command) => command.type === "duo.pending"
        ? pending([launchA])
        : duoStatus(launchA, { state: "failed", error: "The judge turn failed: crash." }),
    });
    expect(await screen.findByText("Judge didn't finish")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(hook().judgeNotices.alerts).toEqual([]);

    show(null);
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { visible: "none", toast: true },
    { visible: "active", toast: false },
    { visible: "detached", toast: false },
  ] as const)("announces a judge that fails later through the named toast only when no Duo chat is visible: $visible", async ({ visible, toast }) => {
    vi.useFakeTimers();
    let polls = 0;
    const { hook, setActionError } = setup({
      activeConversationId: visible === "active" ? conversationIdFor(launchA, "1") : null,
      detachedConversationIds: new Set(visible === "detached" ? [conversationIdFor(launchA, "0")] : []),
      run: (command) => {
        if (command.type === "duo.pending") return pending([launchA]);
        if (command.type === "duo.status") return duoStatus(launchA, { state: "running" });
        throw new Error(`Unexpected command: ${command.type}`);
      },
      request: () => {
        polls += 1;
        return duoStatus(launchA, {
          state: "failed",
          error: "The judge turn failed: crash.",
        });
      },
    });
    await act(async () => hook().openDialog());
    act(() => hook().closeDialog());
    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(polls).toBe(1);
    expect(setActionError).not.toHaveBeenCalledWith(expect.stringContaining("crash"));
    expect(hook().judgeNotices.alerts).toEqual(toast
      ? [{ launchId: launchA, conversationId: conversationIdFor(launchA, "j"), title: judgeTitle, state: "failed" }]
      : []);
    expect(screen.queryByText("“Updater verdict” didn't finish.") !== null).toBe(toast);
  });

  it("follows pending pages up to the page bound", async () => {
    const { request, hook } = setup({
      startupSweep: true,
      request: (command) => {
        if (command.type === "duo.pending") {
          const page = command.payload.page ?? 0;
          if (command.payload.projectIds.includes(projectIds[3])) {
            return { ...pending([]), result: { kind: "duo.pending", launchIds: [], hasMore: true } };
          }
          return {
            ...pending([]),
            result: { kind: "duo.pending", launchIds: [page === 0 ? launchA : launchB], hasMore: page === 0 },
          };
        }
        if (command.type !== "duo.status") {
          throw new Error(`Unexpected command: ${command.type}`);
        }
        return duoStatus(command.payload.launchId, { state: "waiting", attempt: 0 });
      },
    });
    await waitFor(() => expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchB, "0")))
      .not.toBeNull());
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "0"))).not.toBeNull();
    const pages = commandsOf(request).flatMap((command) => command.type === "duo.pending"
      ? [`${command.payload.projectIds.length}:${command.payload.page ?? 0}`]
      : []);
    expect(pages).toEqual(["3:0", "3:1", ...Array.from({ length: 8 }, (_, page) => `1:${page}`)]);
  });

  it("retries a failed startup sweep on the next poll tick", async () => {
    vi.useFakeTimers();
    let failures = 1;
    const { hook } = setup({
      startupSweep: true,
      request: (command) => {
        if (command.type === "duo.pending") {
          if (failures > 0) {
            failures -= 1;
            throw new RuntimeCommandError("Connection interrupted.", "ambiguous");
          }
          return pending(command.payload.projectIds.includes(projectIds[0]) ? [launchA] : []);
        }
        return duoStatus(launchA, { state: "interrupted" });
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "j"))).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1_250));
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "j"))
      ?.comparison.state).toBe("interrupted");
  });

  it("does not sweep or toast before the runtime is ready", async () => {
    const { request } = setup({
      request: () => pending([launchA]),
    });
    await act(async () => Promise.resolve());
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("watches every live launch instead of only the newest", async () => {
    vi.useFakeTimers();
    let polled = false;
    const { request, hook } = setup({
      run: (command) => {
        if (command.type === "duo.pending") return pending([launchA, launchB]);
        if (command.type === "duo.status") {
          return duoStatus(command.payload.launchId, { state: "waiting", attempt: 0 });
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
      request: (command) => {
        if (command.type !== "duo.status") {
          throw new Error(`Unexpected command: ${command.type}`);
        }
        polled = true;
        return command.payload.launchId === launchA
          ? duoStatus(launchA, { state: "running" })
          : duoStatus(launchB, { state: "waiting", error: folderNotice, attempt: 0 });
      },
    });

    await act(async () => hook().openDialog());
    act(() => hook().closeDialog());
    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(polled).toBe(true);
    expect(commandsOf(request).map((command) =>
      command.type === "duo.status" ? command.payload.launchId : null).sort())
      .toEqual([launchA, launchB]);
    const notices = hook().judgeNotices;
    expect(notices.comparisonForConversation(conversationIdFor(launchA, "j"))
      ?.comparison.state).toBe("running");
    expect(notices.comparisonForConversation(conversationIdFor(launchB, "1")))
      .toMatchObject({ role: "side", comparison: { state: "waiting", error: folderNotice } });

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("applies a notice retry immediately and keeps polling the waiting judge", async () => {
    vi.useFakeTimers();
    let retried = false;
    const { request, hook } = setup({
      run: (command) => {
        if (command.type === "duo.pending") return pending([launchA]);
        if (command.type === "duo.status") {
          return duoStatus(launchA, { state: "failed", error: "The judge turn failed: crash." });
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
      request: (command) => {
        if (command.type === "duo.comparison.retry") {
          retried = true;
          return duoStatus(launchA, { state: "waiting", error: folderNotice });
        }
        if (command.type === "duo.status") {
          return duoStatus(launchA, { state: "running", attempt: 2 });
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
    });
    await act(async () => hook().openDialog());
    act(() => hook().closeDialog());

    await act(async () => hook().judgeNotices.retry(launchA));
    expect(retried).toBe(true);
    expect(hook().judgeNotices.pendingAction(launchA)).toBeNull();
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "j"))
      ?.comparison).toMatchObject({ state: "waiting", error: folderNotice, attempt: 1 });

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(commandsOf(request).at(-1)).toEqual({
      type: "duo.status",
      payload: { launchId: launchA },
    });
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "j"))
      ?.comparison.state).toBe("running");
  });

  it("reports why a notice cancellation could not settle", async () => {
    const { setActionError, hook } = setup({
      run: (command) => {
        if (command.type === "duo.pending") return pending([launchA]);
        if (command.type === "duo.status") {
          return duoStatus(launchA, { state: "failed", error: "Failed." });
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
      request: (command) => {
        if (command.type === "duo.comparison.cancel") {
          throw new RuntimeCommandError(busyMessage, "rejected");
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
    });
    await act(async () => hook().openDialog());
    await act(async () => hook().judgeNotices.cancel(launchA));
    expect(setActionError).toHaveBeenLastCalledWith(
      `The judge could not be cancelled. ${busyMessage}`,
    );
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "j"))
      ?.comparison.state).toBe("failed");
  });

  it("confirms an ambiguous retry that returned to waiting on the same attempt", async () => {
    let retryAttempted = false;
    const { hook } = setup({
      run: (command) => {
        if (command.type === "duo.pending") return pending([launchA]);
        if (command.type === "duo.comparison.retry") {
          retryAttempted = true;
          throw new RuntimeCommandError("The retry response timed out.", "ambiguous");
        }
        if (command.type === "duo.status") {
          return retryAttempted
            ? duoStatus(launchA, { state: "waiting", error: folderNotice })
            : duoStatus(launchA, { state: "failed", error: "Failed." });
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
      request: () => new Promise<ServerEvent>(() => undefined),
    });
    await act(async () => hook().openDialog());
    await act(async () => hook().retryComparison());

    expect(hook().recoveryStatus?.comparison).toMatchObject({
      state: "waiting",
      attempt: 1,
    });
    expect(hook().error).toBe(folderNotice);
    expect(hook().error).not.toMatch(/still pending/iu);
  });

  it("accepts any settled acknowledgement and shows the server's refusal", async () => {
    let acknowledgements = 0;
    const interrupted = duoStatus(launchA, { state: "completed" }, {
      state: "interrupted",
      comparison: undefined,
    });
    const { hook } = setup({
      run: (command) => {
        if (command.type === "duo.pending") {
          return pending(acknowledgements === 2 ? [] : [launchA]);
        }
        if (command.type === "duo.status") return interrupted;
        if (command.type === "duo.acknowledge") {
          acknowledgements += 1;
          if (acknowledgements === 1) {
            throw new RuntimeCommandError(busyMessage, "rejected");
          }
          return duoStatus(launchA, { state: "completed" }, {
            state: "cancelled",
            comparison: undefined,
          });
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
      request: () => new Promise<ServerEvent>(() => undefined),
    });
    await act(async () => hook().openDialog());
    expect(hook().recoveryStatus?.state).toBe("interrupted");

    await act(async () => hook().acknowledgeRecovery());
    expect(hook().error).toBe(busyMessage);

    await act(async () => hook().acknowledgeRecovery());
    expect(hook().error).toBeNull();
    expect(hook().recoveryStatus).toBeNull();
    expect(hook().launchBlocked).toBe(false);
  });

  it("retries a launch whose startup status read failed transiently", async () => {
    vi.useFakeTimers();
    const reads = new Map<string, number>();
    const { hook } = setup({
      startupSweep: true,
      request: (command) => {
        if (command.type === "duo.pending") return pending([launchA, launchB]);
        if (command.type !== "duo.status") {
          throw new Error(`Unexpected command: ${command.type}`);
        }
        const { launchId } = command.payload;
        const read = (reads.get(launchId) ?? 0) + 1;
        reads.set(launchId, read);
        if (launchId === launchB) {
          throw new RuntimeCommandError("Unknown Duo launch.", "rejected");
        }
        if (read < 3) {
          throw new RuntimeCommandError("Connection interrupted.", "ambiguous");
        }
        return duoStatus(launchA, {
          state: "failed",
          error: "The judge could not start: provider missing.",
        });
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(reads).toEqual(new Map([[launchA, 1], [launchB, 1]]));
    expect(hook().judgeNotices.alerts).toEqual([]);

    await act(async () => vi.advanceTimersByTimeAsync(1_250));
    expect(reads.get(launchA)).toBe(2);
    expect(hook().judgeNotices.alerts).toEqual([]);

    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(reads).toEqual(new Map([[launchA, 3], [launchB, 1]]));
    expect(hook().judgeNotices.alerts).toEqual([
      { launchId: launchA, conversationId: conversationIdFor(launchA, "j"), title: judgeTitle, state: "failed" },
    ]);
    expect(hook().judgeNotices.comparisonForConversation(conversationIdFor(launchA, "0")))
      .toMatchObject({ launchId: launchA, comparison: { state: "failed" } });
  });

  it("shows the saved cause of an interrupted judge in the recovery panel", () => {
    const cause = "Inertia closed while the judge was running; its result is unknown.";
    const event = duoStatus(launchA, { state: "interrupted", error: cause });
    if (event.type !== "request.result" || event.result.kind !== "duo.status") {
      throw new Error("Expected a Duo status.");
    }
    render(
      <MultiSpawnRecoveryPanel
        recoveryStatus={event.result}
        recoveryGuidance={[]}
        busy={false}
        recheckingRecovery={false}
        acknowledgingRecovery={false}
        retryingComparison={false}
        cancellingComparison={false}
      />,
    );

    const panel = screen.getByRole("region", { name: "Duo status" });
    expect(panel).toHaveTextContent("Interrupted — result unknown");
    expect(screen.getByText(cause)).toHaveClass("multi-spawn-status-detail");
  });
});

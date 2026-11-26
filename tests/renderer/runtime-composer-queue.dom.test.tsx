import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUEUE_VISIBLE_ROWS,
  RuntimeComposerQueuedActions,
} from "../../src/renderer/src/components/composer/RuntimeComposerQueuedActions";
import {
  enqueueRuntimePrompt,
  finishQueueIntent,
  getPendingQueueIntents,
  MAX_PENDING_QUEUE_INTENTS,
  queueIntent,
  RUNTIME_QUEUE_CHANGED,
  type QueueCommandRunner,
} from "../../src/renderer/src/components/composer/runtimeQueueClient";
import type { MessageQueueResult, QueuedMessage } from "../../src/shared/queued-messages";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { readSourceText } from "../helpers/source-text";
import { chatQueueRunner } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import type { Conversation } from "../../src/shared/contracts";
import {
  announceRuntimeQueueChanged,
  announceRuntimeQueueReconnected,
  useRuntimeQueueLength,
  useRuntimeQueueSummary,
  useRuntimeQueuedFollowUps,
} from "../../src/renderer/src/components/composer/runtimeQueueEvents";

const conversationId = "40404040-4040-4040-8040-404040404040";
const queued: QueuedMessage = {
  id: "50505050-5050-4050-8050-505050505050",
  conversationId,
  content: "Next task",
  attachments: [],
  state: "waiting",
  createdAt: "2026-09-26T00:00:00.000Z",
  error: null,
  turnId: null,
  userMessageId: null,
};
const makeEntry = (index: number, overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  ...queued,
  id: `5050505${index}-5050-4050-8050-505050505050`,
  content: `Queued task ${index}`,
  ...overrides,
});
const response = (
  entries = [queued],
  extra: Partial<MessageQueueResult> = {},
): MessageQueueResult => ({
  kind: "message.queue",
  conversationId,
  entries,
  receipt: null,
  ...extra,
});

beforeEach(() => window.localStorage.clear());

describe("runtime queue presentation, push invalidation, and durable draft identity", () => {
  it("defers a pending queue result until the window becomes visible again", async () => {
    let resolveRead!: (value: MessageQueueResult) => void;
    const pending = new Promise<MessageQueueResult>((resolve) => { resolveRead = resolve; });
    const run = vi.fn<QueueCommandRunner>().mockReturnValueOnce(pending).mockResolvedValue(response());
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(
      <RuntimeComposerQueuedActions
        conversationId={conversationId}
        onCommand={run}
        canSend
        latestTurnId="first"
        latestTurnStatus="completed"
        queueHost={null}
      />,
    );
    try {
      visibility.mockReturnValue("hidden");
      await act(async () => { resolveRead(response()); await pending; });
      expect(screen.queryByText("Next task")).toBeNull();
      visibility.mockReturnValue("visible");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(screen.getByText("Next task")).toBeTruthy();
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      visibility.mockRestore();
    }
  });

  it("never polls on a 10s interval and refetches only on push invalidation (ignoring stale revisions) or reconnect", async () => {
    vi.useFakeTimers();
    try {
      let entries: QueuedMessage[] = [queued];
      let revision = 5;
      const run = vi.fn<QueueCommandRunner>(async () => response(entries, { revision }));
      let commits = 0;
      const view = render(
        <Profiler id="queue" onRender={() => { commits += 1; }}>
          <RuntimeComposerQueuedActions
            conversationId={conversationId}
            onCommand={run}
            canSend
            running
            latestTurnId="first"
            latestTurnStatus="running"
            queueHost={null}
          />
        </Profiler>,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(run).toHaveBeenCalledTimes(1);
      const settledCommits = commits;

      // Advance 60 seconds: zero polling reads occur.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(run).toHaveBeenCalledTimes(1);
      expect(commits).toBe(settledCommits);

      // Stale revision <= 5 is ignored.
      await act(async () => {
        announceRuntimeQueueChanged(conversationId, 4);
        announceRuntimeQueueChanged(conversationId, 5);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(run).toHaveBeenCalledTimes(1);

      // Newer revision triggers exactly one fetch.
      entries = [{ ...queued, content: "Updated by push" }];
      revision = 6;
      await act(async () => {
        announceRuntimeQueueChanged(conversationId, 6);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(run).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Updated by push")).toBeTruthy();

      // Reconnect triggers exactly one fetch.
      entries = [{ ...queued, content: "Updated after reconnect" }];
      revision = 7;
      await act(async () => {
        announceRuntimeQueueReconnected(conversationId);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(run).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Updated after reconnect")).toBeTruthy();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports up to 20 pending intents and renders unconfirmed localStorage intents as disabled Saving rows", async () => {
    for (let index = 0; index < MAX_PENDING_QUEUE_INTENTS; index += 1) {
      queueIntent(conversationId, `Draft ${index + 1}`, []);
    }
    expect(MAX_PENDING_QUEUE_INTENTS).toBe(20);
    expect(getPendingQueueIntents(conversationId)).toHaveLength(20);
    expect(() => queueIntent(conversationId, "Draft 21", [])).toThrow("Confirm the earlier queued drafts");

    window.localStorage.clear();
    const pendingId = queueIntent(conversationId, "Pending local intent", []);
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response([queued]));
    render(
      <RuntimeComposerQueuedActions
        conversationId={conversationId}
        onCommand={run}
        canSend
        latestTurnId="first"
        latestTurnStatus="running"
        queueHost={null}
      />,
    );
    await screen.findByText("Next task");
    await screen.findByText("Pending local intent");
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove pending queued message 2 of 2" })).toBeDisabled();
    finishQueueIntent(conversationId, pendingId);
    expect(getPendingQueueIntents(conversationId)).toEqual([]);
  });

  it("expands and collapses once more than 3 queued messages wait, keeping focus on the toggle", async () => {
    expect(QUEUE_VISIBLE_ROWS).toBe(3);
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3), makeEntry(4)];
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response(entries));
    render(
      <RuntimeComposerQueuedActions
        conversationId={conversationId}
        onCommand={run}
        canSend
        running
        latestTurnId="first"
        latestTurnStatus="running"
        queueHost={null}
      />,
    );
    const list = await screen.findByRole("list", { name: "Queued messages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const toggle = screen.getByRole("button", { name: "Show all 4 queued" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", list.id);

    toggle.focus();
    fireEvent.click(toggle);
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show fewer" }));

    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows the held banner with derived hold reason, inline Resume, attribution chips, model chips, and steer waiting state", async () => {
    const entries: QueuedMessage[] = [
      makeEntry(1, {
        queueHeld: true,
        creationSource: "mobile",
        deviceId: "11111111-1111-4111-8111-111111111111",
        steerWhenReadyRunId: "22222222-2222-4222-8222-222222222222",
        modelSelection: {
          harnessId: "claude-agent-sdk",
          backendProfileId: "native:claude",
          backendProfileDisplayName: "Claude",
          modelId: "claude-sonnet-4-5",
          alias: null,
          reasoningEffort: "medium",
          contextWindowOverride: null,
          providerOptions: {},
          capabilities: [],
          backendConfigurationRevision: 1,
        },
      }),
      makeEntry(2, { queueHeld: true, createdBy: "agent", creationSource: "mcp" }),
    ];
    const onResume = vi.fn(async () => undefined);
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(
      response(entries, { held: true, holdReason: "stopped", canResume: true, revision: 3 }),
    );
    let summary = { userCount: 0, totalCount: 0, held: false, holdReason: null as string | null, canResume: false, latestRevision: 0 };
    function Observer(): null {
      summary = useRuntimeQueueSummary(conversationId);
      return null;
    }
    render(
      <>
        <RuntimeComposerQueuedActions
          conversationId={conversationId}
          onCommand={run}
          canSend
          onResume={onResume}
          latestTurnId="first"
          latestTurnStatus="cancelled"
          queueHost={null}
        />
        <Observer />
      </>,
    );
    expect(await screen.findByText("Queue paused · Stopped")).toBeInTheDocument();
    expect(screen.getByText("From device")).toBeInTheDocument();
    expect(screen.getByText("From agent")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
    expect(screen.getByText("Waiting for acceptance…")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Queued message 1 of 2, claude-sonnet-4-5" })).toBeInTheDocument();
    expect(summary).toMatchObject({ userCount: 2, totalCount: 2, held: true, holdReason: "stopped", canResume: true, latestRevision: 3 });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume queue" })); });
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("uses dynamic Send labels (Stop and send / hidden) based on steer and interrupt capabilities", async () => {
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response([queued]));
    const view = render(
      <RuntimeComposerQueuedActions
        conversationId={conversationId}
        onCommand={run}
        canSend={false}
        running
        canSteer={false}
        canInterrupt
        latestTurnId="first"
        latestTurnStatus="running"
        queueHost={null}
      />,
    );
    const stopAndSend = await screen.findByRole("button", { name: "Stop and send queued message" });
    expect(stopAndSend).toHaveTextContent("Stop and send");
    expect(stopAndSend).toBeEnabled();

    view.rerender(
      <RuntimeComposerQueuedActions
        conversationId={conversationId}
        onCommand={run}
        canSend={false}
        running
        canSteer={false}
        canInterrupt={false}
        latestTurnId="first"
        latestTurnStatus="running"
        queueHost={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /Send|Stop and send/u })).toBeNull();
  });

  it("separates the persistent polite status live region from error alerts", async () => {
    const blocked: QueuedMessage = { ...queued, state: "blocked", error: "The route is no longer available." };
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response([blocked]));
    render(
      <RuntimeComposerQueuedActions
        conversationId={conversationId}
        onCommand={run}
        canSend
        latestTurnId="first"
        latestTurnStatus="completed"
        queueHost={null}
      />,
    );
    await screen.findByText("Needs attention");
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("The route is no longer available.");
    const css = readSourceText("src/renderer/src/components/composer/RuntimeComposerQueuedActions.css");
    expect(css).toContain(".composer-queue-send:disabled {\n  color: var(--text-muted);\n  opacity: var(--disabled-opacity);\n}");
  });

  it("answers an unsaved chat's queue reads locally and forwards receipt checks and edits", async () => {
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response([]));
    const draft = { id: conversationId } as Conversation;
    expect(chatQueueRunner(run, null, [])).toBe(run);
    expect(chatQueueRunner(run, draft, [{ id: conversationId }])).toBe(run);
    const unsaved = chatQueueRunner(run, draft, [])!;
    expect(chatQueueRunner(run, draft, undefined)).toBe(unsaved);
    await expect(unsaved({ type: "message.queue.get", payload: { conversationId } }))
      .resolves.toEqual({ kind: "message.queue", conversationId, entries: [], receipt: null });
    expect(run).not.toHaveBeenCalled();
    await unsaved({ type: "message.queue.get", payload: { conversationId, id: queued.id } });
    await unsaved({ type: "message.queue.remove", payload: { conversationId, id: queued.id } });
    expect(run.mock.calls.map(([command]) => command.type)).toEqual(["message.queue.get", "message.queue.remove"]);
  });

  it("preserves attachment snapshot metadata on enqueue and reuses durable draft identity on retry", async () => {
    const snapshot = {
      capturedAt: "2026-11-26T00:00:00.000Z",
      appName: "Browser",
      windowTitle: "Preview",
      width: 800,
      height: 600,
      accessibility: {
        format: "element-tree" as const,
        coordinateSpace: "captured-image" as const,
        truncated: false,
        nodes: [],
      },
    };
    const attachment = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "snap.png",
      path: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png" as const,
      size: 64,
      snapshot,
    };
    const run = vi.fn<QueueCommandRunner>()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockRejectedValueOnce(new Error("Still disconnected"))
      .mockImplementationOnce(async (command) => response([], { receipt: { ...queued, id: (command.payload as { id: string }).id, state: "accepted" } }));
    await expect(enqueueRuntimePrompt(run, conversationId, "Inspect snap", [attachment])).rejects.toThrow("Disconnected");
    await enqueueRuntimePrompt(run, conversationId, "Inspect snap", [attachment]);
    const firstPayload = run.mock.calls[0]![0].payload as unknown as { id: string; attachments: typeof attachment[] };
    const retryPayload = run.mock.calls[2]![0].payload as unknown as { id: string; attachments: typeof attachment[] };
    expect(retryPayload.id).toBe(firstPayload.id);
    expect(firstPayload.attachments[0]?.snapshot).toEqual(snapshot);
  });

  it("frees a definitively rejected intent only after confirming there is no receipt", async () => {
    const rejectedId = queueIntent(conversationId, "Next task", []);
    const run = vi.fn<QueueCommandRunner>()
      .mockRejectedValueOnce(new RuntimeCommandError("Full queue", "rejected"))
      .mockResolvedValueOnce(response([], { receipt: null }));
    await expect(enqueueRuntimePrompt(run, conversationId, "Next task", [])).rejects.toThrow("Full queue");
    expect(queueIntent(conversationId, "Next task", [])).not.toBe(rejectedId);
    expect(run.mock.calls.map(([command]) => command.type)).toEqual(["message.queue.enqueue", "message.queue.get"]);
  });

  it("does not resurrect a removed entry when an earlier queue read finishes late", async () => {
    let resolveRead!: (value: MessageQueueResult) => void;
    const pending = new Promise<MessageQueueResult>((resolve) => { resolveRead = resolve; });
    const run = vi.fn<QueueCommandRunner>()
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(pending)
      .mockResolvedValue(response([]));
    render(
      <RuntimeComposerQueuedActions
        conversationId={conversationId}
        onCommand={run}
        canSend
        latestTurnId="first"
        latestTurnStatus="completed"
        queueHost={null}
      />,
    );
    await screen.findByText("Next task");
    await act(async () => { window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove queued message" })); });
    expect(screen.queryByText("Next task")).toBeNull();
    await act(async () => { resolveRead(response()); await pending; });
    expect(screen.queryByText("Next task")).toBeNull();
  });

  it("labels an unread follow-up, keeps it out of the user queue count, and hides it from the timeline while waiting", async () => {
    const unread: QueuedMessage = {
      ...queued,
      id: "60606060-6060-4060-8060-606060606060",
      content: "Also look at this.",
      userMessageId: "70707070-7070-4070-8070-707070707070",
    };
    const run = vi.fn<QueueCommandRunner>().mockResolvedValue(response([unread, queued]));
    const observed: { length: number; hidden: readonly string[] } = { length: -1, hidden: [] };
    function Observer(): null {
      observed.length = useRuntimeQueueLength(conversationId);
      observed.hidden = useRuntimeQueuedFollowUps(conversationId);
      return null;
    }
    const view = render(
      <>
        <RuntimeComposerQueuedActions
          conversationId={conversationId}
          onCommand={run}
          canSend
          latestTurnId="first"
          latestTurnStatus="failed"
          queueHost={null}
        />
        <Observer />
      </>,
    );
    expect(await screen.findByText("Not read, sends next")).toBeTruthy();
    expect(observed).toEqual({ length: 1, hidden: [unread.userMessageId] });
    run.mockResolvedValue(response([queued]));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send unread follow-up now" })); });
    await waitFor(() => expect(screen.queryByText("Not read, sends next")).toBeNull());
    expect(observed.hidden).toEqual([]);
    view.unmount();
  });
});

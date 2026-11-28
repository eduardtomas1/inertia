import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CursorSdkTransport } from "../../src/renderer/src/components/cursor-sdk/CursorSdkContext";
import { useCursorSdkAccount } from "../../src/renderer/src/components/cursor-sdk/useCursorSdkAccount";
import {
  clearDelegatedCompletionCardState,
  DelegatedCompletionCard,
} from "../../src/renderer/src/components/orchestration/delegated-completion-card";
import { DelegationLineage } from "../../src/renderer/src/components/orchestration/delegation-panel";
import type { DelegationCommandRunner } from "../../src/renderer/src/components/orchestration/delegation-model";
import { DelegationSurfaceProvider } from "../../src/renderer/src/components/orchestration/delegation-surface";
import { ForkHistoryView } from "../../src/renderer/src/components/orchestration/fork-history-view";
import { ForkSurfaceProvider, ForkTurnAction, type ForkCommandRunner } from "../../src/renderer/src/components/orchestration/fork-surface";
import { requestStartRollback } from "../../src/renderer/src/components/orchestration/history-session";
import {
  clearObservedAgentsDetailsState,
  ObservedAgentsDetails,
} from "../../src/renderer/src/components/orchestration/observed-agents-details";
import { ObservedChildView } from "../../src/renderer/src/components/orchestration/observed-child-view";
import { ConversationPane } from "../../src/renderer/private-connect/src/workspace/ConversationPane";
import { WorkspaceShell } from "../../src/renderer/private-connect/src/workspace/WorkspaceShell";
import type { Detail, Shell } from "../../src/renderer/private-connect/src/types";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import type { ChatMessage, ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  OBSERVED_CHILD_READ_ONLY_REASON,
  observedChildReadResultSchema,
  type ObservedChildControlSet,
  type ObservedChildThread,
} from "../../src/shared/observed-child-thread";
import { forkHistoryResultSchema } from "../../src/shared/orchestration-forks";
import { PARENT_ID, finished, parentDelegation, resultEvent, summary, taskId } from "./delegation-fixtures";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONV_A = "22222222-2222-4222-8222-222222222222";
const CONV_B = "33333333-3333-4333-8333-333333333333";
const TURN_1 = "44444444-4444-4444-8444-444444444444";
const TURN_2 = "55555555-5555-4555-8555-555555555555";
const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test" });

function forkHistoryPage(conversationId: string, withLineage: boolean): ServerEvent {
  return {
    type: "request.result",
    requestId: "req",
    result: forkHistoryResultSchema.parse({
      kind: "conversation.fork.history",
      conversationId,
      next: null,
      parts: [],
      lineage: withLineage ? {
        threadId: conversationId,
        projectId: PROJECT_ID,
        parentThreadId: CONV_B,
        rootThreadId: CONV_B,
        sourceRunId: "run-1",
        sourceTurnId: TURN_1,
        sourceWorkspaceKey: "/workspace",
        sourceProviderId: "codex",
        sourceSelection: selection,
        sourceIdentity: continuationIdentityForSelection(selection),
        nativeBoundary: null,
        inheritedItems: 1,
        inheritedParts: 1,
        transfer: "portable",
        createdAt: "2026-10-30T10:00:00.000Z",
      } : null,
    }),
  } as ServerEvent;
}

function observedControls(stop: ObservedChildControlSet["stop"]): ObservedChildControlSet {
  const unsupported = (code: string, reason: string) => ({ supported: false as const, code, reason });
  return {
    stop,
    send: { supported: false, code: "read-only", reason: OBSERVED_CHILD_READ_ONLY_REASON },
    transcript: unsupported("transcript-unavailable", "Native transcripts are not stored."),
    pin: unsupported("not-a-conversation", "Observed agents are not chats."),
    snooze: unsupported("not-a-conversation", "Observed agents are not chats."),
    archive: unsupported("not-a-conversation", "Observed agents are not chats."),
    settle: unsupported("not-a-conversation", "Observed agents are not chats."),
    manage: unsupported("not-a-delegated-task", "Observed agents are not delegated tasks."),
    wake: unsupported("not-a-delegated-task", "Observed agents are not delegated tasks."),
  } as ObservedChildControlSet;
}

function observedChild(
  id: string,
  conversationId: string,
  turnId: string,
  overrides: Partial<ObservedChildThread> = {},
): ObservedChildThread {
  return {
    id,
    authority: "observed",
    transcript: "unavailable",
    parent: { conversationId, runId: `run-${turnId}`, turnId, parentTraceId: null },
    depth: 1,
    lineage: "complete",
    providerId: "claude",
    nativeRef: { taskId: `task-${id}`, agentId: null, toolUseId: null, strongest: "task" },
    role: null,
    name: `Agent ${id}`,
    description: "Work item",
    model: "fixture-model",
    status: "running",
    providerStatus: "in_progress",
    isLive: true,
    progress: null,
    result: null,
    truncated: { description: false, progress: false, result: false },
    usage: null,
    toolUseCount: null,
    durationMs: null,
    controls: observedControls({ supported: true, code: null, reason: null }),
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:01.000Z",
    ...overrides,
  };
}

function observedReadResult(conversationId: string, turnId: string, children: ObservedChildThread[]): ServerEvent {
  return resultEvent(observedChildReadResultSchema.parse({
    kind: "observed-child.read",
    conversationId,
    turnId,
    children,
    controls: Object.fromEntries(children.map((entry) => [entry.id, entry.controls])),
    omitted: 0,
    truncated: false,
  }));
}

afterEach(() => {
  cleanup();
  clearObservedAgentsDetailsState();
  clearDelegatedCompletionCardState();
  vi.restoreAllMocks();
});

describe("orchestration UI fixes (Bugs #1-#10)", () => {
  it("Bug #1: surfaces initial conversation.fork.history failure with alert and recovers on Retry", async () => {
    const run = vi.fn<ForkCommandRunner>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(forkHistoryPage(CONV_A, true));
    render(
      <ForkHistoryView surface={{
        projectId: PROJECT_ID,
        conversationId: CONV_A,
        run,
        rolledBack: new Set(),
        canRollBackToStart: false,
      }} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Inherited history could not be loaded.");
    const retry = screen.getByRole("button", { name: "Retry" });
    await userEvent.setup().click(retry);
    expect(await screen.findByText(/Inherited history · 1 items/u)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("Bug #2: keeps rollback and merge confirmation groups mounted and ignores Escape while busy", async () => {
    let finishRollback!: (event: ServerEvent) => void;
    let finishMerge!: (event: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>()
      .mockResolvedValueOnce(forkHistoryPage(CONV_A, true))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRollback = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishMerge = resolve; }));

    render(
      <ForkSurfaceProvider projectId={PROJECT_ID} conversationId={CONV_A} run={run}>
        <ForkHistoryView surface={{
          projectId: PROJECT_ID,
          conversationId: CONV_A,
          run,
          rolledBack: new Set(),
          canRollBackToStart: false,
        }} />
        <ForkTurnAction turnId={TURN_1} turnIndex={1} />
      </ForkSurfaceProvider>,
    );

    const user = userEvent.setup();
    const rollbackTrigger = await screen.findByRole("button", { name: "Roll back to here (Turn 1)" });
    await user.click(rollbackTrigger);
    const rollbackGroup = screen.getByRole("group", { name: "Confirm rollback" });
    await user.click(within(rollbackGroup).getByRole("button", { name: "Roll back context" }));

    expect(screen.getByRole("group", { name: "Confirm rollback" })).toBeInTheDocument();
    expect(within(rollbackGroup).getByRole("button", { name: "Rolling back…" })).toBeDisabled();
    expect(within(rollbackGroup).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(rollbackGroup, { key: "Escape" });
    expect(screen.getByRole("group", { name: "Confirm rollback" })).toBeInTheDocument();

    await act(async () => finishRollback({
      type: "request.result",
      requestId: "r1",
      result: {
        kind: "conversation.rollback",
        conversationId: CONV_A,
        rollbackId: "rb-1",
        retainedTurnId: TURN_1,
        rolledBackTurns: 1,
        transfer: "native",
        reason: null,
        files: { outcome: "unchanged", message: null },
      },
    } as ServerEvent));
    expect(screen.getByRole("button", { name: "Roll back to here (Turn 1)" })).toHaveFocus();

    const mergeTrigger = screen.getByRole("button", { name: "Merge findings up to here (Turn 1)" });
    await user.click(mergeTrigger);
    const mergeGroup = screen.getByRole("group", { name: "Confirm merge" });
    await user.click(within(mergeGroup).getByRole("button", { name: "Merge findings" }));

    expect(screen.getByRole("group", { name: "Confirm merge" })).toBeInTheDocument();
    expect(within(mergeGroup).getByRole("button", { name: "Merging…" })).toBeDisabled();
    expect(within(mergeGroup).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(mergeGroup, { key: "Escape" });
    expect(screen.getByRole("group", { name: "Confirm merge" })).toBeInTheDocument();

    await act(async () => finishMerge({
      type: "request.result",
      requestId: "r2",
      result: {
        kind: "conversation.merge-back",
        forkConversationId: CONV_A,
        parentConversationId: CONV_B,
        mergeBackId: "mb-1",
        packetId: "pkt-1",
        messageCount: 2,
        omittedMessageCount: 0,
        turnCount: 1,
        throughTurnId: TURN_1,
        requestedThroughTurnId: TURN_1,
        summary: { commandCount: 0, fileCount: 0, truncated: false },
      },
    } as ServerEvent));
    expect(screen.getByRole("button", { name: "Merge findings up to here (Turn 1)" })).toHaveFocus();
  });

  it("Bug #3: resets cancel confirmation and restores focus to the row when task leaves running, and keeps confirmation open on cancel error", async () => {
    const run = vi.fn<DelegationCommandRunner>();
    const renderPanel = (tasks: ReturnType<typeof summary>[]) => (
      <DelegationLineage surface={{
        conversationId: PARENT_ID,
        delegation: parentDelegation(tasks),
        conversations: undefined,
        run,
        openConversation: () => true,
      }} />
    );

    const view = render(renderPanel([summary(1)]));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel task: Task 1" }));
    expect(screen.getByRole("button", { name: "Cancel task" })).toHaveFocus();

    // Error keeps confirmation open with inline alert instead of silently closing.
    run.mockRejectedValueOnce(new RuntimeCommandError("Cancellation refused.", "rejected"));
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cancellation refused.");
    expect(screen.getByRole("group", { name: "Confirm cancelling Task 1" })).toBeInTheDocument();

    // Focus stays inside confirmation, then task completes: focus restores to the task <li>, not document.body.
    screen.getByRole("button", { name: "Keep running" }).focus();
    view.rerender(renderPanel([finished(1)]));
    const taskRow = screen.getByText("Task 1", { selector: "strong" }).closest("li")!;
    expect(taskRow).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);

    // If task becomes running again, stale confirming state must not re-open the confirmation group.
    view.rerender(renderPanel([summary(1)]));
    expect(screen.queryByRole("group", { name: "Confirm cancelling Task 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel task: Task 1" })).toBeInTheDocument();
  });

  it("Bug #4: does not tear down subscribe or send login.cancel when online status transitions", async () => {
    const listeners = new Set<(event: ServerEvent) => void>();
    const subscribe = vi.fn((listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => {
      if (command.type === "provider.cursor-sdk.status") {
        return {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "provider.cursor-sdk.status", available: true, hasCredential: false, sdkVersion: "1.0.38" },
        };
      }
      return { type: "request.ok", requestId: command.requestId };
    });

    let latest!: ReturnType<typeof useCursorSdkAccount>;
    function Harness({ transport }: { transport: CursorSdkTransport }) {
      latest = useCursorSdkAccount(transport);
      return null;
    }

    const view = render(<Harness transport={{ status: "online", sendCommand, subscribe }} />);
    expect(subscribe).toHaveBeenCalledTimes(1);

    await act(async () => { await latest.check(); });
    act(() => { latest.start(); });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "provider.cursor-sdk.login" }));

    view.rerender(<Harness transport={{ status: "offline", sendCommand, subscribe }} />);
    view.rerender(<Harness transport={{ status: "online", sendCommand, subscribe }} />);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls.some(([cmd]) => cmd.type === "provider.cursor-sdk.login.cancel")).toBe(false);

    // Starting a new login and unmounting still sends login.cancel on real unmount.
    await act(async () => { await latest.check(); });
    act(() => { latest.start(); });
    view.unmount();
    expect(sendCommand.mock.calls.some(([cmd]) => cmd.type === "provider.cursor-sdk.login.cancel")).toBe(true);
  });

  it("Bug #5: persists expanded state across remounts and fires scroll-anchor callbacks on ObservedAgentsDetails and DelegatedCompletionCard", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
    const run = vi.fn<DelegationCommandRunner>().mockResolvedValue(observedReadResult(CONV_A, TURN_1, []));
    const onBefore = vi.fn();
    const onAfter = vi.fn();

    const observedView = render(
      <DelegationSurfaceProvider conversationId={CONV_A} delegation={undefined} conversations={undefined}
        run={run} openConversation={undefined}>
        <ObservedAgentsDetails conversationId={CONV_A} turnId={TURN_1} turnIndex={1}
          onBeforeToggle={onBefore} onAfterToggle={onAfter} />
      </DelegationSurfaceProvider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Agent details" }));
    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(onAfter).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Hide agent details" })).toHaveAttribute("aria-expanded", "true");

    // Simulate virtualized scroll off-screen (unmount) and back on-screen (remount).
    observedView.unmount();
    render(
      <DelegationSurfaceProvider conversationId={CONV_A} delegation={undefined} conversations={undefined}
        run={run} openConversation={undefined}>
        <ObservedAgentsDetails conversationId={CONV_A} turnId={TURN_1} turnIndex={1} />
      </DelegationSurfaceProvider>,
    );
    expect(screen.getByRole("button", { name: "Hide agent details" })).toHaveAttribute("aria-expanded", "true");

    cleanup();
    const message: ChatMessage = {
      id: "msg-completion-1",
      conversationId: PARENT_ID,
      turnId: TURN_1,
      role: "user",
      content: "Delegated task finished.",
      attachments: [],
      createdAt: "2026-10-31T10:00:00.000Z",
      delegatedCompletion: { parentConversationId: PARENT_ID, generation: 1, taskIds: [taskId(1)] },
    };
    const cardView = render(
      <DelegationSurfaceProvider conversationId={PARENT_ID} delegation={parentDelegation([finished(1, { title: "Audit parser" })])}
        conversations={undefined} run={undefined} openConversation={undefined}>
        <DelegatedCompletionCard message={message} turnId={TURN_1} />
      </DelegationSurfaceProvider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /^Show results:/u }));
    expect(screen.getByRole("button", { name: /^Hide results:/u })).toHaveAttribute("aria-expanded", "true");

    cardView.unmount();
    render(
      <DelegationSurfaceProvider conversationId={PARENT_ID} delegation={parentDelegation([finished(1, { title: "Audit parser" })])}
        conversations={undefined} run={undefined} openConversation={undefined}>
        <DelegatedCompletionCard message={message} turnId={TURN_1} />
      </DelegationSurfaceProvider>,
    );
    expect(screen.getByRole("button", { name: /^Hide results:/u })).toHaveAttribute("aria-expanded", "true");
    raf.mockRestore();
  });

  it("Bug #6: ObservedChildView resets stale children on turn change, offers Retry on failure, guards stop unmount, and falls back on empty stop.reason", async () => {
    let finishTurn2!: (event: ServerEvent) => void;
    let finishStop!: (event: ServerEvent) => void;
    const emptyReasonChild = observedChild("trace-empty", CONV_A, TURN_1, {
      name: "Silent agent",
      controls: observedControls({ supported: false, code: "provider-unsupported", reason: "   " } as never),
    });
    const stoppableChild = observedChild("trace-stop", CONV_A, TURN_1, { name: "Running agent" });

    const run = vi.fn<DelegationCommandRunner>()
      .mockRejectedValueOnce(new Error("Temporary read failure"))
      .mockResolvedValueOnce(observedReadResult(CONV_A, TURN_1, [emptyReasonChild, stoppableChild]))
      .mockImplementationOnce(() => new Promise((resolve) => { finishTurn2 = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishStop = resolve; }));

    const view = render(<ObservedChildView conversationId={CONV_A} turnId={TURN_1} run={run} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary read failure");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "Silent agent" })).toHaveTextContent(
      "Stop unavailable: This provider does not support stopping individual agents.",
    );

    // Changing turnId immediately clears stale children from TURN_1 while TURN_2 loads.
    view.rerender(<ObservedChildView conversationId={CONV_A} turnId={TURN_2} run={run} />);
    expect(screen.queryByRole("article", { name: "Silent agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading agents…");

    const turn2Child = observedChild("trace-turn-2", CONV_A, TURN_2, { name: "Turn 2 agent" });
    await act(async () => finishTurn2(observedReadResult(CONV_A, TURN_2, [turn2Child])));
    expect(await screen.findByRole("article", { name: "Turn 2 agent" })).toBeInTheDocument();

    // Unmounting mid-stop must not trigger a post-unmount reread.
    await user.click(screen.getByRole("button", { name: "Stop Turn 2 agent" }));
    const callsBeforeUnmount = run.mock.calls.length;
    view.unmount();
    await act(async () => finishStop(resultEvent({ kind: "agent.subagent.stop" })));
    expect(run).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it("Bug #7: FullResult invalidates cache on resultTurnId change and guards rapid toggle races", async () => {
    let resolveFirst!: (event: ServerEvent) => void;
    let resolveSecond!: (event: ServerEvent) => void;
    const run = vi.fn<DelegationCommandRunner>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }))
      .mockResolvedValueOnce(resultEvent({
        kind: "delegation.task",
        task: {
          taskId: taskId(1),
          result: { turnId: "turn-new", status: "completed", text: "Updated result text", truncated: false, neutralized: false },
        },
      }));

    const taskV1 = finished(1, { resultTurnId: "turn-old" });
    const renderPanel = (task: typeof taskV1) => (
      <DelegationLineage surface={{
        conversationId: PARENT_ID,
        delegation: parentDelegation([task]),
        conversations: undefined,
        run,
        openConversation: undefined,
      }} />
    );

    const view = render(renderPanel(taskV1));
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Full result of Task 1" });

    // Rapid open -> close -> reopen: stale first response must not overwrite second response.
    await user.click(toggle);
    await user.click(toggle);
    await user.click(toggle);
    expect(run).toHaveBeenCalledTimes(2);

    await act(async () => resolveSecond(resultEvent({
      kind: "delegation.task",
      task: {
        taskId: taskId(1),
        result: { turnId: "turn-old", status: "completed", text: "Fresh response #2", truncated: false, neutralized: false },
      },
    })));
    expect(await screen.findByText("Fresh response #2")).toBeInTheDocument();

    await act(async () => resolveFirst(resultEvent({
      kind: "delegation.task",
      task: {
        taskId: taskId(1),
        result: { turnId: "turn-old", status: "completed", text: "Stale response #1", truncated: false, neutralized: false },
      },
    })));
    expect(screen.getByText("Fresh response #2")).toBeInTheDocument();
    expect(screen.queryByText("Stale response #1")).not.toBeInTheDocument();

    // Changing resultTurnId invalidates cached text and fetches the new result.
    view.rerender(renderPanel(finished(1, { resultTurnId: "turn-new" })));
    expect(await screen.findByText("Updated result text")).toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("Bug #8: StartRollbackConfirmation does not steal focus after unmounting mid-flight", async () => {
    let finishRollback!: (event: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>()
      .mockResolvedValueOnce(forkHistoryPage(CONV_A, false))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRollback = resolve; }));

    const view = render(
      <>
        <button type="button">Return target</button>
        <button type="button">Other chat control</button>
        <ForkHistoryView surface={{
          projectId: PROJECT_ID,
          conversationId: CONV_A,
          run,
          rolledBack: new Set(),
          canRollBackToStart: true,
        }} />
      </>,
    );

    const returnTarget = screen.getByRole("button", { name: "Return target" });
    const otherControl = screen.getByRole("button", { name: "Other chat control" });
    act(() => { requestStartRollback(CONV_A, returnTarget); });

    const confirmButton = await screen.findByRole("button", { name: "Roll back context" });
    await userEvent.setup().click(confirmButton);

    // User switches chats (unmounts ForkHistoryView) and focuses another control before rollback settles.
    view.rerender(
      <>
        <button type="button">Return target</button>
        <button type="button">Other chat control</button>
      </>,
    );
    otherControl.focus();
    expect(otherControl).toHaveFocus();

    await act(async () => finishRollback({
      type: "request.result",
      requestId: "r-start",
      result: {
        kind: "conversation.rollback",
        conversationId: CONV_A,
        rollbackId: "rb-start",
        retainedTurnId: null,
        rolledBackTurns: 1,
        transfer: "native",
        reason: null,
        files: { outcome: "unchanged", message: null },
      },
    } as ServerEvent));

    expect(otherControl).toHaveFocus();
    expect(returnTarget).not.toHaveFocus();
  });

  it("Bug #9: repeated per-turn and per-card buttons expose distinct accessible names while preserving visible text", async () => {
    const run = vi.fn<ForkCommandRunner>().mockResolvedValue(forkHistoryPage(CONV_A, true));
    render(
      <ForkSurfaceProvider projectId={PROJECT_ID} conversationId={CONV_A} run={run}>
        <ForkHistoryView surface={{
          projectId: PROJECT_ID,
          conversationId: CONV_A,
          run,
          rolledBack: new Set(),
          canRollBackToStart: false,
        }} />
        <ForkTurnAction turnId={TURN_1} turnIndex={1} />
        <ForkTurnAction turnId={TURN_2} turnIndex={2} />
      </ForkSurfaceProvider>,
    );

    const fork1 = await screen.findByRole("button", { name: "Fork from here (Turn 1)" });
    const fork2 = screen.getByRole("button", { name: "Fork from here (Turn 2)" });
    expect(fork1).toHaveTextContent("Fork from here");
    expect(fork2).toHaveTextContent("Fork from here");

    const rb1 = await screen.findByRole("button", { name: "Roll back to here (Turn 1)" });
    const rb2 = screen.getByRole("button", { name: "Roll back to here (Turn 2)" });
    expect(rb1).toHaveTextContent("Roll back to here");
    expect(rb2).toHaveTextContent("Roll back to here");

    const merge1 = await screen.findByRole("button", { name: "Merge findings up to here (Turn 1)" });
    const merge2 = screen.getByRole("button", { name: "Merge findings up to here (Turn 2)" });
    expect(merge1).toHaveTextContent("Merge findings up to here");
    expect(merge2).toHaveTextContent("Merge findings up to here");

    const msg1: ChatMessage = {
      id: "msg-1",
      conversationId: PARENT_ID,
      turnId: TURN_1,
      role: "user",
      content: 'Delegated task "Audit parser" finished',
      attachments: [],
      createdAt: "2026-10-31T10:00:00.000Z",
      delegatedCompletion: { parentConversationId: PARENT_ID, generation: 1, taskIds: [taskId(1)] },
    };
    const msg2: ChatMessage = {
      id: "msg-2",
      conversationId: PARENT_ID,
      turnId: TURN_2,
      role: "user",
      content: 'Delegated task "Write tests" failed',
      attachments: [],
      createdAt: "2026-10-31T10:05:00.000Z",
      delegatedCompletion: { parentConversationId: PARENT_ID, generation: 2, taskIds: [taskId(2)] },
    };
    render(
      <DelegationSurfaceProvider conversationId={PARENT_ID} delegation={parentDelegation([
        finished(1, { title: "Audit parser" }),
        finished(2, { title: "Write tests", status: "failed" }),
      ])} conversations={undefined} run={undefined} openConversation={undefined}>
        <DelegatedCompletionCard message={msg1} turnId={TURN_1} />
        <DelegatedCompletionCard message={msg2} turnId={TURN_2} />
      </DelegationSurfaceProvider>,
    );
    const show1 = screen.getByRole("button", { name: 'Show results: Delegated task "Audit parser" finished' });
    const show2 = screen.getByRole("button", { name: 'Show results: Delegated task "Write tests" failed' });
    expect(show1).toHaveTextContent("Show results");
    expect(show2).toHaveTextContent("Show results");
  });

  it("Bug #10: Private Connect banners have proper ARIA roles and CSS meets focus, contrast, forced-colors, and reduced-motion rules", () => {
    const shell: Shell = {
      generatedAt: "2030-01-01T00:00:00.000Z",
      projects: [],
      conversations: [],
      capabilities: { scopes: ["private:read"], preset: "monitor", expiresAt: "2030-02-01T00:00:00.000Z" },
    };
    const detail: Detail = {
      generatedAt: "2030-01-01T00:00:00.000Z",
      conversation: {
        id: CONV_A,
        projectId: PROJECT_ID,
        title: "Desktop approval",
        providerLabel: "Codex",
        runId: null,
        status: "needs-input",
        pendingLocalApproval: true,
        pendingLocalAction: true,
        updatedAt: "2030-01-01T00:00:00.000Z",
      },
      messages: [],
      questions: [],
      waitingForLocalAction: true,
    };

    const noop = () => undefined;
    render(
      <WorkspaceShell
        shell={shell}
        detail={detail}
        error="Connection failed."
        prompt=""
        busy={false}
        offline={false}
        selectedConversation={CONV_A}
        messagesRef={{ current: null }}
        onSelectConversation={noop}
        onScrollIntent={noop}
        onPromptChange={noop}
        onSendPrompt={noop}
        onAnswer={noop}
        onStopRun={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Connection failed.");
    expect(screen.getByRole("status")).toHaveTextContent("This conversation needs an action on the desktop.");

    // Direct ConversationPane render also exposes role="status" on waitingForLocalAction.
    cleanup();
    render(
      <ConversationPane
        shell={shell}
        detail={detail}
        prompt=""
        busy={false}
        offline={false}
        messagesRef={{ current: null }}
        onScrollIntent={noop}
        onPromptChange={noop}
        onSendPrompt={noop}
        onAnswer={noop}
        onStopRun={noop}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Secrets and approvals stay local.");

    const forkCss = readFileSync(
      resolve(process.cwd(), "src/renderer/src/components/orchestration/fork-surface.css"),
      "utf8",
    );
    expect(forkCss).toMatch(/\.history-turn-action:disabled\b/u);
    const opacityMatch = forkCss.match(/\.response-turn\.is-rolled-back\s*>\s*:not\(\.turn-supporting-ledger\)\s*\{[^}]*opacity:\s*([0-9.]+)/u);
    expect(opacityMatch).not.toBeNull();
    expect(Number(opacityMatch![1])).toBeGreaterThanOrEqual(0.78);

    const delegationCss = readFileSync(
      resolve(process.cwd(), "src/renderer/src/components/orchestration/delegation-panel.css"),
      "utf8",
    );
    expect(delegationCss).toMatch(/\.delegation-task:focus-visible\s*\{[^}]*var\(--focus-ring\)/u);
    expect(delegationCss).toMatch(/@media\s*\(forced-colors:\s*active\)\s*\{\s*\.delegation-chip::before\s*\{[^}]*CanvasText/u);
    expect(delegationCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[^}]*\.delegated-completion-toggle svg[^}]*transition:\s*none/su);
  });
});

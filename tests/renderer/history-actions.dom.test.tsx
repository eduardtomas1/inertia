import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationActionsMenu } from "../../src/renderer/src/components/ConversationActionsMenu";
import { ForkHistoryPanel, ForkSurfaceProvider, ForkTurnAction, type ForkCommandRunner } from "../../src/renderer/src/components/orchestration/fork-surface";
import { UserRequestLayer } from "../../src/renderer/src/components/response-timeline/layers";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/response-timeline/types";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import type { ResponseTurn } from "../../src/renderer/src/utils/response-timeline/model";
import type { CheckpointSummary, Conversation, ServerEvent, WorkspaceRun } from "../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import { forkHistoryResultSchema } from "../../src/shared/orchestration-forks";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const laterTurnId = "55555555-5555-4555-8555-555555555555";
const forkId = "66666666-6666-4666-8666-666666666666";
const startId = "77777777-7777-4777-8777-777777777777";
const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test" });
const quiet = { reportError: false };

function event(result: unknown): ServerEvent {
  return { type: "request.result", requestId: "request", result } as ServerEvent;
}

function lineagePage(id: string, fork: boolean): ServerEvent {
  return event(forkHistoryResultSchema.parse({ kind: "conversation.fork.history", conversationId: id, next: null, parts: [],
    lineage: fork ? { threadId: id, projectId, parentThreadId: sourceId, rootThreadId: sourceId, sourceRunId: "source-run",
      sourceTurnId: turnId, sourceWorkspaceKey: "/test", sourceProviderId: "codex", sourceSelection: selection,
      sourceIdentity: continuationIdentityForSelection(selection), nativeBoundary: null, inheritedItems: 0, inheritedParts: 0,
      transfer: "portable", createdAt: "2026-10-30T10:00:00.000Z" } : null }));
}

function rollbackResult(overrides: Record<string, unknown> = {}): ServerEvent {
  return event({ kind: "conversation.rollback", conversationId, rollbackId: "rollback-1", retainedTurnId: turnId,
    rolledBackTurns: 2, transfer: "portable", reason: "unsupported", files: { outcome: "unchanged", message: null }, ...overrides });
}

function mergeResult(id: string, turnCount = 2, requestedThroughTurnId: string | null = null): ServerEvent {
  return event({ kind: "conversation.merge-back", forkConversationId: id, parentConversationId: sourceId,
    mergeBackId: "merge-1", packetId: "packet-1", messageCount: 4, omittedMessageCount: 0, turnCount,
    throughTurnId: turnId, requestedThroughTurnId, summary: { commandCount: 0, fileCount: 0, truncated: false } });
}

const chat: Conversation = {
  id: startId, projectId, title: "Release parser plan", providerId: "codex", modelSelection: selection,
  continuationIdentity: null, model: "", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
  status: "idle", attentionKind: null, branch: null, worktreePath: null, providerSessionId: null, archivedAt: null,
  settledAt: null, completedAt: null, lastViewedAt: null, createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
} as Conversation;

function ChatMenu({ runs = [] }: { runs?: readonly WorkspaceRun[] }) {
  const noOp = () => undefined;
  return <ConversationActionsMenu activeConversationId={startId} activity={false} conversation={chat} runs={runs}
    splitConversationIds={new Set()} thread={{ conversation: chat, run: null, status: "idle", needsAttention: false,
      unread: false, hidden: false, settled: false }}
    onAcknowledgeRun={noOp} onCloseConversationSplit={noOp} onDismiss={noOp} onDismissRun={noOp} onPinConversation={noOp}
    onRestoreConversation={noOp} onSetPopover={noOp} onSettleConversation={noOp} onSnoozeConversation={noOp}
    onStartRename={noOp} />;
}

afterEach(cleanup);

describe("history rollback and merge-back controls", () => {
  it("confirms a rollback by keyboard with an opt-in file restore, restores focus on Escape and reports both outcomes", async () => {
    let complete!: (value: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>(() => new Promise((resolve) => { complete = resolve; }));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}>
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "Roll back to here" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const confirmation = screen.getByRole("group", { name: "Confirm rollback" });
    expect(confirmation).toHaveTextContent("Workspace files are not changed.");
    const toggle = within(confirmation).getByRole("checkbox", { name: "Also restore files to this point" });
    expect(toggle).not.toBeChecked();
    expect(within(confirmation).getByRole("button", { name: "Roll back context" })).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(toggle).toHaveFocus();
    await user.keyboard(" ");
    expect(toggle).toBeChecked();
    expect(confirmation).toHaveTextContent("Files changed by later turns are restored when it is safe.");
    expect(within(confirmation).getByRole("button", { name: "Roll back context and files" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Confirm rollback" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Roll back to here" })).toHaveFocus();
    expect(run).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("checkbox", { name: "Also restore files to this point" })).not.toBeChecked();
    await user.keyboard("{Shift>}{Tab}{/Shift} {Tab}");
    expect(screen.getByRole("button", { name: "Roll back context and files" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledExactlyOnceWith("conversation.rollback", { type: "conversation.rollback",
      payload: { conversationId, turnId, restoreFiles: true } }, quiet);
    expect(screen.getByRole("button", { name: "Rolling back…" })).toBeDisabled();
    await act(async () => complete(rollbackResult({ files: { outcome: "restored", message: null } })));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Rolled back 2 later turns. The next message starts a fresh provider session with the retained history. Files restored.");
    expect(screen.getByText("Files restored", { exact: true })).toHaveClass("history-files-restored");
    expect(screen.getByRole("button", { name: "Roll back to here" })).toHaveFocus();
  });

  it.each([
    ["native", { outcome: "unchanged", message: null },
      "Rolled back 2 later turns. The provider session continues from this turn. Files unchanged.", false],
    ["portable", { outcome: "unchanged", message: "Files were not restored. The chat history was rolled back without them." },
      "Rolled back 2 later turns. The next message starts a fresh provider session with the retained history. Files unchanged. "
        + "Files were not restored. The chat history was rolled back without them.", false],
    ["portable", { outcome: "restored", message: null },
      "Rolled back 2 later turns. The next message starts a fresh provider session with the retained history. Files restored.", false],
    ["native", { outcome: "refused", message: "Unrelated changes in src/parser.ts would be overwritten." },
      "Rolled back 2 later turns. The provider session continues from this turn. Files were not restored: Unrelated changes in src/parser.ts would be overwritten.", true],
    ["portable", { outcome: "failed", message: "git checkout exited with code 128." },
      "Rolled back 2 later turns. The next message starts a fresh provider session with the retained history. Restoring files failed: git checkout exited with code 128.", true],
  ] as const)("states the %s continuation and the %o files outcome in the live result", async (transfer, files, text, warning) => {
    const run = vi.fn<ForkCommandRunner>().mockResolvedValue(rollbackResult({ transfer, files }));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}>
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Roll back to here" }));
    const restore = files.outcome !== "unchanged" || files.message !== null;
    if (restore) await user.click(screen.getByRole("checkbox", { name: "Also restore files to this point" }));
    await user.click(screen.getByRole("button", { name: restore ? "Roll back context and files" : "Roll back context" }));
    expect(run).toHaveBeenCalledWith("conversation.rollback", { type: "conversation.rollback",
      payload: { conversationId, turnId, restoreFiles: restore } }, quiet);
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(text);
    expect(status.querySelector(".history-notice") !== null).toBe(warning);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Files restored", { exact: true }) !== null).toBe(files.outcome === "restored");
  });

  it("shows a server refusal verbatim as an inline notice without a result", async () => {
    const refusal = "Another fork of this chat is rolling back. Try again when it finishes.";
    const run = vi.fn<ForkCommandRunner>().mockRejectedValue(new RuntimeCommandError(refusal, "rejected"));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}>
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Roll back to here" }));
    await user.click(screen.getByRole("button", { name: "Roll back context" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(refusal, { normalizeWhitespace: false });
    expect(notice.textContent).toBe(refusal);
    expect(notice).toHaveClass("history-notice");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Roll back to here" })).toHaveFocus();
  });

  it("marks rolled-back turns without offering fork, rollback or merge actions", async () => {
    const run = vi.fn<ForkCommandRunner>().mockResolvedValue(lineagePage(forkId, true));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={forkId} run={run} rolledBackTurnIds={[laterTurnId]}>
      <ForkHistoryPanel />
      <ForkTurnAction turnId={laterTurnId} />
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    expect(await screen.findAllByRole("button", { name: "Merge findings up to here" })).toHaveLength(1);
    expect(screen.getByText("Rolled back · not in context")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fork from here" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Roll back to here" })).toHaveLength(1);
  });

  it("merges a fork's findings up to a footer turn with a two-step keyboard confirmation", async () => {
    let complete!: (value: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>().mockResolvedValueOnce(lineagePage(forkId, true))
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockRejectedValueOnce(new RuntimeCommandError("The source chat is running. Merge findings when it finishes.", "rejected"));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={forkId} run={run}>
      <ForkHistoryPanel />
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "Merge findings up to here" });
    expect(screen.getByRole("button", { name: "Merge findings into source chat" })).toBeInTheDocument();
    trigger.focus();
    await user.keyboard("{Enter}");
    const confirmation = screen.getByRole("group", { name: "Confirm merge" });
    expect(confirmation).toHaveTextContent("Findings from this fork up to this turn are attached to the source chat's next message.");
    expect(within(confirmation).getByRole("button", { name: "Merge findings" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Confirm merge" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge findings up to here" })).toHaveFocus();
    expect(run).toHaveBeenCalledTimes(1);

    await user.keyboard("{Enter}{Enter}");
    expect(run).toHaveBeenLastCalledWith("conversation.merge-back", { type: "conversation.merge-back",
      payload: { forkConversationId: forkId, throughTurnId: turnId } }, quiet);
    expect(screen.getByRole("button", { name: "Merging…" })).toBeDisabled();
    await act(async () => complete(mergeResult(forkId, 1, turnId)));
    expect(screen.getByRole("status")).toHaveTextContent("Attached 4 messages from 1 turn to the source chat's next message.");
    expect(screen.getByRole("button", { name: "Merge findings up to here" })).toHaveFocus();

    await user.keyboard("{Enter}{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("The source chat is running. Merge findings when it finishes.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers no merge-up-to-here action outside forks", async () => {
    const run = vi.fn<ForkCommandRunner>().mockResolvedValue(lineagePage(conversationId, false));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}>
      <ForkHistoryPanel />
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    await screen.findByRole("button", { name: "Roll back to here" });
    expect(run).toHaveBeenCalledWith("conversation.fork.history", expect.anything());
    expect(screen.queryByRole("button", { name: "Merge findings up to here" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge findings into source chat" })).not.toBeInTheDocument();
  });

  it("merges a fork's findings into its source chat and rejects a confirmation for another fork", async () => {
    const run = vi.fn<ForkCommandRunner>().mockResolvedValueOnce(lineagePage(conversationId, true))
      .mockResolvedValueOnce(mergeResult(conversationId))
      .mockResolvedValueOnce(mergeResult(sourceId, 1));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}><ForkHistoryPanel /></ForkSurfaceProvider>);
    const user = userEvent.setup();
    const merge = await screen.findByRole("button", { name: "Merge findings into source chat" });
    await user.click(merge);
    expect(run).toHaveBeenLastCalledWith("conversation.merge-back", { type: "conversation.merge-back",
      payload: { forkConversationId: conversationId } }, quiet);
    expect(await screen.findByRole("status")).toHaveTextContent("Attached 4 messages from 2 turns to the source chat's next message.");
    await user.click(merge);
    expect(await screen.findByRole("alert")).toHaveTextContent("The merge-back belongs to another fork.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("rollback to chat start", () => {
  it("is offered from the chat actions menu and confirms inline with the files toggle", async () => {
    let complete!: (value: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>().mockResolvedValueOnce(lineagePage(startId, false))
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const view = render(<>
      <button type="button" aria-controls={`conversation-actions-${startId}`}>Chat actions</button>
      <ForkSurfaceProvider projectId={projectId} conversationId={startId} run={run} canRollBackToStart>
        <div className="message-scroll" tabIndex={0}><ForkHistoryPanel /></div>
      </ForkSurfaceProvider>
      <ChatMenu />
    </>);
    const user = userEvent.setup();
    const entry = await screen.findByRole("menuitem", { name: "Roll back to chat start…" });
    await user.click(entry);
    const confirmation = await screen.findByRole("group", { name: "Confirm rollback to chat start" });
    expect(confirmation).toHaveTextContent("Every turn stays visible but leaves this chat's context. Workspace files are not changed.");
    expect(within(confirmation).getByRole("button", { name: "Roll back context" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Confirm rollback to chat start" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat actions" })).toHaveFocus();
    expect(run).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("menuitem", { name: "Roll back to chat start…" }));
    await screen.findByRole("group", { name: "Confirm rollback to chat start" });
    await user.keyboard("{Shift>}{Tab}{/Shift} ");
    expect(screen.getByRole("group", { name: "Confirm rollback to chat start" }))
      .toHaveTextContent("Files changed in this chat are restored when it is safe.");
    await user.keyboard("{Tab}{Enter}");
    expect(run).toHaveBeenLastCalledWith("conversation.rollback", { type: "conversation.rollback",
      payload: { conversationId: startId, turnId: null, restoreFiles: true } }, quiet);
    expect(screen.getByRole("button", { name: "Rolling back…" })).toBeDisabled();
    await act(async () => complete(rollbackResult({ conversationId: startId, retainedTurnId: null, transfer: "native",
      files: { outcome: "failed", message: "The workspace is locked by another process." } })));
    const region = screen.getByRole("region", { name: "Chat start rollback" });
    expect(within(region).getByRole("status")).toHaveTextContent("Rolled back 2 turns to the chat start. The provider session "
      + "continues from the chat start. Restoring files failed: The workspace is locked by another process.");
    expect(region.querySelector(".history-notice")).toHaveTextContent("Restoring files failed:");
    expect(screen.queryByRole("group", { name: "Confirm rollback to chat start" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat actions" })).toHaveFocus();

    view.rerender(<>
      <button type="button" aria-controls={`conversation-actions-${startId}`}>Chat actions</button>
      <ForkSurfaceProvider projectId={projectId} conversationId={startId} run={run} canRollBackToStart={false}>
        <div className="message-scroll" tabIndex={0}><ForkHistoryPanel /></div>
      </ForkSurfaceProvider>
      <ChatMenu />
    </>);
    expect(screen.queryByRole("menuitem", { name: "Roll back to chat start…" })).not.toBeInTheDocument();
  });

  it("is not offered while the chat has active work and shows a refusal inline", async () => {
    const refusal = "This chat is part of a Duo session. Roll back from the Duo controls.";
    const run = vi.fn<ForkCommandRunner>().mockResolvedValueOnce(lineagePage(startId, false))
      .mockRejectedValueOnce(new RuntimeCommandError(refusal, "rejected"));
    const running = { id: "run-1", conversationId: startId, status: "running" } as WorkspaceRun;
    const view = render(<>
      <ForkSurfaceProvider projectId={projectId} conversationId={startId} run={run} canRollBackToStart>
        <div className="message-scroll" tabIndex={0}><ForkHistoryPanel /></div>
      </ForkSurfaceProvider>
      <ChatMenu runs={[running]} />
    </>);
    await screen.findByRole("menuitem", { name: "Pin thread" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Roll back to chat start…" })).not.toBeInTheDocument();
    view.rerender(<>
      <ForkSurfaceProvider projectId={projectId} conversationId={startId} run={run} canRollBackToStart>
        <div className="message-scroll" tabIndex={0}><ForkHistoryPanel /></div>
      </ForkSurfaceProvider>
      <ChatMenu />
    </>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("menuitem", { name: "Roll back to chat start…" }));
    await user.click(await screen.findByRole("button", { name: "Roll back context" }));
    const notice = await within(screen.getByRole("region", { name: "Chat start rollback" })).findByRole("alert");
    expect(notice.textContent).toBe(refusal);
    expect(view.container.querySelector(".message-scroll")).toHaveFocus();
  });
});

describe("checkpoint revert for rolled-back turns", () => {
  const checkpoint = (id: string, label: string): CheckpointSummary => ({ id, conversationId, turnId, ref: `refs/inertia/${id}`,
    label, turnIndex: 1, filesChanged: 1, insertions: 1, deletions: 0, createdAt: "2026-10-30T10:00:00.000Z" });
  const own = checkpoint("checkpoint-own", "Before turn");
  const recovery = checkpoint("checkpoint-recovery", "Before file restore");
  const turn = { id: turnId, checkpoint: own, extraCheckpoints: [recovery], checkpointUnavailableReason: null, providerChanged: false,
    watcherWake: null, userMessage: { id: "message-1", conversationId, role: "user", content: "Change the parser", attachments: [] },
    agentTurn: { id: turnId, checkpointId: own.id, sessionRecovery: null, continuationReasonCode: null } } as unknown as ResponseTurn;

  function Layer({ rolledBackTurnIds, onRevertCheckpoint }: { rolledBackTurnIds: readonly string[];
    onRevertCheckpoint: (checkpoint: CheckpointSummary) => void }) {
    const props = { conversationId, contextPackets: [], checkpointRestoreDisabled: false, onRevertCheckpoint } as unknown as ResponseTimelineProps;
    return <ForkSurfaceProvider projectId={projectId} conversationId={conversationId} rolledBackTurnIds={rolledBackTurnIds}>
      <UserRequestLayer turn={turn} props={props} />
    </ForkSurfaceProvider>;
  }

  it("hides the turn's own revert once the turn is rolled back and keeps its recovery checkpoint restorable", async () => {
    const revert = vi.fn();
    const view = render(<Layer rolledBackTurnIds={[]} onRevertCheckpoint={revert} />);
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
    view.rerender(<Layer rolledBackTurnIds={[turnId]} onRevertCheckpoint={revert} />);
    expect(screen.queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Restore checkpoint: Before file restore" }));
    expect(revert).toHaveBeenCalledExactlyOnceWith(recovery);
  });
});

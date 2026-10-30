import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForkHistoryPanel, ForkSurfaceProvider, ForkTurnAction, type ForkCommandRunner } from "../../src/renderer/src/components/orchestration/fork-surface";
import type { ServerEvent } from "../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import { forkHistoryResultSchema } from "../../src/shared/orchestration-forks";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const laterTurnId = "55555555-5555-4555-8555-555555555555";
const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test" });

function event(result: unknown): ServerEvent {
  return { type: "request.result", requestId: "request", result } as ServerEvent;
}

const history = event(forkHistoryResultSchema.parse({ kind: "conversation.fork.history", conversationId, next: null, parts: [],
  lineage: { threadId: conversationId, projectId, parentThreadId: sourceId, rootThreadId: sourceId, sourceRunId: "source-run",
    sourceTurnId: turnId, sourceWorkspaceKey: "/test", sourceProviderId: "codex", sourceSelection: selection,
    sourceIdentity: continuationIdentityForSelection(selection), nativeBoundary: null, inheritedItems: 0, inheritedParts: 0,
    transfer: "portable", createdAt: "2026-10-30T10:00:00.000Z" } }));

afterEach(cleanup);

describe("history rollback and merge-back controls", () => {
  it("confirms a rollback by keyboard, restores focus on Escape and reports the retained turn honestly", async () => {
    let complete!: (value: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>(() => new Promise((resolve) => { complete = resolve; }));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}>
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "Roll back to here" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("group", { name: "Confirm rollback" })).toHaveTextContent("Workspace files are not changed.");
    expect(screen.getByRole("button", { name: "Roll back" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Confirm rollback" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Roll back to here" })).toHaveFocus();
    expect(run).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledExactlyOnceWith("conversation.rollback", { type: "conversation.rollback",
      payload: { conversationId, turnId } });
    expect(screen.getByRole("button", { name: "Rolling back…" })).toBeDisabled();
    await act(async () => complete(event({ kind: "conversation.rollback", conversationId, rollbackId: "rollback-1",
      retainedTurnId: turnId, rolledBackTurns: 2, transfer: "portable", reason: "unsupported" })));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Rolled back 2 later turns. The next message starts a fresh provider session with the retained history.");
    expect(screen.getByRole("button", { name: "Roll back to here" })).toHaveFocus();
  });

  it("marks rolled-back turns without offering fork or rollback actions", async () => {
    const run = vi.fn<ForkCommandRunner>();
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run} rolledBackTurnIds={[laterTurnId]}>
      <ForkTurnAction turnId={laterTurnId} />
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    expect(screen.getByText("Rolled back · not in context")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fork from here" })).toHaveLength(1);
    expect(await screen.findAllByRole("button", { name: "Roll back to here" })).toHaveLength(1);
  });

  it("merges a fork's findings into its source chat and rejects a confirmation for another fork", async () => {
    const run = vi.fn<ForkCommandRunner>().mockResolvedValueOnce(history)
      .mockResolvedValueOnce(event({ kind: "conversation.merge-back", forkConversationId: conversationId,
        parentConversationId: sourceId, mergeBackId: "merge-1", packetId: "packet-1", messageCount: 4,
        omittedMessageCount: 0, turnCount: 2 }))
      .mockResolvedValueOnce(event({ kind: "conversation.merge-back", forkConversationId: sourceId,
        parentConversationId: projectId, mergeBackId: "merge-2", packetId: "packet-2", messageCount: 1,
        omittedMessageCount: 0, turnCount: 1 }));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}><ForkHistoryPanel /></ForkSurfaceProvider>);
    const user = userEvent.setup();
    const merge = await screen.findByRole("button", { name: "Merge findings into source chat" });
    await user.click(merge);
    expect(run).toHaveBeenLastCalledWith("conversation.merge-back", { type: "conversation.merge-back",
      payload: { forkConversationId: conversationId } });
    expect(await screen.findByRole("status")).toHaveTextContent("Attached 4 messages from 2 turns to the source chat's next message.");
    await user.click(merge);
    expect(await screen.findByRole("alert")).toHaveTextContent("The merge-back belongs to another fork.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

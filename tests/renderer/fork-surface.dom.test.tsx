import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForkHistoryPanel, ForkSurfaceProvider, ForkTurnAction, type ForkCommandRunner } from "../../src/renderer/src/components/orchestration/fork-surface";
import type { ServerEvent } from "../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import { forkHistoryResultSchema, type ForkHistoryResult } from "../../src/shared/orchestration-forks";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const time = "2026-10-29T21:00:00.000Z";
const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test" });

function page(text: string, next: number | null): ForkHistoryResult {
  return forkHistoryResultSchema.parse({ kind: "conversation.fork.history", conversationId, next,
    lineage: { threadId: conversationId, projectId, parentThreadId: sourceId, rootThreadId: sourceId,
      sourceRunId: "source-run", sourceTurnId: turnId, sourceWorkspaceKey: "/test", sourceProviderId: "codex",
      sourceSelection: selection, sourceIdentity: continuationIdentityForSelection(selection), nativeBoundary: null,
      inheritedItems: 2, inheritedParts: 2, transfer: "pending", createdAt: time },
    parts: [{ id: `item-${text}`, threadId: conversationId, sourceThreadId: sourceId, sourceRunId: "source-run",
      sourceTurnId: turnId, sourceItemId: `message-${text}`, ordinal: next === null ? 1 : 0, part: 0, parts: 1,
      kind: "assistant-message", status: "completed", text, createdAt: time }],
  });
}
function result(value: ForkHistoryResult): ServerEvent {
  return { type: "request.result", requestId: "request", result: value };
}

afterEach(cleanup);

describe("fork controls", () => {
  it("forks the selected finished run by keyboard and prevents duplicate clicks while awaiting confirmation", async () => {
    let complete!: (event: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>(() => new Promise((resolve) => { complete = resolve; }));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}>
      <ForkTurnAction turnId={turnId} />
    </ForkSurfaceProvider>);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledExactlyOnceWith("conversation.fork", { type: "conversation.fork",
      payload: { projectId, sourceConversationId: conversationId, sourceTurnId: turnId, activate: true } });
    expect(screen.getByRole("button", { name: "Forking…" })).toBeDisabled();
    await act(async () => complete({ type: "request.result", requestId: "request",
      result: { kind: "conversation.created", conversationId: sourceId } }));
    expect(screen.getByRole("button", { name: "Fork from here" })).toBeEnabled();
  });

  it("pages immutable history without replacing already loaded items", async () => {
    const run = vi.fn<ForkCommandRunner>().mockResolvedValueOnce(result(page("Opening history", 3)))
      .mockResolvedValueOnce(result(page("Later history", null)));
    render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}><ForkHistoryPanel /></ForkSurfaceProvider>);
    await screen.findByText(/Inherited history · 2 items/u);
    const user = userEvent.setup();
    await user.click(screen.getByText(/Inherited history · 2 items/u));
    await user.click(screen.getByRole("button", { name: "Load more inherited history" }));
    await screen.findByText("Later history");
    expect(screen.getByText("Opening history")).toBeInTheDocument();
    expect(run).toHaveBeenLastCalledWith("conversation.fork.history", { type: "conversation.fork.history",
      payload: { conversationId, afterRevision: 3, limit: 4 } });
    expect(screen.queryByRole("button", { name: "Load more inherited history" })).not.toBeInTheDocument();
  });

  it("does not show a late history response after changing chats", async () => {
    let complete!: (event: ServerEvent) => void;
    const run = vi.fn<ForkCommandRunner>().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValue(result({ kind: "conversation.fork.history", conversationId: sourceId, lineage: null, parts: [], next: null }));
    const view = render(<ForkSurfaceProvider projectId={projectId} conversationId={conversationId} run={run}><ForkHistoryPanel /></ForkSurfaceProvider>);
    view.rerender(<ForkSurfaceProvider projectId={projectId} conversationId={sourceId} run={run}><ForkHistoryPanel /></ForkSurfaceProvider>);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await act(async () => complete(result(page("Stale history", null))));
    expect(screen.queryByText("Stale history")).not.toBeInTheDocument();
    expect(screen.queryByText(/Inherited history/u)).not.toBeInTheDocument();
  });
});

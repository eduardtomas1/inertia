import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage, ServerEvent } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { ComposerQueuedActions } from "../../src/renderer/src/components/composer/ComposerQueuedActions";
import { enqueueComposerPrompt, markComposerQueuedPromptDispatched, readComposerQueue } from "../../src/renderer/src/components/composer/composerQueuedPrompts";
import { stageRuntimeComposerPrompt, transferRuntimeComposerPrompt } from "../../src/renderer/src/components/composer/runtimeComposerQueue";
import type { MessageQueueCommandRunner } from "../../src/renderer/src/components/composer/types";
import { composerProps, conversation, deferred } from "./composer-fixtures";

const conversationId = "40404040-4040-4040-8040-404040404040";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
function item(id = firstId, status: QueuedMessage["status"] = "queued"): QueuedMessage {
  return { id, conversationId, content: id === firstId ? "Review the changes" : "Run the tests", createdAt: "2026-09-26T12:00:00.000Z", status, afterTurnId: "turn-1", lastError: null };
}
function response(items: QueuedMessage[] = [], owner = conversationId): ServerEvent {
  return { type: "request.result", requestId: "queue-request", result: { kind: "message.queue", conversationId: owner, items } };
}
const onSendQueued = vi.fn(async () => undefined);
function queueView(run: MessageQueueCommandRunner, items: QueuedMessage[], owner = conversationId) {
  return <ComposerQueuedActions conversationId={owner} canSendQueuedNow running={false}
    latestTurnId="turn-1" latestTurnStatus="completed" latestTurnAuthoritative queueHost={null}
    queuedMessages={items} onMessageQueueCommand={run} onSendQueued={onSendQueued}
    onReleaseAttachment={async () => undefined} />;
}

afterEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); vi.clearAllMocks(); });

describe("runtime-owned composer queue", () => {
  it("retains the same enqueue id and original turn after a lost acknowledgement, including concurrent/reloaded retries", async () => {
    const staged = stageRuntimeComposerPrompt(conversationId, "Review the changes", "turn-1");
    const lost = deferred<ServerEvent>();
    const run = vi.fn<MessageQueueCommandRunner>().mockReturnValueOnce(lost.promise).mockResolvedValue(response());
    const first = transferRuntimeComposerPrompt(conversationId, staged, "turn-1", run);
    const concurrent = transferRuntimeComposerPrompt(conversationId, staged, "turn-2", run);
    expect(concurrent).toBe(first);
    lost.reject(new Error("Connection lost"));
    await expect(first).rejects.toThrow("Connection lost");
    const reloaded = stageRuntimeComposerPrompt(conversationId, "Review the changes", "turn-3");
    expect(reloaded.id).toBe(staged.id);
    expect(readComposerQueue(conversationId)).toHaveLength(1);
    await transferRuntimeComposerPrompt(conversationId, reloaded, "turn-3", run);
    expect(run).toHaveBeenCalledTimes(2);
    for (const [, command] of run.mock.calls) expect(command.payload).toMatchObject({ action: "enqueue", id: staged.id, afterTurnId: "turn-1" });
    expect(readComposerQueue(conversationId)).toEqual([]);
  });

  it("does not erase the local outbox for a response owned by another chat", async () => {
    const staged = stageRuntimeComposerPrompt(conversationId, "Review the changes", null);
    const run = vi.fn<MessageQueueCommandRunner>().mockResolvedValue(response([], secondId));
    await expect(transferRuntimeComposerPrompt(conversationId, staged, "later-turn", run)).rejects.toThrow("did not confirm");
    expect(run.mock.calls[0]?.[1].payload).toMatchObject({ afterTurnId: null });
    expect(readComposerQueue(conversationId)).toHaveLength(1);
  });

  it("migrates only undispatched legacy text and never invokes a renderer send", async () => {
    enqueueComposerPrompt(conversationId, "Legacy text");
    const legacy = readComposerQueue(conversationId)[0]!;
    enqueueComposerPrompt(conversationId, "Unconfirmed legacy text");
    const unconfirmed = readComposerQueue(conversationId)[1]!;
    markComposerQueuedPromptDispatched(conversationId, unconfirmed.id);
    const run = vi.fn<MessageQueueCommandRunner>().mockResolvedValue(response());
    render(queueView(run, []));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run.mock.calls[0]?.[1].payload).toMatchObject({ action: "enqueue", id: legacy.id, content: "Legacy text" });
    await waitFor(() => expect(readComposerQueue(conversationId)).toHaveLength(1));
    expect(readComposerQueue(conversationId)[0]?.id).toBe(unconfirmed.id);
    expect(onSendQueued).not.toHaveBeenCalled();
  });

  it("uses runtime mutations for pause, resume, reorder and remove without automatic renderer dispatch", async () => {
    let items = [item(), item(secondId)];
    const run = vi.fn<MessageQueueCommandRunner>(async (_key, command) => {
      const payload = command.payload;
      if (payload.action === "pause") items = items.map((entry) => entry.id === payload.id ? { ...entry, status: payload.paused ? "paused" : "queued" } : entry);
      if (payload.action === "move") items = [...items].reverse();
      if (payload.action === "remove") items = items.filter((entry) => entry.id !== payload.id);
      return response(items);
    });
    render(queueView(run, items));
    expect(onSendQueued).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("group", { name: "Queued message 1" })).getByRole("button", { name: "Pause queued message" }));
    await screen.findByText("Paused");
    fireEvent.click(screen.getByRole("button", { name: "Resume queued message" }));
    await waitFor(() => expect(screen.queryByText("Paused")).toBeNull());
    fireEvent.click(within(screen.getByRole("group", { name: "Queued message 2" })).getByRole("button", { name: "Move queued message up" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Run the tests"));
    fireEvent.click(within(screen.getByRole("group", { name: "Queued message 1" })).getByRole("button", { name: "Remove queued message" }));
    await waitFor(() => expect(screen.queryByText("Run the tests")).toBeNull());
    expect(run.mock.calls.map(([, command]) => command.payload.action)).toEqual(["pause", "pause", "move", "remove"]);
    expect(onSendQueued).not.toHaveBeenCalled();
  });

  it("shows uncertain and rejected outcomes with different send eligibility", () => {
    const run = vi.fn<MessageQueueCommandRunner>().mockResolvedValue(response());
    render(queueView(run, [item(firstId, "uncertain"), { ...item(secondId, "rejected"), lastError: "Provider unavailable" }]));
    expect(screen.getByText("Send unconfirmed — check transcript")).toBeInTheDocument();
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Queued message 1" })).getByRole("button", { name: "Send now" })).toBeDisabled();
    expect(within(screen.getByRole("group", { name: "Queued message 2" })).getByRole("button", { name: "Send now" })).toBeEnabled();
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores a late queue mutation result after switching conversations", async () => {
    const pending = deferred<ServerEvent>();
    const run = vi.fn<MessageQueueCommandRunner>().mockReturnValue(pending.promise);
    const view = render(queueView(run, [item()]));
    fireEvent.click(screen.getByRole("button", { name: "Pause queued message" }));
    view.rerender(queueView(run, [], secondId));
    await act(async () => { pending.resolve(response([item(firstId, "paused")])); await pending.promise; });
    expect(screen.queryByRole("list", { name: "Saved queued messages" })).toBeNull();
  });

  it("acknowledges runtime cancellation before removing an outbox entry whose enqueue is still pending", async () => {
    const staged = stageRuntimeComposerPrompt(conversationId, "Cancel this queued draft", "turn-1");
    const pending = deferred<ServerEvent>();
    const cancellation = deferred<ServerEvent>();
    const run = vi.fn<MessageQueueCommandRunner>((_key, command) => command.payload.action === "remove" ? cancellation.promise : pending.promise);
    render(queueView(run, []));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
    expect(readComposerQueue(conversationId)[0]?.id).toBe(staged.id);
    await act(async () => { cancellation.resolve(response()); await cancellation.promise; });
    await waitFor(() => expect(readComposerQueue(conversationId)).toEqual([]));
    await act(async () => { pending.reject(new Error("Canceled queue identity")); await pending.promise.catch(() => undefined); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onSendQueued).not.toHaveBeenCalled();
  });

  it("preserves the editor and stable outbox entry when saving the queue fails", async () => {
    const run = vi.fn<MessageQueueCommandRunner>().mockRejectedValue(new Error("Offline: reconnect to save"));
    const current = conversation(conversationId);
    render(<Composer {...composerProps(current, { running: true, onMessageQueueCommand: run })} />);
    const textbox = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(textbox, { target: { value: "Keep my draft" } });
    fireEvent.keyDown(textbox, { key: "Tab" });
    await waitFor(() => expect(run).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText("Offline: reconnect to save").length).toBeGreaterThan(0));
    expect(textbox).toHaveValue("Keep my draft");
    const first = readComposerQueue(conversationId)[0]!;
    fireEvent.keyDown(textbox, { key: "Tab" });
    await waitFor(() => expect(run.mock.calls.length).toBeGreaterThan(1));
    expect(readComposerQueue(conversationId)[0]?.id).toBe(first.id);
  });

  it.each([false, true])("clears only the acknowledged draft (edited while pending: %s)", async (edited) => {
    const pending = deferred<ServerEvent>();
    const run = vi.fn<MessageQueueCommandRunner>().mockReturnValue(pending.promise);
    const current = conversation(conversationId);
    const latestTurn = { ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>), id: "turn-1", status: "running" as const, harnessId: "codex-app-server" as const };
    render(<Composer {...composerProps(current, { running: true, latestTurn, onMessageQueueCommand: run })} />);
    const textbox = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(textbox, { target: { value: "Review the changes" } });
    fireEvent.keyDown(textbox, { key: "Tab" });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(textbox).toHaveValue("Review the changes");
    if (edited) fireEvent.change(textbox, { target: { value: "My next draft" } });
    await act(async () => { pending.resolve(response([item()])); await pending.promise; });
    await waitFor(() => expect(textbox).toHaveValue(edited ? "My next draft" : ""));
    expect(readComposerQueue(conversationId)).toEqual([]);
  });
});

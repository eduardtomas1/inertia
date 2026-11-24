import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { QUEUED_DOCUMENTS_SEND_LATER, RuntimeComposerQueuedActions } from "../../src/renderer/src/components/composer/RuntimeComposerQueuedActions";
import type { QueueCommand, QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import { QUEUED_ROUTE_CHANGED_ERROR, type MessageQueueResult, type QueuedMessage } from "../../src/shared/queued-messages";
import { releaseAllComposerDraftAttachments } from "../../src/renderer/src/utils/composerDraftAttachments";
import type { ComposerAttachmentImportLease } from "../../src/renderer/src/utils/composerAttachments";
import { composerProps, conversation } from "./composer-fixtures";

const conversationId = "70707070-7070-4070-8070-707070707070";
const entry = (index: number, overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: `7171717${index}-7171-4171-8171-717171717171`, conversationId, content: `Task ${index}`, attachments: [],
  state: "waiting", createdAt: "2026-11-23T00:00:00.000Z", error: null, turnId: null, userMessageId: null, ...overrides,
});
const result = (entries: QueuedMessage[], extra: Partial<MessageQueueResult> = {}): MessageQueueResult =>
  ({ kind: "message.queue", conversationId, entries, receipt: null, ...extra });
const pdf: QueuedMessage["attachments"][number] = {
  id: "72727272-7272-4272-8272-727272727272", name: "spec.pdf", path: "opaque", mimeType: "application/pdf", size: 64,
};

afterEach(() => {
  releaseAllComposerDraftAttachments();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "inertia");
});

function queueRunner(initial: QueuedMessage[], handle: (command: QueueCommand, entries: QueuedMessage[]) => MessageQueueResult | undefined = () => undefined) {
  let entries = initial;
  const run = vi.fn<QueueCommandRunner>(async (command) => {
    const handled = handle(command, entries);
    if (handled) { entries = handled.entries; return handled; }
    if (command.type === "message.queue.remove") entries = entries.filter(({ id }) => id !== command.payload.id);
    return result(entries);
  });
  return run;
}

describe("the composer queue list", () => {
  it("shows every queued message in order with its own Remove, and keeps focus in the list after removing one", async () => {
    const run = queueRunner([entry(1), entry(2), entry(3)]);
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend
      latestTurnId="turn" latestTurnStatus="running" queueHost={null} />);
    const list = await screen.findByRole("list", { name: "Queued messages" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".composer-queue-copy")?.textContent)).toEqual(["Task 1", "Task 2", "Task 3"]);
    expect(within(items[1]!).getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Send queued message now" })).toHaveLength(1);
    const removeSecond = screen.getByRole("button", { name: "Remove queued message 2 of 3" });
    removeSecond.focus();
    await act(async () => fireEvent.click(removeSecond));
    expect(run).toHaveBeenCalledWith({ type: "message.queue.remove", payload: { conversationId, id: entry(2).id } });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove queued message 2 of 2" }));
  });

  it("returns focus to the message box when the last queued message is removed", async () => {
    const run = queueRunner([entry(1)]);
    const onFocusInput = vi.fn();
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend
      latestTurnId="turn" latestTurnStatus="running" queueHost={null} onFocusInput={onFocusInput} />);
    const remove = await screen.findByRole("button", { name: "Remove queued message" });
    remove.focus();
    await act(async () => fireEvent.click(remove));
    await waitFor(() => expect(onFocusInput).toHaveBeenCalledOnce());
  });

  it("pulls a message back with Edit, and explains why Edit is unavailable while the draft has content", async () => {
    const edited = entry(2, { attachments: [pdf] });
    const run = queueRunner([entry(1), edited], (command, entries) => command.type === "message.queue.edit"
      ? result(entries.filter(({ id }) => id !== command.payload.id), { edited: entries.find(({ id }) => id === command.payload.id)! })
      : undefined);
    const onEdit = vi.fn(async () => undefined);
    const props = { conversationId, onCommand: run, canSend: true, latestTurnId: "turn", latestTurnStatus: "running", queueHost: null };
    const view = render(<RuntimeComposerQueuedActions {...props} edit={{ blockedReason: "Send or clear the current draft first", onEdit }} />);
    const blocked = await screen.findByRole("button", { name: "Edit queued message 2 of 2" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleDescription("Send or clear the current draft first");
    await act(async () => fireEvent.click(blocked));
    expect(run.mock.calls.some(([command]) => command.type === "message.queue.edit")).toBe(false);

    view.rerender(<RuntimeComposerQueuedActions {...props} edit={{ blockedReason: null, onEdit }} />);
    const enabled = screen.getByRole("button", { name: "Edit queued message 2 of 2" });
    expect(enabled).not.toHaveAttribute("aria-disabled");
    await act(async () => fireEvent.click(enabled));
    expect(run).toHaveBeenCalledWith({ type: "message.queue.edit", payload: { conversationId, id: edited.id } });
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(edited);
    await waitFor(() => expect(screen.queryByText("Task 2")).toBeNull());
  });

  it("offers no Edit for a forwarded watcher note", async () => {
    const note = entry(1, { watcherNote: {
      linkId: "11111111-1111-4111-8111-111111111111", wakeId: "22222222-2222-4222-8222-222222222222",
      watcherConversationId: "33333333-3333-4333-8333-333333333333", preset: "reviewer", watcherLabel: "Codex · test route", delivery: "queue",
    } });
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={queueRunner([note])} canSend
      latestTurnId="turn" latestTurnStatus="running" queueHost={null} edit={{ blockedReason: null, onEdit: async () => undefined }} />);
    await screen.findByText("From watcher");
    expect(screen.queryByRole("button", { name: /Edit queued message/u })).toBeNull();
  });

  it("re-confirms a route-blocked message, asking before it widens access", async () => {
    const blocked = entry(1, { state: "blocked", error: QUEUED_ROUTE_CHANGED_ERROR });
    const run = queueRunner([blocked], (command, entries) => {
      if (command.type !== "message.queue.reconfirm") return undefined;
      if (!command.payload.confirmed) return result(entries, { confirmation: { id: blocked.id,
        queued: { interactionMode: "build", accessMode: "supervised" }, current: { interactionMode: "build", accessMode: "full" } } });
      return result([]);
    });
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={run} canSend={false}
      latestTurnId="turn" latestTurnStatus="completed" queueHost={null} />);
    const send = await screen.findByRole("button", { name: "Send queued message with current settings" });
    expect(screen.queryByRole("button", { name: "Send queued message now" })).toBeNull();
    await act(async () => fireEvent.click(send));
    const group = await screen.findByRole("group", { name: "Confirm wider access" });
    expect(group).toHaveTextContent("Queued with Build · Supervised. Current settings: Build · Full access.");
    const confirm = within(group).getByRole("button", { name: "Send with Full access" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Confirm wider access" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(send));

    await act(async () => fireEvent.click(send));
    const confirmAgain = await screen.findByRole("button", { name: "Send with Full access" });
    await act(async () => fireEvent.click(confirmAgain));
    expect(run).toHaveBeenCalledWith({ type: "message.queue.reconfirm", payload: {
      conversationId, id: blocked.id, confirmed: { interactionMode: "build", accessMode: "full" },
    } });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  });

  it("keeps Send now off for a queued document while the agent works and says when it will send", async () => {
    render(<RuntimeComposerQueuedActions conversationId={conversationId} onCommand={queueRunner([entry(1, { attachments: [pdf] })])} canSend running
      latestTurnId="turn" latestTurnStatus="running" queueHost={null} />);
    const send = await screen.findByRole("button", { name: "Send queued message now" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(QUEUED_DOCUMENTS_SEND_LATER);
    expect(screen.getByText("1 file")).toBeInTheDocument();
  });
});

describe("the composer with an editable queue that accepts documents", () => {
  const running = {
    ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
    id: "turn-running", status: "running" as const, harnessId: "codex-app-server" as const,
  };
  const lease = (attachments: ChatAttachment[]): ComposerAttachmentImportLease =>
    ({ attachments, commit: async () => undefined, cancel: async () => undefined });

  it("queues a document draft on Enter while the agent works instead of steering it", async () => {
    const current = conversation("73737373-7373-4373-8373-737373737373");
    const document: ChatAttachment = { id: "73737373-7373-4373-8373-737373737374", name: "spec.pdf", path: "opaque", mimeType: "application/pdf", size: 64 };
    const onSend = vi.fn(async () => undefined);
    const run = vi.fn<QueueCommandRunner>(async (command) => command.type === "message.queue.enqueue"
      ? { kind: "message.queue", conversationId: current.id, entries: [], receipt: {
          id: command.payload.id, conversationId: current.id, content: command.payload.content, attachments: [],
          state: "waiting", createdAt: "2026-11-23T00:00:00.000Z", error: null, turnId: null, userMessageId: null,
        } }
      : { kind: "message.queue", conversationId: current.id, entries: [], receipt: null });
    render(<Composer {...composerProps(current, {
      running: true, latestTurn: running, onSend, onQueueCommand: run,
      onImportAttachments: async () => lease([document]),
    })} />);
    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Read this spec next." } });
    fireEvent.paste(input, { clipboardData: { files: [new File(["%PDF"], "spec.pdf", { type: "application/pdf" })] } });
    await screen.findByRole("button", { name: "Remove attachment spec.pdf" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
      type: "message.queue.enqueue",
      payload: expect.objectContaining({ content: "Read this spec next.", attachments: [expect.objectContaining({ id: document.id, mimeType: "application/pdf" })] }),
    })));
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("pulls a queued message back into the empty draft with fresh attachment copies and focuses the message box", async () => {
    const current = conversation("74747474-7474-4474-8474-747474747474");
    const stored = { id: "74747474-7474-4474-8474-747474747475", name: "shot.png", path: "opaque", mimeType: "image/png" as const, size: 64 };
    const queuedEntry: QueuedMessage = { ...entry(1), conversationId: current.id, content: "Fix the layout", attachments: [stored] };
    const fresh: ChatAttachment = { id: "74747474-7474-4474-8474-747474747476", name: "shot.png", path: "/private/tmp/fresh.png", mimeType: "image/png", size: 64 };
    const reattachAttachment = vi.fn(async () => ({ batchId: "74747474-7474-4474-8474-747474747477", attachments: [fresh] }));
    const commitAttachmentImport = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", { configurable: true, value: {
      reattachAttachment, commitAttachmentImport, cancelAttachmentImport: vi.fn(async () => undefined),
    } });
    let entries = [queuedEntry];
    const run = vi.fn<QueueCommandRunner>(async (command) => {
      if (command.type === "message.queue.edit") {
        const edited = entries[0]!;
        entries = [];
        return { kind: "message.queue", conversationId: current.id, entries, receipt: null, edited };
      }
      return { kind: "message.queue", conversationId: current.id, entries, receipt: null };
    });
    render(<Composer {...composerProps(current, { running: true, latestTurn: running, onQueueCommand: run })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    const edit = await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 });
    fireEvent.change(input, { target: { value: "Unsent words" } });
    await waitFor(() => expect(edit).toHaveAccessibleDescription("Send or clear the current draft first"));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(edit).not.toHaveAttribute("aria-disabled"));

    await act(async () => fireEvent.click(edit));
    await waitFor(() => expect(input).toHaveValue("Fix the layout"));
    expect(reattachAttachment).toHaveBeenCalledExactlyOnceWith({ conversationId: current.id, attachmentId: stored.id });
    expect(await screen.findByRole("button", { name: "Remove attachment shot.png" })).toBeInTheDocument();
    expect(commitAttachmentImport).toHaveBeenCalledWith("74747474-7474-4474-8474-747474747477", [fresh.id]);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
  });

  it("keeps the text and names an attachment that could not be restored", async () => {
    const current = conversation("75757575-7575-4575-8575-757575757575");
    const stored = { id: "75757575-7575-4575-8575-757575757576", name: "gone.png", path: "opaque", mimeType: "image/png" as const, size: 64 };
    Object.defineProperty(window, "inertia", { configurable: true, value: {
      reattachAttachment: vi.fn(async () => { throw new Error("This file is no longer stored. Attach the original file again."); }),
      commitAttachmentImport: vi.fn(async () => undefined), cancelAttachmentImport: vi.fn(async () => undefined),
    } });
    let entries: QueuedMessage[] = [{ ...entry(1), conversationId: current.id, content: "Retry with the picture", attachments: [stored] }];
    const run = vi.fn<QueueCommandRunner>(async (command) => {
      if (command.type === "message.queue.edit") {
        const edited = entries[0]!;
        entries = [];
        return { kind: "message.queue", conversationId: current.id, entries, receipt: null, edited };
      }
      return { kind: "message.queue", conversationId: current.id, entries, receipt: null };
    });
    render(<Composer {...composerProps(current, { running: true, latestTurn: running, onQueueCommand: run })} />);
    const edit = await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 });
    await act(async () => fireEvent.click(edit));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Retry with the picture"));
    expect(await screen.findByRole("alert")).toHaveTextContent("An attachment could not be restored: gone.png. Attach it again.");
  });

  it("routes an async queued edit into the original chat's saved draft when switching chats or unmounting", async () => {
    const first = conversation("76767676-7676-4676-8676-767676767671");
    const second = conversation("76767676-7676-4676-8676-767676767672");
    const stored = { id: "76767676-7676-4676-8676-767676767673", name: "spec.png", path: "opaque", mimeType: "image/png" as const, size: 64 };
    const fresh: ChatAttachment = { id: "76767676-7676-4676-8676-767676767674", name: "spec.png", path: "/private/tmp/spec.png", mimeType: "image/png", size: 64 };
    const queuedEntry: QueuedMessage = { ...entry(1), conversationId: first.id, content: "Keep this for chat one", attachments: [stored] };
    const reattachAttachment = vi.fn(async () => ({ batchId: "76767676-7676-4676-8676-767676767675", attachments: [fresh] }));
    const commitAttachmentImport = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", { configurable: true, value: {
      reattachAttachment, commitAttachmentImport, cancelAttachmentImport: vi.fn(async () => undefined),
    } });
    let resolveEdit: ((result: MessageQueueResult) => void) | null = null;
    const run = vi.fn<QueueCommandRunner>((command) => {
      if (command.type === "message.queue.edit") {
        return new Promise<MessageQueueResult>((resolve) => {
          resolveEdit = resolve;
        });
      }
      return Promise.resolve({
        kind: "message.queue",
        conversationId: command.payload.conversationId,
        entries: command.payload.conversationId === first.id ? [queuedEntry] : [],
        receipt: null,
      });
    });

    const rendered = render(<Composer {...composerProps(first, { running: true, latestTurn: running, onQueueCommand: run })} />);
    const edit = await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 });
    fireEvent.click(edit);
    await waitFor(() => expect(resolveEdit).not.toBeNull());

    rendered.rerender(<Composer {...composerProps(second, { running: false, latestTurn: null, onQueueCommand: run })} />);
    const secondInput = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(secondInput, { target: { value: "Draft for chat two" } });

    await act(async () => {
      resolveEdit!({ kind: "message.queue", conversationId: first.id, entries: [], receipt: null, edited: queuedEntry });
      await Promise.resolve();
    });

    await waitFor(() => expect(commitAttachmentImport).toHaveBeenCalledWith("76767676-7676-4676-8676-767676767675", [fresh.id]));
    expect(secondInput).toHaveValue("Draft for chat two");
    expect(secondInput).not.toBeDisabled();

    rendered.rerender(<Composer {...composerProps(first, { running: false, latestTurn: null, onQueueCommand: run })} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this for chat one"));
    expect(await screen.findByRole("button", { name: "Remove attachment spec.png" })).toBeInTheDocument();
  });
});

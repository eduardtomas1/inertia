import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../src/shared/contracts";
import type { MessageQueueResult, QueuedMessage } from "../../src/shared/queued-messages";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { QueueCommand, QueueCommandOptions, QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import { announceRuntimeQueueChanged } from "../../src/renderer/src/components/composer/runtimeQueueEvents";
import { readComposerDraft } from "../../src/renderer/src/utils/composerDraftPersistence";
import { releaseAllComposerDraftAttachments } from "../../src/renderer/src/utils/composerDraftAttachments";
import { requestComposerPrefill } from "../../src/renderer/src/utils/composerPrefill";
import type { ComposerAttachmentImportLease } from "../../src/renderer/src/utils/composerAttachments";
import { composerProps, conversation } from "./composer-fixtures";

const runningTurn = {
  ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
  id: "turn-running",
  status: "running" as const,
  harnessId: "codex-app-server" as const,
};

function makeEntry(
  conversationId: string,
  index: number,
  overrides: Partial<QueuedMessage> = {},
): QueuedMessage {
  return {
    id: `8181818${index}-8181-4181-8181-818181818181`,
    conversationId,
    content: `Queued task ${index}`,
    attachments: [],
    state: "waiting",
    createdAt: "2026-11-26T00:00:00.000Z",
    editRevision: 1,
    error: null,
    turnId: null,
    userMessageId: null,
    ...overrides,
  };
}

function makeAttachment(id: string, name: string, mimeType: ChatAttachment["mimeType"] = "image/png"): ChatAttachment {
  return { id, name, path: id, mimeType, size: 128 };
}

function makeLease(attachments: ChatAttachment[]): ComposerAttachmentImportLease {
  return {
    attachments,
    commit: async () => undefined,
    cancel: async () => undefined,
  };
}

afterEach(() => {
  releaseAllComposerDraftAttachments();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("in-place queued message editing in Composer", () => {
  it("preserves unrelated draft, localStorage draft, and mention chips across edit and Cancel, and restores focus to Edit", async () => {
    const current = conversation("80808080-8080-4080-8080-808080808081");
    const item = makeEntry(current.id, 1, { content: "Original queued prompt" });
    const run = vi.fn<QueueCommandRunner>(async () => ({
      kind: "message.queue",
      conversationId: current.id,
      entries: [item],
      receipt: null,
    }));

    render(
      <Composer
        {...composerProps(current, {
          running: false,
          onQueueCommand: run,
          mentionResults: [{ path: "src/app.ts", kind: "file" }],
        })}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "My draft @app" } });
    fireEvent.click(await screen.findByRole("option", { name: /src\/app\.ts/u }));
    expect(input).toHaveValue("My draft @src/app.ts ");

    const editButton = await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 });
    fireEvent.click(editButton);

    const banner = await screen.findByRole("region", { name: "Editing queued message" });
    expect(readComposerDraft(current.id)).toBe("My draft @src/app.ts ");
    expect(input).toHaveValue("Original queued prompt");
    expect(within(banner).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "Changed queued prompt" } });
    // localStorage thread draft must NOT be clobbered while editing!
    expect(readComposerDraft(current.id)).toBe("My draft @src/app.ts ");
    expect(within(banner).getByRole("button", { name: "Save" })).toBeEnabled();

    // Tab enqueue is suppressed in edit mode; Escape cancels and restores draft + focus.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(run.mock.calls.some(([cmd]) => cmd.type === "message.queue.enqueue")).toBe(false);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Editing queued message" })).toBeNull();
    expect(input).toHaveValue("My draft @src/app.ts ");
    await waitFor(() => expect(document.activeElement).toBe(editButton));
  });

  it("saves edited text with expectedRevision, keeps server-owned originals unreleased on remove, and releases staged uploads on remove or cancel", async () => {
    const current = conversation("80808080-8080-4080-8080-808080808082");
    const originalImg = makeAttachment("82828282-8282-4282-8282-828282828281", "orig.png");
    const stagedImg = makeAttachment("82828282-8282-4282-8282-828282828282", "new.png");
    const item = makeEntry(current.id, 1, {
      content: "Check image",
      editRevision: 3,
      attachments: [originalImg],
    });
    const onReleaseAttachment = vi.fn(async () => undefined);
    const editCalls: Array<{ command: QueueCommand; options?: QueueCommandOptions }> = [];
    let entries = [item];
    const run = vi.fn<QueueCommandRunner>(async (command, options): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.edit") {
        editCalls.push({ command, options });
        const payload = command.payload as { content: string; attachments?: ChatAttachment[] };
        entries = [{ ...item, content: payload.content, attachments: payload.attachments ?? [], editRevision: 4 }];
      }
      return { kind: "message.queue", conversationId: current.id, entries, receipt: null };
    });

    render(
      <Composer
        {...composerProps(current, {
          running: true,
          latestTurn: runningTurn,
          onQueueCommand: run,
          onReleaseAttachment,
          onImportAttachments: async () => makeLease([stagedImg]),
        })}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Message" });
    const editButton = await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 });
    fireEvent.click(editButton);

    // Removing server-owned original marks dirty WITHOUT releasing server-owned original!
    fireEvent.click(await screen.findByRole("button", { name: "Remove attachment orig.png" }));
    expect(onReleaseAttachment).not.toHaveBeenCalled();
    const banner = screen.getByRole("region", { name: "Editing queued message" });
    expect(within(banner).getByRole("button", { name: "Save" })).toBeEnabled();

    // Pasting a new file stages it inside the edit; cancelling releases ONLY the staged upload!
    fireEvent.paste(input, { clipboardData: { files: [new File(["png"], "new.png", { type: "image/png" })] } });
    await screen.findByRole("button", { name: "Remove attachment new.png" });

    fireEvent.click(within(banner).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onReleaseAttachment).toHaveBeenCalledExactlyOnceWith(stagedImg.id));

    // Re-open edit, stage a new upload, and save with Enter.
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    fireEvent.paste(input, { clipboardData: { files: [new File(["png"], "new.png", { type: "image/png" })] } });
    await screen.findByRole("button", { name: "Remove attachment new.png" });
    fireEvent.change(input, { target: { value: "Updated with new image" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    await waitFor(() => expect(editCalls).toHaveLength(1));
    expect(editCalls[0]!.command).toMatchObject({
      type: "message.queue.edit",
      payload: {
        conversationId: current.id,
        id: item.id,
        expectedRevision: 3,
        content: "Updated with new image",
      },
    });
    expect(editCalls[0]!.options?.handoffAttachmentIds).toEqual([stagedImg.id]);
    expect(screen.queryByRole("region", { name: "Editing queued message" })).toBeNull();
  });

  it("shows Discard when cleared and removes the queued item", async () => {
    const current = conversation("80808080-8080-4080-8080-808080808083");
    const item = makeEntry(current.id, 1, { content: "Clear me" });
    let entries = [item];
    const run = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.remove") entries = [];
      return { kind: "message.queue", conversationId: current.id, entries, receipt: null };
    });

    render(<Composer {...composerProps(current, { running: true, latestTurn: runningTurn, onQueueCommand: run })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 }));
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "   " } });

    const banner = screen.getByRole("region", { name: "Editing queued message" });
    expect(within(banner).queryByRole("button", { name: "Save" })).toBeNull();
    await act(async () => { fireEvent.click(within(banner).getByRole("button", { name: "Discard" })); });
    expect(run).toHaveBeenCalledWith({ type: "message.queue.remove", payload: { conversationId: current.id, id: item.id } });
    expect(screen.queryByRole("region", { name: "Editing queued message" })).toBeNull();
  });

  it("recovers unsaved edits into an empty draft on disappearance, and keeps an existing non-empty draft", async () => {
    const current = conversation("80808080-8080-4080-8080-808080808084");
    const item = makeEntry(current.id, 1, { content: "Will dispatch" });
    let entries: QueuedMessage[] = [item];
    const run = vi.fn<QueueCommandRunner>(async () => ({
      kind: "message.queue",
      conversationId: current.id,
      entries,
      receipt: null,
    }));

    const view = render(<Composer {...composerProps(current, { running: true, latestTurn: runningTurn, onQueueCommand: run })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 }));
    fireEvent.change(input, { target: { value: "Recovered unsaved text" } });

    // Item disappears while stashed draft was empty -> moved to thread draft!
    entries = [];
    await act(async () => { announceRuntimeQueueChanged(current.id); });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Editing queued message" })).toBeNull());
    expect(input).toHaveValue("Recovered unsaved text");
    expect(readComposerDraft(current.id)).toBe("Recovered unsaved text");
    expect(document.querySelector(".composer-queue-notice")).toHaveTextContent(/moved to the draft/u);

    // Now test with a non-empty stashed draft: existing draft stays preserved.
    entries = [item];
    await act(async () => { announceRuntimeQueueChanged(current.id); });
    fireEvent.click(await screen.findByRole("button", { name: "Edit queued message" }));
    fireEvent.change(input, { target: { value: "Edits while draft existed" } });
    entries = [{ ...item, state: "dispatching" }];
    await act(async () => { announceRuntimeQueueChanged(current.id); });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Editing queued message" })).toBeNull());
    expect(input).toHaveValue("Recovered unsaved text");
    expect(document.querySelector(".composer-queue-notice")).toHaveTextContent(/existing draft was kept/u);
    view.unmount();
  });

  it("does not start another queued edit while a save is in flight, so the edit banner never stays stuck saving", async () => {
    const current = conversation("80808080-8080-4080-8080-808080808086");
    const first = makeEntry(current.id, 1, { content: "First queued" });
    const second = makeEntry(current.id, 2, { content: "Second queued" });
    let resolveEdit: (() => void) | null = null;
    const run = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.edit") {
        await new Promise<void>((resolve) => { resolveEdit = resolve; });
      }
      return { kind: "message.queue", conversationId: current.id, entries: [first, second], receipt: null };
    });

    render(<Composer {...composerProps(current, { running: true, latestTurn: runningTurn, onQueueCommand: run })} />);
    const editFirst = await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 });
    fireEvent.click(editFirst);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "First edited" } });
    const banner = screen.getByRole("region", { name: "Editing queued message" });
    await act(async () => { fireEvent.click(within(banner).getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(resolveEdit).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Edit queued message 2 of 2" }));
    expect(input).toHaveValue("First edited");

    await act(async () => { resolveEdit!(); });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Editing queued message" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message 2 of 2" }));
    const secondBanner = await screen.findByRole("region", { name: "Editing queued message" });
    expect(input).toHaveValue("Second queued");
    expect(within(secondBanner).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("routes prefill into the active edit without clobbering localStorage and enforces the N11 pending-request gate while allowing compaction", async () => {
    const current = conversation("80808080-8080-4080-8080-808080808085");
    const item = makeEntry(current.id, 1, { content: "Base edit" });
    const run = vi.fn<QueueCommandRunner>(async () => ({
      kind: "message.queue",
      conversationId: current.id,
      entries: [item],
      receipt: null,
    }));

    const view = render(
      <Composer
        {...composerProps(current, {
          running: false,
          onQueueCommand: run,
          compaction: { state: "compacting", trigger: "manual", startedAt: "2026-11-26T00:00:00.000Z" },
        })}
        hasPendingQuestionOrApproval
      />,
    );

    const editBtn = await screen.findByRole("button", { name: "Edit queued message" }, { timeout: 5_000 });
    expect(editBtn).toHaveAttribute("aria-disabled", "true");
    expect(editBtn).toHaveAccessibleDescription("Answer or resolve the pending request before editing a queued message");

    // Clear pending request while still compacting: Edit is explicitly ALLOWED during compaction!
    view.rerender(
      <Composer
        {...composerProps(current, {
          running: false,
          onQueueCommand: run,
          compaction: { state: "compacting", trigger: "manual", startedAt: "2026-11-26T00:00:00.000Z" },
        })}
        hasPendingQuestionOrApproval={false}
      />,
    );
    expect(editBtn).not.toHaveAttribute("aria-disabled");

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Saved thread draft" } });
    fireEvent.click(editBtn);
    await screen.findByRole("region", { name: "Editing queued message" });

    // Prefill routes into the active edit without clobbering localStorage thread draft.
    act(() => { requestComposerPrefill({ conversationId: current.id, text: "Added from surface" }); });
    expect(input).toHaveValue("Base edit\n\nAdded from surface");
    expect(readComposerDraft(current.id)).toBe("Saved thread draft");
  });
});

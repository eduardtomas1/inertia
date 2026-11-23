import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { releaseDeletedComposerQueue } from "../../src/renderer/src/components/composer/ComposerQueuedActions";
import type { QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";
import type { MessageQueueResult } from "../../src/shared/queued-messages";
import type { ComposerAttachmentImportLease } from "../../src/renderer/src/utils/composerAttachments";
import {
  MAX_COMPOSER_ATTACHMENT_DRAFTS,
  discardComposerDraftAttachments,
  hasComposerDraftAttachments,
  keepComposerDraftAttachments,
  releaseAllComposerDraftAttachments,
  takeComposerDraftAttachments,
} from "../../src/renderer/src/utils/composerDraftAttachments";
import { prepareComposerDetachment } from "../../src/renderer/src/utils/composerOwnership";
import { composerProps, conversation, deferred } from "./composer-fixtures";

function attachment(id: string, mimeType: ChatAttachment["mimeType"] = "image/png"): ChatAttachment {
  const extension = mimeType === "image/png" ? "png" : mimeType === "application/pdf" ? "pdf" : "txt";
  return { id, name: `${id}.${extension}`, path: `/private/tmp/${id}.${extension}`, mimeType, size: 128 };
}

function lease(attachments: ChatAttachment[]): ComposerAttachmentImportLease {
  return { attachments, commit: async () => undefined, cancel: async () => undefined };
}

const uuid = (seed: number): string => {
  const hex = seed.toString(16).padStart(12, "0");
  return `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
};

afterEach(() => {
  releaseAllComposerDraftAttachments();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("conversation-scoped draft attachment store", () => {
  it("hands a conversation's attachments back once and keeps other conversations separate", () => {
    const release = vi.fn(async () => undefined);
    keepComposerDraftAttachments(uuid(1), [attachment("first")], release);
    keepComposerDraftAttachments(uuid(2), [attachment("second")], release);
    expect(hasComposerDraftAttachments(uuid(1))).toBe(true);
    expect(takeComposerDraftAttachments(uuid(1)).map(({ id }) => id)).toEqual(["first"]);
    expect(takeComposerDraftAttachments(uuid(1))).toEqual([]);
    expect(takeComposerDraftAttachments(uuid(2)).map(({ id }) => id)).toEqual(["second"]);
    expect(release).not.toHaveBeenCalled();
  });

  it("merges a returned handle without releasing one it already holds", () => {
    const release = vi.fn(async () => undefined);
    keepComposerDraftAttachments(uuid(3), [attachment("held")], release);
    keepComposerDraftAttachments(uuid(3), [attachment("held"), attachment("returned")], release);
    expect(takeComposerDraftAttachments(uuid(3)).map(({ id }) => id)).toEqual(["held", "returned"]);
    expect(release).not.toHaveBeenCalled();
  });

  it("evicts the oldest conversation beyond the cap and releases only its handles", () => {
    const release = vi.fn(async () => undefined);
    for (let index = 0; index <= MAX_COMPOSER_ATTACHMENT_DRAFTS; index += 1) {
      keepComposerDraftAttachments(uuid(100 + index), [attachment(`evict-${index}`)], release);
    }
    expect(release).toHaveBeenCalledExactlyOnceWith("evict-0");
    expect(hasComposerDraftAttachments(uuid(100))).toBe(false);
    expect(hasComposerDraftAttachments(uuid(101))).toBe(true);
  });

  it("releases a deleted conversation's handles, including ones returned after the deletion", () => {
    const release = vi.fn(async () => undefined);
    keepComposerDraftAttachments(uuid(4), [attachment("deleted")], release);
    discardComposerDraftAttachments(uuid(4));
    expect(release).toHaveBeenCalledExactlyOnceWith("deleted");
    keepComposerDraftAttachments(uuid(4), [attachment("late")], release);
    expect(release).toHaveBeenLastCalledWith("late");
    expect(hasComposerDraftAttachments(uuid(4))).toBe(false);
  });

  it("releases every kept handle when the window unloads", () => {
    const release = vi.fn(async (_id: string) => undefined);
    keepComposerDraftAttachments(uuid(5), [attachment("unload-a")], release);
    keepComposerDraftAttachments(uuid(6), [attachment("unload-b")], release);
    window.dispatchEvent(new Event("beforeunload"));
    expect(release.mock.calls.map(([id]) => id).sort()).toEqual(["unload-a", "unload-b"]);
    expect(hasComposerDraftAttachments(uuid(5))).toBe(false);
  });
});

describe("composer attachments across chat switches", () => {
  const attach = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Attach images, documents, or spreadsheets" }));
    await screen.findByText(name);
  };

  it("keeps unsent attachments when the chat changes and restores them on return", async () => {
    const first = conversation(uuid(10));
    const second = conversation(uuid(11));
    const release = vi.fn(async () => undefined);
    const overrides = { onChooseAttachments: async () => lease([attachment("kept")]), onReleaseAttachment: release };
    const view = render(<Composer {...composerProps(first, overrides)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Look at this" } });
    await attach("kept.png");

    view.rerender(<Composer {...composerProps(second, overrides)} />);
    expect(screen.queryByText("kept.png")).toBeNull();
    expect(release).not.toHaveBeenCalled();

    view.rerender(<Composer {...composerProps(first, overrides)} />);
    expect(await screen.findByText("kept.png")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Look at this");

    fireEvent.click(screen.getByRole("button", { name: "Remove attachment kept.png" }));
    await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith("kept"));
    view.rerender(<Composer {...composerProps(second, overrides)} />);
    view.rerender(<Composer {...composerProps(first, overrides)} />);
    expect(screen.queryByText("kept.png")).toBeNull();
  });

  it("restores attachments when the composer is remounted, and blocks moving a chat that holds them to a window", async () => {
    const current = conversation(uuid(12));
    const other = conversation(uuid(13));
    const release = vi.fn(async () => undefined);
    const overrides = { onChooseAttachments: async () => lease([attachment("remounted")]), onReleaseAttachment: release };
    const view = render(<Composer {...composerProps(current, overrides)} />);
    await attach("remounted.png");
    view.unmount();
    expect(release).not.toHaveBeenCalled();
    expect(prepareComposerDetachment(current.id)).toMatchObject({ status: "blocked", blocker: "attachments" });
    expect(prepareComposerDetachment(other.id)).toMatchObject({ status: "ready" });

    render(<Composer {...composerProps(current, overrides)} />);
    expect(await screen.findByText("remounted.png")).toBeInTheDocument();
    expect(release).not.toHaveBeenCalled();
  });

  it("releases a deleted chat's kept attachments", async () => {
    const deleted = conversation(uuid(14));
    const other = conversation(uuid(15));
    const release = vi.fn(async () => undefined);
    const overrides = { onChooseAttachments: async () => lease([attachment("from-deleted")]), onReleaseAttachment: release };
    const view = render(<Composer {...composerProps(deleted, overrides)} />);
    await attach("from-deleted.png");
    view.rerender(<Composer {...composerProps(other, overrides)} />);
    await releaseDeletedComposerQueue(deleted.id, async () => undefined);
    expect(release).toHaveBeenCalledExactlyOnceWith("from-deleted");
  });

  it("never keeps or releases handles an in-flight send owns, and returns them after a failure away from the chat", async () => {
    const first = conversation(uuid(16));
    const second = conversation(uuid(17));
    const sent = deferred<void>();
    const release = vi.fn(async () => undefined);
    const overrides = {
      onSend: () => sent.promise,
      onChooseAttachments: async () => lease([attachment("sending")]),
      onReleaseAttachment: release,
    };
    const view = render(<Composer {...composerProps(first, overrides)} />);
    await attach("sending.png");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Send this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    view.rerender(<Composer {...composerProps(second, overrides)} />);
    expect(hasComposerDraftAttachments(first.id)).toBe(false);

    await act(async () => sent.reject(new Error("send failed")));
    expect(release).not.toHaveBeenCalled();
    expect(hasComposerDraftAttachments(first.id)).toBe(true);
    view.rerender(<Composer {...composerProps(first, overrides)} />);
    expect(await screen.findByText("sending.png")).toBeInTheDocument();
  });

  it("hands queued attachments to the queue even when the chat changes before the queue confirms", async () => {
    const first = conversation(uuid(18));
    const second = conversation(uuid(19));
    const confirmed = deferred<MessageQueueResult>();
    const release = vi.fn(async () => undefined);
    const run = vi.fn<QueueCommandRunner>(async (command) => {
      if (command.type === "message.queue.enqueue") {
        await confirmed.promise;
        return { kind: "message.queue", conversationId: first.id, entries: [], receipt: {
          id: command.payload.id, conversationId: first.id, content: command.payload.content, attachments: [],
          state: "waiting", createdAt: "2026-11-23T00:00:00.000Z", error: null, turnId: null, userMessageId: null,
        } };
      }
      return { kind: "message.queue", conversationId: command.payload.conversationId, entries: [], receipt: null };
    });
    const running = {
      ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
      id: "turn-running", status: "running" as const, harnessId: "codex-app-server" as const,
    };
    const overrides = {
      running: true, latestTurn: running, onQueueCommand: run,
      onChooseAttachments: async () => lease([attachment("queued")]), onReleaseAttachment: release,
    };
    const view = render(<Composer {...composerProps(first, overrides)} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach follow-up images, or documents to queue" }));
    await screen.findByText("queued.png");
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Queue this" } });
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(run.mock.calls.some(([command]) => command.type === "message.queue.enqueue")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment queued.png" }));
    expect(release).not.toHaveBeenCalled();

    view.rerender(<Composer {...composerProps(second, overrides)} />);
    expect(hasComposerDraftAttachments(first.id)).toBe(false);
    await act(async () => confirmed.resolve({ kind: "message.queue", conversationId: first.id, entries: [], receipt: null }));
    expect(release).not.toHaveBeenCalled();
    expect(hasComposerDraftAttachments(first.id)).toBe(false);
  });
});

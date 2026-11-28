import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../src/shared/contracts";
import type { MessageQueueResult } from "../../src/shared/queued-messages";
import { ComposerQueuedActions } from "../../src/renderer/src/components/composer/ComposerQueuedActions";
import {
  composerMediaQueueKey,
  composerQueueKey,
  readComposerQueue,
} from "../../src/renderer/src/components/composer/composerQueuedPrompts";
import type { QueueCommandRunner } from "../../src/renderer/src/components/composer/runtimeQueueClient";

const conversationId = "40404040-4040-4040-8040-404040404040";
const attachment: ChatAttachment = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "saved.png",
  path: "11111111-1111-4111-8111-111111111111",
  mimeType: "image/png",
  size: 128,
};

function seedLegacyEntries(): void {
  window.localStorage.setItem(
    composerQueueKey(conversationId),
    JSON.stringify([
      {
        id: "legacy-1",
        content: "First legacy draft",
        createdAt: "2026-08-21T10:00:00.000Z",
        attachments: [],
      },
      {
        id: "legacy-2",
        content: "Second legacy draft",
        createdAt: "2026-08-21T10:01:00.000Z",
        attachments: [],
      },
    ]),
  );
  window.sessionStorage.setItem(
    composerMediaQueueKey(conversationId),
    JSON.stringify([
      {
        id: "legacy-media",
        content: "Legacy draft with image",
        createdAt: "2026-08-21T10:02:00.000Z",
        attachments: [attachment],
      },
    ]),
  );
}

describe("LegacySavedQueueSection explicit migration (Decision 4.5)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    seedLegacyEntries();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows all legacy drafts under Saved from an earlier version and never sends automatically", async () => {
    const onSendQueued = vi.fn(async () => undefined);
    const onQueueCommand = vi.fn<QueueCommandRunner>(async () => ({
      kind: "message.queue",
      conversationId,
      entries: [],
      receipt: null,
    }));

    render(
      <ComposerQueuedActions
        conversationId={conversationId}
        canSendQueuedNow
        running={false}
        latestTurnId="turn-1"
        latestTurnStatus="completed"
        latestTurnAuthoritative
        queueHost={null}
        onSendQueued={onSendQueued}
        onQueueCommand={onQueueCommand}
        onReleaseAttachment={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("region", { name: "Saved from an earlier version" })).toBeInTheDocument();
    expect(screen.getByText("First legacy draft")).toBeInTheDocument();
    expect(screen.getByText("Second legacy draft")).toBeInTheDocument();
    expect(screen.getByText("Legacy draft with image")).toBeInTheDocument();

    await act(async () => { await Promise.resolve(); });
    expect(onSendQueued).not.toHaveBeenCalled();
    expect(onQueueCommand.mock.calls.filter(([cmd]) => cmd.type !== "message.queue.get")).toHaveLength(0);
  });

  it("moves a legacy item to the runtime queue with a fresh UUID, removes it only after confirmed receipt, and keeps its attachments", async () => {
    const onReleaseAttachment = vi.fn(async () => undefined);
    const onQueueCommand = vi.fn<QueueCommandRunner>(async (command): Promise<MessageQueueResult> => {
      if (command.type === "message.queue.enqueue") {
        return {
          kind: "message.queue",
          conversationId,
          entries: [],
          receipt: {
            id: command.payload.id,
            conversationId,
            content: command.payload.content,
            attachments: command.payload.attachments,
            state: "waiting",
            createdAt: "2026-11-26T00:00:00.000Z",
            error: null,
            turnId: null,
            userMessageId: null,
          },
        };
      }
      return { kind: "message.queue", conversationId, entries: [], receipt: null };
    });

    render(
      <ComposerQueuedActions
        conversationId={conversationId}
        canSendQueuedNow
        running={false}
        latestTurnId="turn-1"
        latestTurnStatus="completed"
        queueHost={null}
        onQueueCommand={onQueueCommand}
        onReleaseAttachment={onReleaseAttachment}
      />,
    );

    const moveMedia = screen.getByRole("button", { name: "Move saved draft 3 of 3 to queue" });
    await act(async () => { fireEvent.click(moveMedia); });

    await waitFor(() => expect(screen.queryByText("Legacy draft with image")).toBeNull());
    const enqueueCall = onQueueCommand.mock.calls.find(([cmd]) => cmd.type === "message.queue.enqueue")?.[0];
    expect(enqueueCall).toBeDefined();
    expect((enqueueCall!.payload as { id: string }).id).not.toBe("legacy-media");
    expect((enqueueCall!.payload as { attachments: ChatAttachment[] }).attachments).toEqual([attachment]);
    expect(onReleaseAttachment).not.toHaveBeenCalled();
    expect(readComposerQueue(conversationId).map(({ id }) => id)).toEqual(["legacy-1", "legacy-2"]);
  });

  it("keeps the local entry when Move to queue fails and releases attachments on Discard", async () => {
    const onReleaseAttachment = vi.fn(async () => undefined);
    const onQueueCommand = vi.fn<QueueCommandRunner>(async (command) => {
      if (command.type === "message.queue.enqueue") throw new Error("Queue is full.");
      return { kind: "message.queue", conversationId, entries: [], receipt: null };
    });

    render(
      <ComposerQueuedActions
        conversationId={conversationId}
        canSendQueuedNow
        running={false}
        latestTurnId="turn-1"
        latestTurnStatus="completed"
        queueHost={null}
        onQueueCommand={onQueueCommand}
        onReleaseAttachment={onReleaseAttachment}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move saved draft 3 of 3 to queue" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Queue is full.");
    expect(readComposerQueue(conversationId)).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Discard saved draft 3 of 3" }));
    await waitFor(() => expect(onReleaseAttachment).toHaveBeenCalledExactlyOnceWith(attachment.id));
    expect(readComposerQueue(conversationId).map(({ id }) => id)).toEqual(["legacy-1", "legacy-2"]);
  });
});

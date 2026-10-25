import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppRuntimeActions } from "../../src/renderer/src/hooks/useAppRuntimeActions";
import { useAsyncOperationQueue } from "../../src/renderer/src/hooks/useConversationSelectionQueue";
import { activeChatCompactAndSend } from "../../src/renderer/src/utils/activeChatCompactAndSend";
import type { ChatAttachment, ConversationCompactAndSendResult, ServerEvent } from "../../src/shared/contracts";

const conversationId = "99999999-9999-4999-8999-999999999999";
const attachment = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "notes.txt",
  path: "/tmp/notes.txt",
  mimeType: "text/plain",
  size: 12,
} as ChatAttachment;

function result(value: ConversationCompactAndSendResult): ServerEvent {
  return { type: "request.result", requestId: "request", result: value } as ServerEvent;
}

const sent: ConversationCompactAndSendResult = {
  kind: "conversation.compact-and-send",
  outcome: "sent",
  conversationId,
  turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userMessageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  disposition: "new-turn",
  compaction: { providerId: "claude", beforeTokens: 252_000, afterTokens: 18_300, instructionForwarded: false, trigger: "on-return" },
};

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("compact and send runtime action", () => {
  it("sends the message payload with the on-return reason and hands the attachments over", async () => {
    const prepareAttachmentHandoff = vi.fn(async () => undefined);
    const finishAttachmentHandoff = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { prepareAttachmentHandoff, finishAttachmentHandoff },
    });
    const sendCommand = vi.fn(async () => result(sent));
    const { result: hook } = renderHook(() => useAppRuntimeActions({
      sendCommand, refreshDetail: vi.fn(), setActionError: vi.fn(), setBusyAction: vi.fn(),
    }));

    let outcome: ConversationCompactAndSendResult | undefined;
    await act(async () => {
      outcome = await hook.current.compactAndSendToConversation(
        conversationId,
        "Pick up again",
        [attachment],
        { fileReferences: [{ path: "src/app.ts" }] },
      );
    });

    expect(outcome).toBe(sent);
    const command = (sendCommand.mock.calls[0] as unknown as [{ type: string; requestId: string; payload: unknown }])[0];
    expect(command.type).toBe("conversation.compact-and-send");
    expect(command.payload).toEqual({
      conversationId,
      content: "Pick up again",
      attachments: [{ id: attachment.id, name: "notes.txt", path: "/tmp/notes.txt", mimeType: "text/plain", size: 12 }],
      activate: true,
      context: { fileReferences: [{ path: "src/app.ts" }] },
      reason: "on-return",
    });
    expect(prepareAttachmentHandoff).toHaveBeenCalledWith({ requestId: command.requestId, attachmentIds: [attachment.id] });
    expect(finishAttachmentHandoff).toHaveBeenCalledWith(command.requestId);
  });

  it("returns a failed compaction without raising a global error", async () => {
    const failed: ConversationCompactAndSendResult = {
      kind: "conversation.compact-and-send",
      conversationId,
      outcome: "compaction-failed",
      message: "Compaction failed. Nothing was sent.",
    };
    const setActionError = vi.fn();
    const { result: hook } = renderHook(() => useAppRuntimeActions({
      sendCommand: vi.fn(async () => result(failed)), refreshDetail: vi.fn(), setActionError, setBusyAction: vi.fn(),
    }));
    await act(async () => {
      await expect(hook.current.compactAndSendToConversation(conversationId, "Again", [])).resolves.toBe(failed);
    });
    expect(setActionError.mock.calls.filter(([value]) => value !== null)).toEqual([]);
    expect(hook.current.sendingConversationIds.has(conversationId)).toBe(false);
  });

  it("rejects an unexpected response", async () => {
    const { result: hook } = renderHook(() => useAppRuntimeActions({
      sendCommand: vi.fn(async () => ({ type: "request.ok", requestId: "request" }) as ServerEvent),
      refreshDetail: vi.fn(),
      setActionError: vi.fn(),
      setBusyAction: vi.fn(),
    }));
    await act(async () => {
      await expect(hook.current.compactAndSendToConversation(conversationId, "Again", []))
        .rejects.toThrow("The local service returned an unexpected compaction response.");
    });
  });
});

describe("compact and send in the active chat", () => {
  it("does not hold the chat selection queue while it compacts", async () => {
    let finish!: (result: ConversationCompactAndSendResult) => void;
    const compactAndSend = vi.fn(() => new Promise<ConversationCompactAndSendResult>((resolve) => { finish = resolve; }));
    const { result: queue } = renderHook(() => useAsyncOperationQueue());
    const send = activeChatCompactAndSend(conversationId, compactAndSend);

    const pending = send("Pick up again", [], undefined);
    expect(compactAndSend).toHaveBeenCalledWith(conversationId, "Pick up again", [], undefined, false);
    const selected = vi.fn(async () => "other chat");
    await act(async () => {
      await expect(queue.current(selected)).resolves.toBe("other chat");
    });
    expect(selected).toHaveBeenCalledOnce();

    finish(sent);
    await expect(pending).resolves.toBe(sent);
  });

  it("refuses without an open chat", async () => {
    const compactAndSend = vi.fn();
    await expect(activeChatCompactAndSend(null, compactAndSend)("Hello", [])).rejects.toThrow("This chat is not ready to send.");
    expect(compactAndSend).not.toHaveBeenCalled();
  });
});

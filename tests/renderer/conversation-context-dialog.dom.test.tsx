import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationContextDialog } from "../../src/renderer/src/components/conversation-context/ConversationContextDialog";
import type {
  ConversationContextPacket,
  ConversationContextSourceTranscript,
} from "../../src/shared/contracts";

const sourceConversationId = "11111111-1111-4111-8111-111111111111";
const targetConversationId = "22222222-2222-4222-8222-222222222222";
const sourceMessageId = "33333333-3333-4333-8333-333333333333";
const packetId = "44444444-4444-4444-8444-444444444444";
const createdAt = "2026-08-19T09:00:00.000Z";

const source: ConversationContextSourceTranscript = {
  conversationId: sourceConversationId,
  projectId: "55555555-5555-4555-8555-555555555555",
  conversationTitle: "Architecture decisions",
  projectName: "Inertia",
  workspaceLabel: "Project checkout · main",
  targetConversationId,
  targetProjectId: "66666666-6666-4666-8666-666666666666",
  targetWorkspaceLabel: "Project checkout · main",
  workspaceRelation: "same-workspace",
  messages: [{
    sourceMessageId,
    sourceTurnId: null,
    role: "user",
    content: "Keep provider identity separate from visible chat context.",
    truncated: false,
    createdAt,
  }],
};

function packet(
  workspaceRelation: "same-workspace" | "different-workspace",
): ConversationContextPacket {
  return {
    id: packetId,
    sourceConversationId,
    targetConversationId,
    sourceProjectId: source.projectId,
    targetProjectId: "66666666-6666-4666-8666-666666666666",
    sourceConversationTitle: source.conversationTitle,
    sourceProjectName: source.projectName,
    sourceWorkspaceLabel: source.workspaceLabel,
    targetWorkspaceLabel: "Project checkout · main",
    workspaceRelation,
    note: null,
    messageCount: 1,
    characterCount: source.messages[0]!.content.length,
    createdAt,
    consumedMessageId: null,
    consumedAt: null,
    sourceState: "available",
    excerpts: source.messages,
  };
}

function result(value: object): object {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: value,
  };
}

beforeEach(() => {
  const rectangle = {} as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
    0: rectangle,
    length: 1,
    item: () => rectangle,
    [Symbol.iterator]: function* iterator() { yield rectangle; },
  } as DOMRectList);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConversationContextDialog", () => {
  it("previews the exact selected excerpt and creates a bounded packet", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    const onClose = vi.fn();
    const onCommand = vi.fn(async (key: string, command: {
      payload: Record<string, unknown>;
    }) => key === "conversation.context.source.load"
      ? result({ kind: "conversation.context.source", source })
      : result({
          kind: "conversation.context.packet",
          packet: packet("same-workspace"),
          command,
        }));

    render(<ConversationContextDialog
      targetConversationId={targetConversationId}
      sources={[{
        conversationId: sourceConversationId,
        conversationTitle: source.conversationTitle,
        projectId: source.projectId,
        projectName: source.projectName,
        workspaceLabel: source.workspaceLabel,
        workspaceRelation: "same-workspace",
        archived: false,
        updatedAt: createdAt,
      }]}
      onCommand={onCommand}
      onResult={onResult}
      onClose={onClose}
    />);

    const dialog = screen.getByRole("dialog", {
      name: "Bring context from another chat",
    });
    expect(within(dialog).getByRole("button", { name: "Close chat context" }))
      .toHaveFocus();
    const excerpt = await within(dialog).findByRole("button", {
      name: /Keep provider identity separate/u,
    });
    await user.click(excerpt);
    expect(within(dialog).getAllByText(source.messages[0]!.content)).toHaveLength(2);

    const attach = within(dialog).getByRole("button", { name: "Attach context" });
    expect(attach).toBeEnabled();
    await user.click(attach);

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({
      kind: "created",
      packet: packet("same-workspace"),
    }));
    expect(onCommand).toHaveBeenLastCalledWith(
      "conversation.context.create",
      expect.objectContaining({
        payload: expect.objectContaining({
          sourceConversationId,
          targetConversationId,
          sourceMessageIds: [sourceMessageId],
          acknowledgedWorkspaceDifference: false,
        }),
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires cross-workspace acknowledgement and traps keyboard focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCommand = vi.fn(async (key: string) =>
      key === "conversation.context.source.load"
        ? result({
            kind: "conversation.context.source",
            source: { ...source, workspaceRelation: "different-workspace" },
          })
        : result({
            kind: "conversation.context.packet",
            packet: packet("different-workspace"),
          }));
    render(<ConversationContextDialog
      targetConversationId={targetConversationId}
      sources={[{
        conversationId: sourceConversationId,
        conversationTitle: source.conversationTitle,
        projectId: source.projectId,
        projectName: source.projectName,
        workspaceLabel: source.workspaceLabel,
        workspaceRelation: "different-workspace",
        archived: false,
        updatedAt: createdAt,
      }]}
      onCommand={onCommand}
      onResult={vi.fn()}
      onClose={onClose}
    />);

    const dialog = screen.getByRole("dialog");
    await user.click(await within(dialog).findByRole("button", {
      name: /Keep provider identity separate/u,
    }));
    const attach = within(dialog).getByRole("button", { name: "Attach context" });
    expect(attach).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    expect(attach).toBeEnabled();

    const close = within(dialog).getByRole("button", { name: "Close chat context" });
    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(attach).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

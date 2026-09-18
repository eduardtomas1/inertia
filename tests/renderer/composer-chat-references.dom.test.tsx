import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ConversationContextPacketSummary,
  ServerEvent,
} from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";

import { composerProps, conversation } from "./composer-fixtures";

const sourceOption = {
  conversationId: "44444444-4444-4444-8444-444444444444",
  conversationTitle: "Architecture decisions",
  projectName: "Inertia",
  workspaceRelation: "same-workspace" as const,
  archived: false,
};

function packetResult(): ServerEvent {
  return {
    type: "request.result",
    requestId: "55555555-5555-4555-8555-555555555555",
    result: { kind: "conversation.context.packet", packet: packetSummary() },
  } as unknown as ServerEvent;
}

function packetSummary(
  overrides: Partial<ConversationContextPacketSummary> = {},
): ConversationContextPacketSummary {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    sourceConversationId: sourceOption.conversationId,
    targetConversationId: "66666666-6666-4666-8666-666666666666",
    sourceProjectId: "77777777-7777-4777-8777-777777777777",
    targetProjectId: "88888888-8888-4888-8888-888888888888",
    sourceConversationTitle: sourceOption.conversationTitle,
    sourceProjectName: sourceOption.projectName,
    sourceWorkspaceLabel: "Project checkout · main",
    targetWorkspaceLabel: "Project checkout · main",
    workspaceRelation: "same-workspace",
    note: null,
    messageCount: 23,
    characterCount: 4096,
    droppedMessageCount: 0,
    createdAt: "2026-08-19T09:30:00.000Z",
    consumedMessageId: null,
    consumedAt: null,
    sourceState: "available",
    ...overrides,
  };
}

describe("composer chat references", () => {
  it("references a whole chat from the mention menu without naming messages", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => packetResult());
    const current = conversation("chat-reference");
    render(<Composer {...composerProps(current, {
      contextSources: [sourceOption],
      onConversationContextCommand: onCommand,
    })} />);

    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "@Architect");
    const suggestions = await screen.findByRole("listbox", {
      name: "Chats and project files",
    });
    expect(within(suggestions).getByText("Reference a chat"))
      .toBeInTheDocument();

    await user.click(within(suggestions).getByRole("option", {
      name: /Architecture decisions/u,
    }));

    expect(editor).toHaveValue("");
    expect(onCommand).toHaveBeenCalledWith("conversation.context.create", {
      type: "conversation.context.create",
      payload: {
        sourceConversationId: sourceOption.conversationId,
        targetConversationId: current.id,
        acknowledgedWorkspaceDifference: false,
      },
    });
  });

  it("keeps the file mention menu unlabelled as chats when none match", async () => {
    const user = userEvent.setup();
    const current = conversation("chat-reference-files-only");
    render(<Composer {...composerProps(current, {
      mentionResults: [{ path: "src/first.ts", kind: "file" }],
      contextSources: [sourceOption],
      onConversationContextCommand: vi.fn(async () => packetResult()),
    })} />);

    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "@src");
    expect(await screen.findByRole("listbox", { name: "Project files" }))
      .toBeInTheDocument();
  });

  it("states how many oldest messages the budget omitted", () => {
    const current = conversation("chat-reference-chip");
    render(<Composer {...composerProps(current, {
      contextPackets: [packetSummary({
        targetConversationId: current.id,
        droppedMessageCount: 7,
      })],
      onConversationContextCommand: vi.fn(async () => packetResult()),
    })} />);

    expect(screen.getByText(/7 oldest omitted/u)).toBeInTheDocument();
  });

  it("answers an agent context request without reopening a picker panel", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => ({
      type: "request.ok",
      requestId: "99999999-9999-4999-8999-999999999999",
    } as unknown as ServerEvent));
    const current = conversation("chat-reference-agent");
    render(<Composer {...composerProps(current, {
      contextSources: [sourceOption],
      agentContextRequest: {
        requestId: "11111111-1111-4111-8111-111111111111",
        targetConversationId: current.id,
        targetTurnId: "22222222-2222-4222-8222-222222222222",
        requestedSourceConversationId: sourceOption.conversationId,
        createdAt: "2026-08-19T09:30:00.000Z",
        expiresAt: "2026-08-19T09:35:00.000Z",
      },
      onConversationContextCommand: onCommand,
    })} />);

    const card = await screen.findByRole("region", {
      name: "Agent requested chat context",
    });
    await user.click(within(card).getByRole("button", { name: "Decline" }));

    expect(onCommand).toHaveBeenCalledWith("conversation.context.agent.respond", {
      type: "conversation.context.agent.respond",
      payload: {
        decision: "cancel",
        contextRequestId: "11111111-1111-4111-8111-111111111111",
        targetConversationId: current.id,
      },
    });
  });

  it("shares the whole preselected chat when the agent request is approved", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => ({
      type: "request.ok",
      requestId: "99999999-9999-4999-8999-999999999999",
    } as unknown as ServerEvent));
    const current = conversation("chat-reference-agent-share");
    render(<Composer {...composerProps(current, {
      contextSources: [sourceOption],
      agentContextRequest: {
        requestId: "11111111-1111-4111-8111-111111111111",
        targetConversationId: current.id,
        targetTurnId: "22222222-2222-4222-8222-222222222222",
        requestedSourceConversationId: sourceOption.conversationId,
        createdAt: "2026-08-19T09:30:00.000Z",
        expiresAt: "2026-08-19T09:35:00.000Z",
      },
      onConversationContextCommand: onCommand,
    })} />);

    const card = await screen.findByRole("region", {
      name: "Agent requested chat context",
    });
    await user.click(within(card).getByRole("button", { name: "Share whole chat" }));

    expect(onCommand).toHaveBeenCalledWith("conversation.context.agent.respond", {
      type: "conversation.context.agent.respond",
      payload: {
        decision: "select",
        contextRequestId: "11111111-1111-4111-8111-111111111111",
        sourceConversationId: sourceOption.conversationId,
        targetConversationId: current.id,
        acknowledgedWorkspaceDifference: false,
      },
    });
  });
});

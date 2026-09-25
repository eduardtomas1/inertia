import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationContextPacketSummary,
  ServerEvent,
} from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { ComposerConversationContextPreview, type ComposerConversationContextController } from "../../src/renderer/src/components/composer/useComposerConversationContext";
import { ConversationContextPreviewCard, ConversationContextRequestCard } from "../../src/renderer/src/components/composer/ComposerConversationContextCards";

import { composerProps, conversation, deferred } from "./composer-fixtures";

const sourceOption = {
  conversationId: "44444444-4444-4444-8444-444444444444",
  conversationTitle: "Architecture decisions",
  projectName: "Inertia",
  workspaceLabel: "/workspace/inertia",
  targetWorkspaceLabel: "/workspace/inertia",
  workspaceRelation: "same-workspace" as const,
  archived: false,
};

function packetResult(targetConversationId?: string): ServerEvent {
  return {
    type: "request.result",
    requestId: "55555555-5555-4555-8555-555555555555",
    result: { kind: "conversation.context.packet", packet: packetSummary(targetConversationId ? { targetConversationId } : {}) },
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

afterEach(() => vi.unstubAllGlobals());

describe("composer chat references", () => {
  it("keeps a cross-workspace mention until the user confirms the named source and destination", async () => {
    const user = userEvent.setup();
    const current = conversation("cross-workspace-reference");
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    const onCommand = vi.fn(async () => packetResult(current.id));
    render(<Composer {...composerProps(current, {
      contextSources: [{ ...sourceOption, workspaceRelation: "different-workspace", workspaceLabel: "/workspace/other" }],
      onConversationContextCommand: onCommand,
    })} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "Explain @Architect");
    const option = await screen.findByRole("option", { name: /Architecture decisions/u });
    await user.click(option);
    expect(onCommand).not.toHaveBeenCalled();
    expect(editor).toHaveValue("Explain @Architect");
    const dialog = await screen.findByRole("alertdialog", { name: "Share context from another workspace?" });
    expect(dialog).toHaveTextContent("/workspace/other");
    expect(dialog).toHaveTextContent("/workspace/inertia");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
    // The mention remains available for another deliberate selection.
    fireEvent.change(editor, { target: { value: "Explain @Architec" } });
    await user.click(await screen.findByRole("option", { name: /Architecture decisions/u }));
    await user.click(screen.getByRole("button", { name: "Share chat" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(editor).toHaveFocus();
    expect(onCommand).toHaveBeenCalledWith("conversation.context.create", expect.objectContaining({
      payload: expect.objectContaining({ acknowledgedWorkspaceDifference: true }),
    }));
  });

  it("returns focus to the editor as soon as sharing is confirmed, before the reference settles", async () => {
    const user = userEvent.setup();
    const current = conversation("slow-cross-workspace-reference");
    const pending = deferred<ServerEvent>();
    const onCommand = vi.fn(() => pending.promise);
    render(<Composer {...composerProps(current, {
      contextSources: [{ ...sourceOption, workspaceRelation: "different-workspace", workspaceLabel: "/workspace/other" }],
      onConversationContextCommand: onCommand,
    })} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "Explain @Architect");
    await user.click(await screen.findByRole("option", { name: /Architecture decisions/u }));
    await user.click(await screen.findByRole("button", { name: "Share chat" }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(onCommand).toHaveBeenCalledOnce();
    expect(editor).toHaveFocus();
    await act(async () => { pending.resolve(packetResult(current.id)); });
    expect(editor).toHaveFocus();
  });

  it.each(["conversation", "project"])("cancels unconfirmed sharing when the %s changes", async (change) => {
    const user = userEvent.setup();
    const current = conversation(`reference-owner-${change}`);
    const onCommand = vi.fn();
    const props = { contextSources: [{ ...sourceOption, workspaceRelation: "different-workspace" as const }],
      onConversationContextCommand: onCommand };
    const view = render(<Composer {...composerProps(current, props)} />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Explain @Architect");
    await user.click(await screen.findByRole("option", { name: /Architecture decisions/u }));
    await screen.findByRole("alertdialog");
    view.rerender(<Composer {...composerProps({ ...current,
      ...(change === "conversation" ? { id: "next-chat" } : { projectId: "next-project" }),
    }, props)} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => {});
    expect(onCommand).not.toHaveBeenCalled();
    const editor = screen.getByLabelText("Message", { exact: true });
    await user.clear(editor);
    await user.type(editor, "Continue here");
    expect(editor).toHaveValue("Continue here");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    view.rerender(<Composer {...composerProps(current, props)} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it.each(["rejected", "unavailable", "wrong-owner"])("ends a %s preview load and allows retry and dismissal", async (failure) => {
    const user = userEvent.setup();
    const valid: ServerEvent = { type: "request.result", requestId: "preview", result: {
      kind: "conversation.context.packet", packet: { ...packetSummary(), excerpts: [] },
    } };
    const onCommand = vi.fn().mockImplementationOnce(async () => {
      if (failure === "rejected") throw new Error("disconnected");
      if (failure === "unavailable") return { type: "request.ok", requestId: "preview" };
      return { ...valid, result: { kind: "conversation.context.packet", packet: {
        ...packetSummary({ targetConversationId: "another-chat" }), excerpts: [],
      } } };
    }).mockResolvedValue(valid);
    const onDismiss = vi.fn();
    render(<ConversationContextPreviewCard packetId={packetSummary().id}
      targetConversationId={packetSummary().targetConversationId} onCommand={onCommand} onDismiss={onDismiss} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Loading the exact shared excerpt…")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry preview" }));
    await screen.findByText(sourceOption.conversationTitle);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each([false, true])("requires informed cross-workspace sharing and resets consent when the source changes (preselected: %s)", async (preselected) => {
    const user = userEvent.setup();
    const other = { ...sourceOption, conversationId: "other", projectName: "Other project",
      workspaceLabel: "/workspace/other", workspaceRelation: "different-workspace" as const };
    const onCommand = vi.fn().mockResolvedValue({ type: "request.ok", requestId: "reply" });
    const request = { requestId: "request", targetConversationId: "target", targetTurnId: "turn",
      requestedSourceConversationId: preselected ? other.conversationId : null, createdAt: "now", expiresAt: "later" };
    const view = render(<ConversationContextRequestCard request={request} sources={[sourceOption, other]} onCommand={onCommand} />);
    if (!preselected) await user.selectOptions(screen.getByRole("combobox"), other.conversationId);
    expect(screen.getByRole("button", { name: "Share chat" })).toBeDisabled();
    expect(screen.getByText(/From Other project/u)).toHaveTextContent("/workspace/other");
    expect(screen.getByText(/From Other project/u)).toHaveTextContent("/workspace/inertia");
    expect(onCommand).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox"));
    if (preselected) {
      view.rerender(<ConversationContextRequestCard request={request}
        sources={[sourceOption, { ...other, workspaceLabel: "/workspace/moved" }]} onCommand={onCommand} />);
    } else {
      await user.selectOptions(screen.getByRole("combobox"), sourceOption.conversationId);
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Share chat" })).toBeEnabled();
      await user.selectOptions(screen.getByRole("combobox"), other.conversationId);
    }
    expect(screen.getByRole("button", { name: "Share chat" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Share chat" }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("conversation.context.agent.respond", expect.objectContaining({
      payload: expect.objectContaining({ decision: "select", sourceConversationId: other.conversationId,
        acknowledgedWorkspaceDifference: true }),
    }));
  });

  it("allows declining a preselected cross-workspace request without authorizing a share", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockResolvedValue({ type: "request.ok", requestId: "reply" });
    render(<ConversationContextRequestCard request={{ requestId: "request", targetConversationId: "target",
      targetTurnId: "turn", requestedSourceConversationId: sourceOption.conversationId, createdAt: "now", expiresAt: "later" }}
    sources={[{ ...sourceOption, workspaceRelation: "different-workspace", workspaceLabel: "/workspace/other" }]}
    onCommand={onCommand} />);
    expect(screen.getByRole("button", { name: "Share chat" })).toBeDisabled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("conversation.context.agent.respond", {
      type: "conversation.context.agent.respond",
      payload: { decision: "cancel", contextRequestId: "request", targetConversationId: "target" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Request declined.");
  });

  it.each(["Share chat", "Decline"])("retains the selected source after a failed %s and allows retry", async (action) => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValue({ type: "request.ok", requestId: "reply" });
    render(<ConversationContextRequestCard request={{ requestId: "request", targetConversationId: "target",
      targetTurnId: "turn", requestedSourceConversationId: null, createdAt: "now", expiresAt: "later" }}
    sources={[sourceOption]} onCommand={onCommand} />);
    await user.selectOptions(screen.getByRole("combobox"), sourceOption.conversationId);
    await user.click(screen.getByRole("button", { name: action }));
    await screen.findByRole("alert");
    expect(screen.getByRole("combobox")).toHaveValue(sourceOption.conversationId);
    await user.click(screen.getByRole("button", { name: action }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: action })).toBeDisabled();
    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it("reloads an open preview when the shared selection changes and labels shortened text", async () => {
    const responses = [deferred<ServerEvent>(), deferred<ServerEvent>()];
    const onCommand = vi.fn().mockImplementationOnce(() => responses[0]!.promise)
      .mockImplementationOnce(() => responses[1]!.promise);
    const props = { packetId: packetSummary().id, targetConversationId: packetSummary().targetConversationId, onCommand };
    const event = (content: string, count: number): ServerEvent => ({
      type: "request.result", requestId: "preview",
      result: { kind: "conversation.context.packet", packet: {
        ...packetSummary({ messageCount: count }),
        excerpts: [{ sourceMessageId: "message", role: "assistant", content, truncated: true }],
      } },
    } as unknown as ServerEvent);
    const preview = (contextPacketIds: string[]) => <ComposerConversationContextPreview
      targetConversationId={props.targetConversationId} onCommand={onCommand}
      controller={{ previewPacketId: props.packetId, contextPacketIds } as ComposerConversationContextController}
    />;
    const view = render(preview(["first"]));
    await screen.findByText("Loading the exact shared excerpt…");
    await act(async () => responses[0]!.resolve(event("Initial larger selection", 22)));
    expect(screen.getByText("Initial larger selection")).toBeVisible();
    expect(screen.getByText("Message shortened to fit the shared context.")).toBeVisible();
    view.rerender(preview(["first", "second"]));
    expect(screen.queryByText("Initial larger selection")).not.toBeInTheDocument();
    await act(async () => responses[1]!.resolve(event("Actual smaller selection", 11)));
    expect(screen.getByText("Actual smaller selection")).toBeVisible();
    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it("waits for both reference creation and detail hydration before sending", async () => {
    const user = userEvent.setup();
    const pending = deferred<ServerEvent>();
    const current = conversation("reference-pending");
    const onCommand = vi.fn(() => pending.promise);
    const onSend = vi.fn(async () => undefined);
    const props = composerProps(current, { contextSources: [sourceOption], onConversationContextCommand: onCommand, onSend });
    const view = render(<Composer {...props} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "Explain @Architect");
    await user.click(within(await screen.findByRole("listbox", { name: "Chats and project files" }))
      .getByRole("option", { name: /Architecture decisions/u }));
    expect(editor).toHaveValue("Explain @Architect");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.click(editor);
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => pending.resolve(packetResult(current.id)));
    expect(editor).toHaveValue("Explain ");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    view.rerender(<Composer {...props} contextPackets={[packetSummary({ targetConversationId: current.id })]} />);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith("Explain", [], {
      conversationContextPacketIds: [packetSummary().id],
    });
  });

  it("preserves an edit made as the reference request completes", async () => {
    const user = userEvent.setup();
    const pending = deferred<ServerEvent>();
    const current = conversation("reference-edited");
    render(<Composer {...composerProps(current, {
      contextSources: [sourceOption], onConversationContextCommand: () => pending.promise,
    })} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "Explain @Architect");
    await user.click(within(await screen.findByRole("listbox", { name: "Chats and project files" }))
      .getByRole("option", { name: /Architecture decisions/u }));
    await act(async () => {
      fireEvent.change(editor, { target: { value: "Updated instructions" } });
      pending.resolve(packetResult(current.id));
    });
    expect(editor).toHaveValue("Updated instructions");
  });

  it("retains the mention when reference creation fails", async () => {
    const user = userEvent.setup();
    const current = conversation("reference-failed");
    render(<Composer {...composerProps(current, {
      contextSources: [sourceOption], onConversationContextCommand: vi.fn(async () => { throw new Error("disconnected"); }),
    })} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "Explain @Architect");
    await user.click(within(await screen.findByRole("listbox", { name: "Chats and project files" }))
      .getByRole("option", { name: /Architecture decisions/u }));
    expect(editor).toHaveValue("Explain @Architect");
    expect(screen.getByRole("alert")).toHaveTextContent("could not be referenced");
    expect(screen.queryByText("Adding chat reference…")).not.toBeInTheDocument();
  });

  it("does not clear a different chat's draft when an earlier reference completes", async () => {
    const user = userEvent.setup();
    const pending = deferred<ServerEvent>();
    const first = conversation("reference-first");
    const second = conversation("reference-second");
    const onCommand = vi.fn(() => pending.promise);
    const options = { contextSources: [sourceOption], onConversationContextCommand: onCommand };
    const view = render(<Composer {...composerProps(first, options)} />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "@Architect");
    await user.click(within(await screen.findByRole("listbox", { name: "Chats and project files" }))
      .getByRole("option", { name: /Architecture decisions/u }));
    view.rerender(<Composer {...composerProps(second, options)} />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Another draft");
    await act(async () => pending.resolve(packetResult(first.id)));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Another draft");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    view.rerender(<Composer {...composerProps(first, options)} />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("references a whole chat from the mention menu without naming messages", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(async () => packetResult(current.id));
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

  it("states how many messages the budget omitted", () => {
    const current = conversation("chat-reference-chip");
    render(<Composer {...composerProps(current, {
      contextPackets: [packetSummary({
        targetConversationId: current.id,
        droppedMessageCount: 7,
      })],
      onConversationContextCommand: vi.fn(async () => packetResult()),
    })} />);

    expect(screen.getByText(/23 messages · 7 omitted/u)).toBeInTheDocument();
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
    await user.click(within(card).getByRole("button", { name: "Share chat" }));

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

  it("references this chat from the mention menu once it has visible history", async () => {
    const user = userEvent.setup();
    const current = conversation("importer-plan");
    const onCommand = vi.fn(async () => ({
      type: "request.result",
      requestId: "55555555-5555-4555-8555-555555555555",
      result: {
        kind: "conversation.context.packet",
        packet: packetSummary({ sourceConversationId: current.id, targetConversationId: current.id }),
      },
    } as unknown as ServerEvent));
    const props = composerProps(current, {
      contextSources: [sourceOption],
      onConversationContextCommand: onCommand,
    });
    const view = render(<Composer {...props} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "@this");
    expect(screen.queryByRole("option", { name: /This chat/u })).not.toBeInTheDocument();

    view.rerender(<Composer {...props} hasVisibleHistory />);
    await user.clear(editor);
    await user.type(editor, "Recover @this-chat");
    const option = within(await screen.findByRole("listbox", { name: "Chats and project files" }))
      .getByRole("option", { name: /This chat/u });
    expect(option).toHaveTextContent("Earlier messages · importer-plan");
    await user.click(option);

    expect(editor).toHaveValue("Recover ");
    expect(onCommand).toHaveBeenCalledWith("conversation.context.create", {
      type: "conversation.context.create",
      payload: {
        sourceConversationId: current.id,
        targetConversationId: current.id,
        acknowledgedWorkspaceDifference: false,
      },
    });
  });

  it("labels this chat's reference and offers each chat once, up to three references", async () => {
    const user = userEvent.setup();
    const current = conversation("importer-plan");
    const review = {
      ...sourceOption,
      conversationId: "99999999-9999-4999-8999-999999999999",
      conversationTitle: "Architecture review",
    };
    const own = packetSummary({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceConversationId: current.id,
      targetConversationId: current.id,
      droppedMessageCount: 4,
    });
    const fromSource = packetSummary({ targetConversationId: current.id });
    const props = composerProps(current, {
      contextSources: [sourceOption, review],
      contextPackets: [own, fromSource],
      hasVisibleHistory: true,
      onConversationContextCommand: vi.fn(async () => packetResult()),
    });
    const view = render(<Composer {...props} />);

    expect(screen.getByRole("button", { name: /^This chat/u })).toBeVisible();
    expect(screen.getByText("Earlier messages · 23 messages · 4 omitted")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove this chat's earlier messages" })).toBeVisible();
    const editor = screen.getByRole("textbox", { name: "Message" });
    await user.type(editor, "@Archi");
    const options = within(await screen.findByRole("listbox", { name: "Chats and project files" }))
      .getAllByRole("option");
    expect(options.map(({ textContent }) => textContent)).toEqual([
      expect.stringContaining("Architecture review"),
    ]);
    await user.clear(editor);
    await user.type(editor, "@this");
    expect(screen.queryByRole("option", { name: /This chat/u })).not.toBeInTheDocument();

    view.rerender(<Composer {...props} contextPackets={[own, fromSource, packetSummary({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sourceConversationId: review.conversationId,
      targetConversationId: current.id,
    })]} />);
    await user.clear(editor);
    await user.type(editor, "@Archi");
    expect(screen.queryByRole("listbox", { name: "Chats and project files" })).not.toBeInTheDocument();
  });

  it("shows where earlier messages and intermediate updates were left out", async () => {
    const onCommand = vi.fn(async () => ({
      type: "request.result",
      requestId: "preview",
      result: {
        kind: "conversation.context.packet",
        packet: {
          ...packetSummary({ messageCount: 2, droppedMessageCount: 15 }),
          excerpts: [
            { sourceMessageId: "opening", role: "user", content: "Build the importer.", truncated: false },
            { sourceMessageId: "latest", role: "assistant", content: "Phase one shipped.", truncated: false },
          ],
          omissions: { earlierMessages: 12, intermediateAgentUpdates: 3, gapIndex: 1 },
        },
      },
    } as unknown as ServerEvent));
    render(<ConversationContextPreviewCard
      packetId={packetSummary().id}
      targetConversationId={packetSummary().targetConversationId}
      onCommand={onCommand}
      onDismiss={() => undefined}
    />);

    const items = await screen.findAllByRole("listitem");
    expect(items.map(({ textContent }) => textContent)).toEqual([
      expect.stringContaining("Build the importer."),
      "12 earlier messages omitted",
      expect.stringContaining("Phase one shipped."),
    ]);
    expect(screen.getByText("3 intermediate agent updates left out so more turns fit.")).toBeVisible();
  });

  it("marks omitted later messages after the only retained opening request", async () => {
    const onCommand = vi.fn(async () => ({
      type: "request.result",
      requestId: "preview",
      result: {
        kind: "conversation.context.packet",
        packet: {
          ...packetSummary({ messageCount: 1, droppedMessageCount: 9 }),
          excerpts: [
            { sourceMessageId: "opening", role: "user", content: "Build the importer.", truncated: false },
          ],
          omissions: { earlierMessages: 9, intermediateAgentUpdates: 0, gapIndex: 1 },
        },
      },
    } as unknown as ServerEvent));
    render(<ConversationContextPreviewCard
      packetId={packetSummary().id}
      targetConversationId={packetSummary().targetConversationId}
      onCommand={onCommand}
      onDismiss={() => undefined}
    />);

    const items = await screen.findAllByRole("listitem");
    expect(items.map(({ textContent }) => textContent)).toEqual([
      expect.stringContaining("Build the importer."),
      "9 earlier messages omitted",
    ]);
  });
});

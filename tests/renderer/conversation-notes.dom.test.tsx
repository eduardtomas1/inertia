import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationNotes } from "../../src/renderer/src/components/ConversationNotes";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const id = () => crypto.randomUUID();
function result(conversationId: string, content = "", revision = 0, outcome: "loaded" | "saved" | "conflict" = "loaded"): ServerEvent {
  return { type: "request.result", requestId: id(), result: { kind: "conversation.notes", outcome, note: { conversationId, content, revision, updatedAt: revision ? "2026-09-01T10:00:00.000Z" : null } } };
}
function deferred() {
  let resolve!: (event: ServerEvent) => void;
  const promise = new Promise<ServerEvent>((done) => { resolve = done; });
  return { promise, resolve };
}
const edit = (content: string) => fireEvent.change(screen.getByRole("textbox", { name: "Chat notes" }), { target: { value: content } });

describe("chat notes editor", () => {
  it("saves with the keyboard and preserves edits made while the save is pending", async () => {
    const conversationId = id(); const pending = deferred();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValueOnce(result(conversationId)).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result(conversationId, "Newer draft", 2, "saved"));
    render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    edit("First draft");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "s", ctrlKey: true });
    edit("Newer draft");
    await act(async () => { pending.resolve(result(conversationId, "First draft", 1, "saved")); });
    expect(screen.getByRole("textbox")).toHaveValue("Newer draft");
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { conversationId, content: "Newer draft", expectedRevision: 1 } })));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
  });

  it("preserves drafts on failure and navigation without leaking late responses to another chat", async () => {
    const first = id(); const second = id(); const pending = deferred();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValueOnce(result(first)).mockRejectedValueOnce(new Error("Disconnected"))
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result(first));
    const view = render(<ConversationNotes conversationId={first} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    edit("Keep this draft"); fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await screen.findByText("Disconnected");
    view.rerender(<ConversationNotes conversationId={second} online sendCommand={send} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
    view.rerender(<ConversationNotes conversationId={first} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save notes" })).not.toHaveAttribute("aria-disabled"));
    await act(async () => { pending.resolve(result(second, "Other chat", 1)); });
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("requires an explicit choice after a concurrent edit and retries against the current revision", async () => {
    const conversationId = id();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValueOnce(result(conversationId, "Original", 1))
      .mockResolvedValueOnce(result(conversationId, "Other window", 2, "conflict"))
      .mockResolvedValueOnce(result(conversationId, "My draft", 3, "saved"));
    render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Original"));
    edit("My draft"); fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await screen.findByText("Notes changed in another window.");
    expect(screen.getByRole("textbox")).toHaveValue("My draft");
    expect(screen.getByRole("button", { name: "Save notes" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Replace with my draft" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { conversationId, content: "My draft", expectedRevision: 2 } }));
  });

  it("keeps offline edits and reconciles them on reconnect without discarding a changed saved note", async () => {
    const conversationId = id();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValueOnce(result(conversationId, "Original", 1))
      .mockResolvedValueOnce(result(conversationId, "Updated elsewhere", 2));
    const view = render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Original"));
    view.rerender(<ConversationNotes conversationId={conversationId} online={false} sendCommand={send} />);
    edit("Offline work");
    expect(screen.getByRole("button", { name: "Save notes" })).toHaveAttribute("aria-disabled", "true");
    view.rerender(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    await screen.findByText("Notes changed in another window.");
    expect(screen.getByRole("textbox")).toHaveValue("Offline work");
    fireEvent.click(screen.getByRole("button", { name: "Use saved notes" }));
    expect(screen.getByRole("textbox")).toHaveValue("Updated elsewhere");
  });

  it("restores the newest draft when session storage rejects a later write", async () => {
    const conversationId = id();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValue(result(conversationId));
    const first = render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    edit("Older draft");
    const storage = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    try {
      edit("Newest draft");
      first.unmount();
      render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Save notes" })).not.toHaveAttribute("aria-disabled"));
      expect(screen.getByRole("textbox")).toHaveValue("Newest draft");
    } finally { storage.mockRestore(); }
  });

  it("does not resurrect a saved draft when session storage rejects removal", async () => {
    const conversationId = id();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValueOnce(result(conversationId))
      .mockResolvedValueOnce(result(conversationId, "Saved draft", 1, "saved"))
      .mockResolvedValueOnce(result(conversationId, "Updated elsewhere", 2));
    const first = render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    edit("Saved draft");
    const storage = vi.spyOn(window.sessionStorage, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
      first.unmount();
      render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Updated elsewhere"));
      expect(screen.queryByText("Notes changed in another window.")).not.toBeInTheDocument();
    } finally { storage.mockRestore(); }
  });

  it("keeps Save notes focusable while it saves and once the note is saved", async () => {
    const conversationId = id(); const pending = deferred();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValueOnce(result(conversationId)).mockReturnValueOnce(pending.promise);
    render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    const button = screen.getByRole("button", { name: "Save notes" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    edit("Draft");
    expect(button).not.toHaveAttribute("aria-disabled");
    button.focus(); fireEvent.click(button);
    expect(screen.getByRole("status")).toHaveTextContent("Syncing…");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(result(conversationId, "Draft", 1, "saved")); });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
  });

  it("labels the refresh control and bounds the saved copy in a conflict", async () => {
    const conversationId = id();
    const send = vi.fn<(command: ClientCommand) => Promise<ServerEvent>>()
      .mockResolvedValueOnce(result(conversationId, "Original", 1))
      .mockResolvedValueOnce(result(conversationId, "Other window", 2, "conflict"));
    render(<ConversationNotes conversationId={conversationId} online sendCommand={send} />);
    expect(screen.getByRole("button", { name: "Refresh notes" })).toHaveAttribute("title", "Refresh notes");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Chat notes" })).toHaveValue("Original"));
    edit("My draft"); fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await screen.findByText("Notes changed in another window.");
    const copy = screen.getByRole("region", { name: "Saved notes" });
    expect(copy).toHaveTextContent("Other window");
    expect(copy).toHaveAttribute("tabindex", "0");
  });

});

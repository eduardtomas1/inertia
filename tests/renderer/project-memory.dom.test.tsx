import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectMemoryPanel from "../../src/renderer/src/components/project-memory/ProjectMemoryPanel";
import ProjectMemoryDialog from "../../src/renderer/src/components/project-memory/ProjectMemoryDialog";
import { ProjectMemoryHost } from "../../src/renderer/src/components/project-memory/ProjectMemoryHost";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ProjectMemoryCommandRunner } from "../../src/renderer/src/components/project-memory/types";
import type { ChatMessage, ServerEvent } from "../../src/shared/contracts";
import { projectMemoryContext, type ProjectMemoryState } from "../../src/shared/project-memory";
import { composerProps, conversation, deferred } from "./composer-fixtures";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const message: ChatMessage = { id: crypto.randomUUID(), conversationId, turnId: null, role: "assistant", content: "Use the saved billing snapshot.", attachments: [], createdAt: "2026-09-01T00:00:00.000Z" };
const empty: ProjectMemoryState = { projectId, conversationId, revision: 0, chatRevision: 0, entries: [], disabledIds: [], unavailableSourceIds: [], context: null };
const populated: ProjectMemoryState = { ...empty, revision: 1, entries: [{ id: crypto.randomUUID(), kind: "decision", title: "Billing history", text: message.content, reason: "Events omit prior-cycle changes.", source: { conversationId, messageId: message.id, conversationTitle: "Billing investigation" }, createdAt: message.createdAt, updatedAt: message.createdAt }] };
populated.context = projectMemoryContext(populated);
const result = (state: ProjectMemoryState): ServerEvent => ({ type: "request.result", requestId: "memory", result: { kind: "project.memory", state } });
const props = { projectId, conversationId, projectName: "Billing" };

describe("project memory panel", () => {
  it("opens project memory from inside the composer context controls", async () => {
    const request = vi.fn<ProjectMemoryCommandRunner>().mockResolvedValue(result(empty));
    render(<ProjectMemoryHost {...props} request={request}>
      <Composer {...composerProps(conversation(conversationId))} />
    </ProjectMemoryHost>);
    const trigger = screen.getByRole("button", { name: "Rules & decisions" });
    expect(screen.getByRole("region", { name: "Message composer" })).toContainElement(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Project memory" })).toBeInTheDocument();
  });

  it("requires curation and retains a failed draft across refresh, saving against the new revision", async () => {
    const request = vi.fn<ProjectMemoryCommandRunner>().mockResolvedValue(result(empty));
    render(<ProjectMemoryPanel {...props} request={request} sourceMessage={message} />);
    await screen.findByRole("textbox", { name: "Title" });
    expect(screen.getByLabelText("Rule or decision")).toHaveValue(message.content);
    expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Billing history" } });
    fireEvent.change(screen.getByLabelText("Why it matters"), { target: { value: "Preserves previous-cycle changes" } });
    request.mockRejectedValueOnce(new Error("Project memory changed in another window."));
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("another window");
    request.mockResolvedValueOnce(result({ ...empty, revision: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh project memory" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Why it matters")).toHaveValue("Preserves previous-cycle changes");
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ type: "project.memory.save", payload: expect.objectContaining({ expectedRevision: 2, source: { conversationId, messageId: message.id } }) })));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument());
  });

  it("previews sent text and excludes an entry only in the current chat", async () => {
    const request = vi.fn<ProjectMemoryCommandRunner>().mockResolvedValue(result(populated));
    render(<ProjectMemoryPanel {...props} request={request} />);
    await screen.findByText("Billing history");
    fireEvent.click(screen.getByRole("button", { name: "Inspect included context" }));
    expect(screen.getByLabelText("Included project context").textContent).toBe(populated.context);
    const excluded = { ...populated, chatRevision: 1, disabledIds: [populated.entries[0].id] };
    excluded.context = projectMemoryContext(excluded);
    request.mockResolvedValueOnce(result(excluded));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use in this chat" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(request).toHaveBeenLastCalledWith({ type: "project.memory.toggle", payload: { projectId, conversationId, id: populated.entries[0].id, expectedRevision: 1, expectedChatRevision: 0, enabled: false } });
    expect(screen.getByLabelText("Included project context")).not.toHaveTextContent(populated.entries[0].reason);
    expect(screen.getByText(populated.entries[0].reason)).toBeInTheDocument();
  });

  it("does not let an old read overwrite a completed save", async () => {
    const read = deferred<ServerEvent>();
    const request = vi.fn<ProjectMemoryCommandRunner>().mockResolvedValue(result(populated));
    render(<ProjectMemoryPanel {...props} request={request} />);
    await screen.findByText("Billing history");
    request.mockReturnValueOnce(read.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh project memory" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Billing history" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated decision" } });
    request.mockResolvedValueOnce(result({ ...populated, revision: 2, entries: [{ ...populated.entries[0], title: "Updated decision" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    await screen.findByRole("heading", { name: "Updated decision" });
    await act(async () => { read.resolve(result(empty)); });
    expect(screen.getByRole("heading", { name: "Updated decision" })).toBeInTheDocument();
  });

  it("opens a linked source as text and keeps the curated reason separate", async () => {
    const request = vi.fn<ProjectMemoryCommandRunner>().mockResolvedValue(result(populated));
    render(<ProjectMemoryPanel {...props} request={request} />);
    const button = await screen.findByRole("button", { name: "From Billing investigation" });
    request.mockResolvedValueOnce({ type: "request.result", requestId: "source", result: { kind: "project.memory.source",
      preview: { projectId, id: populated.entries[0].id, source: populated.entries[0].source!, role: "assistant", content: "<script>original discussion</script>", truncated: true } } });
    fireEvent.click(button);
    expect(await screen.findByText("<script>original discussion</script>")).toBeInTheDocument();
    expect(screen.getByText("Showing the first 4,000 characters.")).toBeInTheDocument();
    expect(screen.getByText(populated.entries[0].reason)).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(screen.queryByText("<script>original discussion</script>")).not.toBeInTheDocument();
  });

  it("guards unsaved modal drafts, restores focus, and blocks offline edits", async () => {
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    const request = vi.fn<ProjectMemoryCommandRunner>().mockResolvedValue(result(empty));
    const onClose = vi.fn();
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
    const view = render(<ProjectMemoryDialog {...props} request={request} sourceMessage={message} onClose={onClose} />);
    await screen.findByLabelText("Title");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(confirm).toHaveBeenCalledWith("Discard this unsaved project memory draft?");
    expect(onClose).not.toHaveBeenCalled();
    view.unmount(); expect(trigger).toHaveFocus(); trigger.remove(); vi.unstubAllGlobals();
    render(<ProjectMemoryPanel {...props} request={request} sourceMessage={message} disabled />);
    expect(screen.getByRole("button", { name: "Refresh project memory" })).toBeDisabled();
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
  });
});

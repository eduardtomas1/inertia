import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CliConversationImportDialog } from "../../src/renderer/src/components/CliConversationImportDialog";
import type { ServerEvent } from "../../src/shared/contracts";
import type { CliConversationCandidate } from "../../src/shared/cli-conversations";
import { deferred } from "./composer-fixtures";

const project = { id: "11111111-1111-4111-8111-111111111111", name: "Studio" };
const candidates: CliConversationCandidate[] = [
  { id: "22222222-2222-4222-8222-222222222222", providerId: "codex", title: "Build the sidebar", updatedAt: "2026-09-25T10:00:00.000Z", importedConversationId: null },
  { id: "33333333-3333-4333-8333-333333333333", providerId: "claude", title: "Review accessibility", updatedAt: "2026-09-25T10:00:00.000Z", importedConversationId: null },
];
const result = (value: Extract<ServerEvent, { type: "request.result" }>["result"]): ServerEvent => ({ type: "request.result", requestId: "test", result: value });
const scan = result({ kind: "conversation.cli.scan", scan: { candidates, limited: false, skipped: 0 } });
const preview = (index: number): ServerEvent => result({ kind: "conversation.cli.preview", preview: { candidate: candidates[index]!, revision: "a".repeat(64), messages: [{ role: "user", content: index === 0 ? "Sidebar preview" : "Accessibility preview", createdAt: candidates[0]!.updatedAt }], omittedMessages: 0 } });
type Request = React.ComponentProps<typeof CliConversationImportDialog>["request"];

describe("CLI import dialog", () => {
  it("ignores stale previews when selection changes and imports only the visible revision once", async () => {
    const first = deferred<ServerEvent>(); const pendingImport = deferred<ServerEvent>();
    const request = vi.fn<Request>().mockResolvedValueOnce(scan).mockReturnValueOnce(first.promise).mockResolvedValueOnce(preview(1)).mockReturnValue(pendingImport.promise);
    const onClose = vi.fn(); render(<CliConversationImportDialog project={project} request={request} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: /Build the sidebar/u }));
    fireEvent.click(screen.getByRole("button", { name: /Review accessibility/u }));
    expect(await screen.findByText("Accessibility preview")).toBeInTheDocument();
    await act(async () => first.resolve(preview(0)));
    expect(screen.queryByText("Sidebar preview")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: /^Import conversation$/u });
    fireEvent.click(button); fireEvent.click(button);
    expect(request).toHaveBeenLastCalledWith({ type: "conversation.cli.import", payload: { projectId: project.id, candidateId: candidates[1]!.id, revision: "a".repeat(64) } });
    expect(request).toHaveBeenCalledTimes(4);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); expect(onClose).not.toHaveBeenCalled();
    await act(async () => pendingImport.resolve(result({ kind: "conversation.cli.imported", conversationId: "44444444-4444-4444-8444-444444444444" })));
    expect(screen.getByRole("button", { name: "Already imported" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Imported. Find this conversation in Studio’s chat list.");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); expect(onClose).toHaveBeenCalledOnce();
  });
  it("supports search, provider filtering, actionable failures and rescanning", async () => {
    const request = vi.fn<Request>().mockResolvedValueOnce(scan).mockRejectedValueOnce(new Error("Conversation changed. Scan again.")).mockResolvedValue(scan);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: /Build the sidebar/u });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by CLI provider" }), { target: { value: "claude" } });
    expect(screen.queryByRole("button", { name: /Build the sidebar/u })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search CLI conversations" }), { target: { value: "unknown" } });
    expect(screen.getByText("No conversations match your search.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search CLI conversations" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Review accessibility/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Conversation changed");
    expect(screen.getByRole("button", { name: /^Import conversation$/u })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("prevents mutations offline and restores focus when the modal closes", async () => {
    const request = vi.fn<Request>();
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const view = render(<CliConversationImportDialog project={project} request={request} disabled onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
    await act(async () => {});
  });
});

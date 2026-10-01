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
    expect(screen.getByRole("button", { name: "Already imported" })).toHaveAttribute("aria-disabled", "true");
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
    expect(screen.getByRole("button", { name: /^Import conversation$/u })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("prevents mutations offline and restores focus when the modal closes", async () => {
    const request = vi.fn<Request>();
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const view = render(<CliConversationImportDialog project={project} request={request} disabled onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Scan again" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(request).not.toHaveBeenCalled();
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
    await act(async () => {});
  });
  it("names the dialog by its heading and keeps busy controls focusable", async () => {
    const pendingScan = deferred<ServerEvent>(); const pendingImport = deferred<ServerEvent>();
    const request = vi.fn<Request>().mockReturnValueOnce(pendingScan.promise).mockResolvedValueOnce(preview(0)).mockReturnValue(pendingImport.promise);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Import CLI conversations" });
    expect(dialog).toHaveAccessibleDescription("Codex and Claude Code conversations started in Studio.");
    const scanAgain = screen.getByRole("button", { name: "Scan again" });
    expect(scanAgain).toHaveAttribute("aria-disabled", "true");
    expect(scanAgain).not.toBeDisabled();
    fireEvent.click(scanAgain);
    expect(request).toHaveBeenCalledOnce();
    await act(async () => pendingScan.resolve(result({ kind: "conversation.cli.scan", scan: { candidates: [candidates[0]!], limited: true, skipped: 1 } })));
    expect(screen.getByText("1 conversation")).toBeInTheDocument();
    expect(screen.getByText("1 file skipped: unreadable, unsupported or larger than 16 MiB.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Build the sidebar/u }));
    expect(await screen.findByText("Codex · 1 text message")).toBeInTheDocument();
    const importButton = screen.getByRole("button", { name: "Import conversation" });
    importButton.focus(); fireEvent.click(importButton);
    expect(importButton).toHaveTextContent("Importing…");
    expect(importButton).toHaveAttribute("aria-disabled", "true");
    expect(importButton).not.toBeDisabled();
    expect(importButton).toHaveFocus();
    await act(async () => pendingImport.resolve(result({ kind: "conversation.cli.imported", conversationId: "44444444-4444-4444-8444-444444444444" })));
    expect(importButton).toHaveAccessibleName("Already imported");
    expect(importButton).toHaveFocus();
  });
  it("shows a failed request as a sentence without its diagnostic reference", async () => {
    const request = vi.fn<Request>().mockResolvedValueOnce(scan)
      .mockRejectedValueOnce(new Error("This CLI conversation changed or is no longer readable. Close the CLI session and scan again. [incident:ac13d95c-8bf1-41be-b871-f1f628cff130]"));
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Review accessibility/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^This CLI conversation changed or is no longer readable\. Close the CLI session and scan again\.$/u);
  });
});

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CliConversationImportDialog } from "../../src/renderer/src/components/CliConversationImportDialog";
import type { ServerEvent } from "../../src/shared/contracts";
import type { CliConversationCandidate } from "../../src/shared/cli-conversations";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { deferred } from "./composer-fixtures";

const project = { id: "11111111-1111-4111-8111-111111111111", name: "Studio" };
const candidates: CliConversationCandidate[] = [
  { id: "22222222-2222-4222-8222-222222222222", providerId: "codex", title: "Build the sidebar", updatedAt: "2026-09-25T10:00:00.000Z", importedConversationId: null, importedOmission: null, opening: { user: "Sidebar request", assistant: "Sidebar answer" } },
  { id: "33333333-3333-4333-8333-333333333333", providerId: "claude", title: "Review accessibility", updatedAt: "2026-09-24T16:30:00.000Z", importedConversationId: null, importedOmission: null, opening: { user: "Accessibility request", assistant: null } },
];
const importedId = "44444444-4444-4444-8444-444444444444";
const result = (value: Extract<ServerEvent, { type: "request.result" }>["result"]): ServerEvent => ({ type: "request.result", requestId: "test", result: value });
const scanOf = (items: CliConversationCandidate[]): ServerEvent => result({ kind: "conversation.cli.scan", scan: { candidates: items, limited: false, skipped: 0 } });
const scan = scanOf([candidates[1]!, candidates[0]!]);
const previewOf = (candidate: CliConversationCandidate, user: string, reply?: string): ServerEvent => result({ kind: "conversation.cli.preview", preview: { candidate, revision: "a".repeat(64), omittedMessages: 0,
  messages: [{ role: "user", content: user, createdAt: candidate.updatedAt }, ...reply ? [{ role: "assistant" as const, content: reply, createdAt: candidate.updatedAt }] : []] } });
const previews: Record<string, ServerEvent> = {
  [candidates[0]!.id]: previewOf(candidates[0]!, "Sidebar request", "Sidebar answer"),
  [candidates[1]!.id]: previewOf(candidates[1]!, "Accessibility request", "Accessibility answer"),
};
const imported = result({ kind: "conversation.cli.imported", conversationId: importedId });
type Request = React.ComponentProps<typeof CliConversationImportDialog>["request"];
type Respond = (command: CommandWithoutId) => Promise<ServerEvent> | undefined;
const requester = (respond: Respond = () => undefined): ReturnType<typeof vi.fn<Request>> => vi.fn<Request>(async (command) => {
  const custom = respond(command);
  if (custom) return await custom;
  if (command.type === "conversation.cli.scan") return scan;
  if (command.type === "conversation.cli.preview") return previews[command.payload.candidateId]!;
  if (command.type === "conversation.cli.import") return imported;
  throw new Error(`Unexpected ${command.type}`);
});
const card = (name: RegExp): HTMLElement => screen.getByRole("button", { name });
const findCard = (name: RegExp): Promise<HTMLElement> => screen.findByRole("button", { name });
const shortcut = (button: HTMLElement): KeyboardEventInit => ({ key: "Enter", metaKey: button.getAttribute("aria-keyshortcuts") === "Meta+Enter", ctrlKey: button.getAttribute("aria-keyshortcuts") === "Control+Enter" });
const commands = (request: ReturnType<typeof vi.fn<Request>>, type: string): number => request.mock.calls.filter(([command]) => command.type === type).length;
describe("CLI import dialog", () => {
  it("renders a newest-first gallery of cards with miniatures from the opening exchange and fetches nothing else", async () => {
    const third = { ...candidates[1]!, id: "55555555-5555-4555-8555-555555555555", title: "Older work", updatedAt: "2026-09-20T09:00:00.000Z", opening: { user: "Older request", assistant: "Older answer" } };
    const request = requester((command) => command.type === "conversation.cli.scan" ? Promise.resolve(scanOf([candidates[1]!, third, candidates[0]!])) : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "CLI conversations" });
    const buttons = within(list).getAllByRole("listitem").map((item) => within(item).getByRole("button"));
    expect(buttons.map((button) => button.getAttribute("aria-label")?.split(",")[0])).toEqual(["Build the sidebar", "Review accessibility", "Older work"]);
    expect(buttons[0]).toHaveAccessibleName(/^Build the sidebar, Codex, .*2026/u);
    expect(buttons[0]!.querySelectorAll(".provider-brand-icon")).toHaveLength(2);
    expect(buttons[0]!.querySelector(".cli-import-card-watermark")).toHaveAttribute("data-provider-id", "codex");
    const miniature = buttons[0]!.querySelector(".cli-import-mini")!;
    expect(miniature).toHaveAttribute("aria-hidden", "true");
    expect(miniature.querySelector(".cli-import-mini-user")).toHaveTextContent(/^Sidebar request$/u);
    expect(miniature.querySelector(".cli-import-mini-reply")).toHaveTextContent(/^Sidebar answer$/u);
    const replyless = buttons[1]!.querySelector(".cli-import-mini")!;
    expect(replyless.querySelector(".cli-import-mini-user")).toHaveTextContent(/^Accessibility request$/u);
    expect(replyless.querySelector(".cli-import-mini-reply")).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
  it("opens a card into the transcript, goes back with Escape or the back control and returns focus to the card", async () => {
    const onClose = vi.fn();
    const request = requester();
    render(<CliConversationImportDialog project={project} request={request} onClose={onClose} />);
    const first = await findCard(/Build the sidebar/u);
    first.focus(); fireEvent.click(first);
    const view = await screen.findByRole("group", { name: "Build the sidebar" });
    const backControl = screen.getByRole("button", { name: "Back to conversations" });
    expect(backControl).toHaveFocus();
    expect(screen.queryByRole("list", { name: "CLI conversations" })).not.toBeInTheDocument();
    expect(await within(view).findByRole("article", { name: "You" })).toHaveClass("is-user");
    expect(within(view).getByRole("article", { name: "Codex" })).toHaveTextContent("Sidebar answer");
    fireEvent.keyDown(backControl, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(card(/Build the sidebar/u)).toHaveFocus();
    fireEvent.click(card(/Review accessibility/u));
    await screen.findByRole("group", { name: "Review accessibility" });
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(card(/Review accessibility/u)).toHaveFocus();
    fireEvent.keyDown(card(/Review accessibility/u), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("imports once, keeps focus through Importing…, then turns into Open chat", async () => {
    const pendingImport = deferred<ServerEvent>();
    const onClose = vi.fn(); const onOpenConversation = vi.fn();
    const request = requester((command) => command.type === "conversation.cli.import" ? pendingImport.promise : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={onClose} onOpenConversation={onOpenConversation} />);
    fireEvent.click(await findCard(/Build the sidebar/u));
    const button = await screen.findByRole("button", { name: "Import conversation" });
    expect(["Meta+Enter", "Control+Enter"]).toContain(button.getAttribute("aria-keyshortcuts"));
    button.focus(); fireEvent.click(button); fireEvent.click(button);
    expect(commands(request, "conversation.cli.import")).toBe(1);
    expect(request).toHaveBeenLastCalledWith({ type: "conversation.cli.import", payload: { projectId: project.id, candidateId: candidates[0]!.id, revision: "a".repeat(64) } });
    expect(button).toHaveTextContent("Importing…");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.getByRole("group", { name: "Build the sidebar" })).toBeInTheDocument();
    await act(async () => pendingImport.resolve(imported));
    expect(button).toHaveAccessibleName("Open chat");
    expect(button).toHaveClass("primary-button");
    expect(button).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(/^Imported\.$/u);
    fireEvent.keyDown(button, shortcut(button));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenConversation).toHaveBeenCalledWith(importedId);
  });
  it("imports with the platform shortcut and falls back to Already imported when the chat cannot be opened from here", async () => {
    const earlier = { ...candidates[1]!, importedConversationId: importedId };
    const request = requester((command) => command.type === "conversation.cli.scan" ? Promise.resolve(scanOf([candidates[0]!, earlier]))
      : command.type === "conversation.cli.preview" && command.payload.candidateId === earlier.id ? Promise.resolve(previewOf(earlier, "Accessibility request")) : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    const earlierCard = await findCard(/Review accessibility/u);
    expect(earlierCard).toHaveAccessibleName(/, imported$/u);
    expect(earlierCard.querySelector(".cli-import-card-meta")).toHaveTextContent(/Imported$/u);
    fireEvent.click(earlierCard);
    const quiet = await screen.findByRole("button", { name: "Already imported" });
    expect(quiet).toHaveClass("secondary-button");
    expect(quiet).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    fireEvent.click(card(/Build the sidebar/u));
    const action = await screen.findByRole("button", { name: "Import conversation" });
    fireEvent.keyDown(action, shortcut(action));
    expect(commands(request, "conversation.cli.import")).toBe(1);
    expect(await screen.findByRole("button", { name: "Already imported" })).toBe(action);
  });
  it("fetches a fresh preview on every open and shows nothing stale after a read failure", async () => {
    const fresh = deferred<ServerEvent>();
    let opens = 0;
    const request = requester((command) => command.type === "conversation.cli.preview" && ++opens === 2
      ? Promise.reject(new Error("This CLI conversation changed or is no longer readable. Scan again.")) : command.type === "conversation.cli.preview" && opens === 3 ? fresh.promise : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    fireEvent.click(await findCard(/Build the sidebar/u));
    expect(await screen.findByRole("article", { name: "Codex" })).toHaveTextContent("Sidebar answer");
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    fireEvent.click(card(/Build the sidebar/u));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer readable");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import conversation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    fireEvent.click(card(/Build the sidebar/u));
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading conversation…$/u);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await act(async () => fresh.resolve(previews[candidates[0]!.id]!));
    expect(screen.getByRole("button", { name: "Import conversation" })).toHaveAttribute("aria-disabled", "false");
    expect(commands(request, "conversation.cli.preview")).toBe(3);
  });
  it("shows a failed preview on the status line without its diagnostic reference", async () => {
    const request = requester((command) => command.type === "conversation.cli.preview"
      ? Promise.reject(new Error("This CLI conversation changed or is no longer readable. Scan again. [incident:ac13d95c-8bf1-41be-b871-f1f628cff130]")) : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    fireEvent.click(await findCard(/Review accessibility/u));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^This CLI conversation changed or is no longer readable\. Scan again\.$/u);
    expect(screen.queryByRole("button", { name: "Import conversation" })).not.toBeInTheDocument();
  });
  it("filters with a pressed-state text toggle, searches, spins the rescan and shows states as one sentence", async () => {
    const pendingScan = deferred<ServerEvent>();
    let scans = 0;
    const request = requester((command) => command.type === "conversation.cli.scan" && ++scans === 2 ? pendingScan.promise : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    await screen.findByRole("list", { name: "CLI conversations" });
    const toggles = within(screen.getByRole("group", { name: "Filter by CLI provider" })).getAllByRole("button");
    expect(toggles.map((toggle) => [toggle.textContent, toggle.getAttribute("aria-pressed")])).toEqual([["All", "true"], ["Codex", "false"], ["Claude", "false"]]);
    fireEvent.click(toggles[2]!);
    expect(toggles.map((toggle) => toggle.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(screen.queryByRole("button", { name: /Build the sidebar/u })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search CLI conversations" }), { target: { value: "unknown" } });
    expect(screen.getByText("No conversations match your search.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    const rescan = screen.getByRole("button", { name: "Scan again" });
    expect(rescan).toHaveClass("icon-button");
    expect(rescan).toHaveTextContent("");
    fireEvent.click(rescan);
    expect(rescan).toHaveClass("is-scanning");
    expect(screen.getByRole("status")).toHaveTextContent(/^Looking for conversations…$/u);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await act(async () => pendingScan.resolve(scanOf([])));
    expect(rescan).not.toHaveClass("is-scanning");
    expect(screen.getByText("No CLI conversations found.")).toBeInTheDocument();
  });
  it("shows a failed scan as one sentence and enters the gallery from the search field", async () => {
    let scans = 0;
    const request = requester((command) => command.type === "conversation.cli.scan" && ++scans === 1
      ? Promise.reject(new Error("Could not scan CLI conversations. [incident:ac13d95c-8bf1-41be-b871-f1f628cff130]")) : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not scan CLI conversations\.$/u);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    const first = await findCard(/Build the sidebar/u);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search CLI conversations" }), { key: "ArrowDown" });
    expect(first).toHaveFocus();
  });
  it("prevents mutations offline and restores focus when the modal closes", async () => {
    const request = vi.fn<Request>();
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const view = render(<CliConversationImportDialog project={project} request={request} disabled onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Import CLI conversations" })).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("textbox", { name: "Search CLI conversations" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Scan again" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(request).not.toHaveBeenCalled();
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
    await act(async () => {});
  });
  it("keeps landmarks, badges and helper copy out of the modal", async () => {
    render(<CliConversationImportDialog project={project} request={requester()} onClose={vi.fn()} />);
    fireEvent.click(await findCard(/Build the sidebar/u));
    await screen.findByRole("group", { name: "Build the sidebar" });
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("main, nav, aside, section section, [role=region], [role=complementary], h4, small, .dialog-icon")).toBeNull();
    expect(dialog).not.toHaveTextContent(/Codex and Claude Code conversations started|skipped|recent history|Close it in your terminal|Text history only|keeps its full history|text messages?/u);
    expect(dialog.querySelector(".cli-import-status")).toBeNull();
  });
  it("shows the scanning sentence from the very first render", () => {
    const pendingScan = deferred<ServerEvent>();
    let firstPaint: string | null | undefined;
    const request = requester((command) => {
      if (command.type !== "conversation.cli.scan") return undefined;
      firstPaint = document.querySelector(".cli-import-body")?.textContent;
      return pendingScan.promise;
    });
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    expect(firstPaint).toBe("Looking for conversations…");
    expect(screen.getByRole("status")).toHaveTextContent(/^Looking for conversations…$/u);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(document.querySelector(".cli-import-note")).toBeNull();
  });
  it.each([
    ["unreadable files", { limited: false, skipped: 2 }, "2 conversations could not be read."],
    ["one unreadable file", { limited: false, skipped: 1 }, "1 conversation could not be read."],
    ["a limited scan", { limited: true, skipped: 0 }, "Showing recent conversations only."],
    ["every case at once", { limited: true, skipped: 1 }, "1 conversation could not be read; showing recent conversations only."],
  ])("summarises %s in one muted line under the gallery", async (_case, counts, sentence) => {
    const summary = { candidates: [candidates[0]!], ...counts };
    const request = requester((command) => command.type === "conversation.cli.scan" ? Promise.resolve(result({ kind: "conversation.cli.scan", scan: summary })) : undefined);
    render(<CliConversationImportDialog project={project} request={request} onClose={vi.fn()} />);
    await screen.findByRole("list", { name: "CLI conversations" });
    const notes = document.querySelectorAll(".cli-import-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(new RegExp(`^${sentence.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
    expect(notes[0]!.compareDocumentPosition(screen.getByRole("list")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(card(/Build the sidebar/u));
    await screen.findByRole("group", { name: "Build the sidebar" });
    expect(document.querySelector(".cli-import-note")).toBeNull();
  });
  it("shows no note when the scan read everything", async () => {
    render(<CliConversationImportDialog project={project} request={requester()} onClose={vi.fn()} />);
    await screen.findByRole("list", { name: "CLI conversations" });
    expect(document.querySelector(".cli-import-note")).toBeNull();
  });
  it("offers Open chat for a conversation imported earlier and opens it with a click or the shortcut", async () => {
    const earlier = { ...candidates[1]!, importedConversationId: importedId };
    const request = requester((command) => command.type === "conversation.cli.scan" ? Promise.resolve(scanOf([candidates[0]!, earlier]))
      : command.type === "conversation.cli.preview" && command.payload.candidateId === earlier.id ? Promise.resolve(previewOf(earlier, "Accessibility request")) : undefined);
    const onClose = vi.fn(); const onOpenConversation = vi.fn();
    render(<CliConversationImportDialog project={project} request={request} onClose={onClose} onOpenConversation={onOpenConversation} />);
    fireEvent.click(await findCard(/Review accessibility/u));
    const openChat = await screen.findByRole("button", { name: "Open chat" });
    expect(openChat).toHaveClass("primary-button");
    expect(openChat).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByRole("button", { name: "Already imported" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.keyDown(openChat, shortcut(openChat));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenConversation).toHaveBeenCalledWith(importedId);
    fireEvent.click(openChat);
    expect(onOpenConversation).toHaveBeenCalledTimes(2);
    expect(commands(request, "conversation.cli.import")).toBe(0);
  });
  it("matches the search against the opening exchange as well as the title", async () => {
    render(<CliConversationImportDialog project={project} request={requester()} onClose={vi.fn()} />);
    await screen.findByRole("list", { name: "CLI conversations" });
    const search = screen.getByRole("textbox", { name: "Search CLI conversations" });
    fireEvent.change(search, { target: { value: "accessibility REQUEST" } });
    expect(within(screen.getByRole("list")).getAllByRole("button").map((button) => button.getAttribute("aria-label")?.split(",")[0])).toEqual(["Review accessibility"]);
    fireEvent.change(search, { target: { value: "sidebar answer" } });
    expect(within(screen.getByRole("list")).getAllByRole("button").map((button) => button.getAttribute("aria-label")?.split(",")[0])).toEqual(["Build the sidebar"]);
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByText("No conversations match your search.")).toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../../src/shared/contracts";
import type { PullRequestsResult, StackReview } from "../../src/shared/pull-requests";
import { PullRequestsSurface } from "../../src/renderer/src/components/PullRequestsSurface";
import type { PullRequestRunner } from "../../src/renderer/src/components/pull-requests/usePullRequests";
import { prKey, prLink, prSnapshot, prStack } from "../support/pull-request-fixtures";
const conversationId = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const value = (owner = conversationId): PullRequestsResult => ({ kind: "conversation.pull-requests", conversationId: owner,
  links: [prLink(41), prLink(42), { ...prLink(42, "acme/docs"), snapshot: { ...prSnapshot(), title: "Document linked pull requests" }, stack: null }], operations: [] });
const event = (result: PullRequestsResult | { kind: "conversation.stack-review"; review: StackReview }): ServerEvent => ({ type: "request.result", requestId: crypto.randomUUID(), result });
const reviewed = (): StackReview => ({ id: "33333333-3333-4333-8333-333333333333", conversationId, key: prKey(), action: "merge", stack: prStack(),
  layers: [41, 42].map((number) => ({ number, snapshot: prSnapshot(number) })), expiresAt: "2026-10-01T13:00:00Z", blockers: [] });
function surface(run: PullRequestRunner, owner = conversationId) { return <PullRequestsSurface conversationId={owner} run={run} active disabled={false} />; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("linked pull requests surface", () => {
  it("syncs newly created links as soon as their saved collection opens", async () => {
    const unsynced = value(); unsynced.links[0]!.snapshot = null;
    const run = vi.fn<PullRequestRunner>().mockResolvedValueOnce(event(unsynced)).mockResolvedValue(event(value()));
    render(surface(run));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]?.[1]).toEqual({ type: "conversation.prs.refresh", payload: { conversationId } });
    expect(await screen.findByRole("button", { name: /Add workspace navigation/u })).toBeVisible();
  });
  it("lists multiple repositories and opens the selected identity", async () => {
    const run = vi.fn<PullRequestRunner>().mockResolvedValue(event(value()));
    render(surface(run));
    fireEvent.click(await screen.findByRole("button", { name: /Document linked pull requests/u }));
    expect(screen.getByRole("heading", { name: "Document linked pull requests" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open acme/docs pull request 42 on GitHub" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Stack #43/u })).not.toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("links explicitly and unlinks only the chosen repository", async () => {
    const run = vi.fn<PullRequestRunner>().mockResolvedValue(event(value()));
    render(surface(run)); await screen.findByRole("heading", { name: "Linked 3" });
    fireEvent.click(screen.getByRole("button", { name: "Link pull request" }));
    const input = screen.getByRole("textbox", { name: "GitHub pull request URL" }); expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "https://github.com/acme/docs/pull/9" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]?.[1]).toEqual({ type: "conversation.prs.link", payload: { conversationId, url: "https://github.com/acme/docs/pull/9" } });
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Document linked pull requests/u }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink from chat" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(run.mock.calls[2]?.[1]).toEqual({ type: "conversation.prs.unlink", payload: { conversationId, key: prKey(42, "acme/docs") } });
  });
  it("requires fresh review and an explicit second confirmation before mutating a stack", async () => {
    const run = vi.fn<PullRequestRunner>().mockResolvedValueOnce(event(value()))
      .mockResolvedValueOnce(event({ kind: "conversation.stack-review", review: reviewed() })).mockResolvedValue(event(value()));
    render(surface(run)); fireEvent.click(await screen.findByRole("button", { name: /Keep related pull requests together/u }));
    const trigger = screen.getByRole("button", { name: "Stack #43 · layer 2 of 2" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Stack #43" });
    expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" }); expect(trigger).toHaveFocus();
    fireEvent.click(trigger); fireEvent.click(screen.getByRole("menuitem", { name: "Merge 2 layers…" }));
    expect(trigger).toHaveFocus();
    const dialog = await screen.findByRole("dialog", { name: "Merge stack #43" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(run.mock.calls[1]?.[1]).toEqual({ type: "conversation.stack.prepare", payload: { conversationId, key: prKey(), action: "merge" } });
    expect(run.mock.calls.some(([, command]) => command.type === "conversation.stack.execute")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge 2 layers" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(run.mock.calls[2]?.[1]).toEqual({ type: "conversation.stack.execute", payload: { conversationId, reviewId: reviewed().id } });
  });
  it("shows blockers and prevents confirmation until a new clean review", async () => {
    const review = reviewed(); review.blockers = ["#41 has pending checks."];
    const run = vi.fn<PullRequestRunner>().mockResolvedValueOnce(event(value())).mockResolvedValue(event({ kind: "conversation.stack-review", review }));
    render(surface(run)); fireEvent.click(await screen.findByRole("button", { name: /Keep related pull requests together/u }));
    fireEvent.click(screen.getByRole("button", { name: /Stack #43/u })); fireEvent.click(screen.getByRole("menuitem", { name: "Merge 2 layers…" }));
    await screen.findByText("#41 has pending checks.");
    const confirm = screen.getByRole("button", { name: "Merge 2 layers" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    confirm.focus(); fireEvent.click(confirm);
    expect(confirm).toHaveFocus();
    expect(run.mock.calls.some(([, command]) => command.type === "conversation.stack.execute")).toBe(false);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("discards late data and reviews from another chat", async () => {
    let resolve!: (value: ServerEvent) => void;
    const promise = new Promise<ServerEvent>((done) => { resolve = done; });
    const run = vi.fn<PullRequestRunner>().mockReturnValueOnce(promise).mockResolvedValue(event({ ...value(other), links: [] }));
    const view = render(surface(run)); view.rerender(surface(run, other));
    await act(async () => { resolve(event({ kind: "conversation.stack-review", review: reviewed() })); await promise; });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Linked 3" })).not.toBeInTheDocument();
    expect(screen.getByText(/No pull requests are linked to this chat\./u)).toBeVisible();
  });
  it("prevents another action while an unknown stack outcome is being checked", async () => {
    const result = value(); result.operations.push({ id: reviewed().id, key: prKey(), stackNumber: 43, action: "merge", state: "unknown", completedLayers: 0,
      message: "Check GitHub before making further changes.", updatedAt: "2026-10-01T12:00:00Z" });
    const run = vi.fn<PullRequestRunner>().mockResolvedValue(event(result));
    render(surface(run)); fireEvent.click(await screen.findByRole("button", { name: /Keep related pull requests together/u }));
    fireEvent.click(screen.getByRole("button", { name: /Stack #43/u }));
    const merge = screen.getByRole("menuitem", { name: /^Merge 2 layers…/u });
    expect(merge).toHaveAttribute("aria-disabled", "true");
    expect(merge).toHaveTextContent("Check the last stack action first.");
    fireEvent.click(merge);
    expect(run.mock.calls.some(([, command]) => command.type === "conversation.stack.prepare")).toBe(false);
    expect(screen.getByText("Check GitHub before making further changes.")).toBeVisible();
  });
  it("returns focus to the opened row when going back to the list", async () => {
    const run = vi.fn<PullRequestRunner>().mockResolvedValue(event(value()));
    render(surface(run));
    const row = await screen.findByRole("button", { name: /Document linked pull requests/u });
    fireEvent.click(row);
    const back = screen.getByRole("button", { name: "Back to linked pull requests" });
    expect(back).toHaveFocus();
    fireEvent.click(back);
    expect(screen.getByRole("button", { name: /Document linked pull requests/u })).toHaveFocus();
  });
  it("returns focus to the link button when the form closes", async () => {
    const run = vi.fn<PullRequestRunner>().mockResolvedValue(event(value()));
    render(surface(run)); await screen.findByRole("heading", { name: "Linked 3" });
    const opener = screen.getByRole("button", { name: "Link pull request" });
    fireEvent.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "GitHub pull request URL" })).toHaveAccessibleDescription(/Any GitHub repository/u);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it("shows a failed link inside the form without the diagnostic reference", async () => {
    const run = vi.fn<PullRequestRunner>().mockResolvedValueOnce(event(value())).mockResolvedValue({ type: "request.error", requestId: crypto.randomUUID(),
      message: "Enter a GitHub pull request URL. [incident:44444444-4444-4444-8444-444444444444]" } as ServerEvent);
    render(surface(run)); await screen.findByRole("heading", { name: "Linked 3" });
    fireEvent.click(screen.getByRole("button", { name: "Link pull request" }));
    const input = screen.getByRole("textbox", { name: "GitHub pull request URL" });
    fireEvent.change(input, { target: { value: "https://github.com/acme/docs/issues/9" } });
    fireEvent.submit(input.closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter a GitHub pull request URL.");
    expect(alert).not.toHaveTextContent("incident");
    expect(input.closest("form")).toContainElement(alert);
    expect(input).toHaveValue("https://github.com/acme/docs/issues/9");
  });
  it("names the stack review after its action and target outside the panel", async () => {
    const run = vi.fn<PullRequestRunner>().mockResolvedValueOnce(event(value()))
      .mockResolvedValueOnce(event({ kind: "conversation.stack-review", review: reviewed() }));
    const view = render(surface(run)); fireEvent.click(await screen.findByRole("button", { name: /Keep related pull requests together/u }));
    fireEvent.click(screen.getByRole("button", { name: /Stack #43/u })); fireEvent.click(screen.getByRole("menuitem", { name: "Merge 2 layers…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge stack #43" });
    expect(view.container).not.toContainElement(dialog);
    expect(dialog).toHaveAccessibleDescription(/A merge cannot be undone from Inertia\./u);
    expect(within(dialog).getByRole("list", { name: "Layers to merge" }).querySelectorAll("li")).toHaveLength(2);
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName("Cancel");
    expect(buttons[1]).toHaveAccessibleName("Merge 2 layers");
  });
  it("labels states with words and keeps the diff on one line", async () => {
    const result = value();
    result.links.push({ ...prLink(9), stack: null, snapshot: { ...prSnapshot(9), title: "Refine shortcuts", state: "merged" } },
      { ...prLink(22, "acme/docs"), stack: null, snapshot: { ...prSnapshot(22), title: "Draft the guide", draft: true } });
    const run = vi.fn<PullRequestRunner>().mockResolvedValue(event(result));
    render(surface(run));
    expect(await screen.findByRole("button", { name: /Refine shortcuts/u })).toHaveTextContent("acme/workspace #9 · Merged+");
    expect(screen.getByRole("button", { name: /Draft the guide/u })).toHaveTextContent("acme/docs #22 · Draft");
    expect(screen.getByRole("button", { name: /Add workspace navigation/u }).querySelector(".pr-diff")).toHaveTextContent("+184−26");
  });
});

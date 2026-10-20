import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InitiativesView } from "../../src/renderer/src/components/InitiativesView";
import { InitiativeCreateHost } from "../../src/renderer/src/components/initiatives/InitiativeCreateHost";
import { loadInitiativeCreateDialog } from "../../src/renderer/src/components/lazySurfaceLoaders";
import {
  closeNewInitiativeRequest,
  requestNewInitiative,
} from "../../src/renderer/src/utils/initiativeDialog";
import type {
  AppSnapshot,
  ConversationShell,
  Initiative,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const AT = "2026-10-19T08:00:00.000Z";
const project: Project = {
  id: "project-studio",
  name: "Studio",
  path: "/workspace/studio",
  normalizedPath: "/workspace/studio",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "ready",
  createdAt: AT,
  updatedAt: AT,
};
const scratch: Project = { ...project, id: "project-scratch", name: "No project", workspaceKind: "scratch" };

function initiative(id: string, name: string, overrides: Partial<Initiative> = {}): Initiative {
  return {
    id, name, color: "teal", status: "active", brief: "", briefRevision: 0, revision: 3,
    createdAt: AT, updatedAt: AT, ...overrides,
  };
}

const checkout = initiative("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Checkout redesign");
const docs = initiative("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Docs", { createdAt: "2026-10-19T09:00:00.000Z" });
const shipped = initiative("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Shipped", { status: "done" });
const shelved = initiative("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Shelved", { status: "archived" });

function chat(id: string, title: string, overrides: Partial<ConversationShell> = {}): ConversationShell {
  return {
    id,
    projectId: project.id,
    title,
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: AT,
    pinnedAt: null,
    snoozedUntil: null,
    initiativeId: checkout.id,
    createdAt: AT,
    updatedAt: AT,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    projects: [project, scratch],
    conversations: [
      chat("waiting", "Approve the plan", { status: "needs-input", attentionKind: "approval" }),
      chat("working", "Build the form", { status: "running" }),
      chat("finished", "Write tests", { status: "completed", completedAt: AT }),
      chat("idle", "Sketch ideas", { projectId: scratch.id }),
      chat("archived", "Old archived chat", { archivedAt: AT }),
      chat("other", "Docs chat", { initiativeId: docs.id }),
      chat("loose", "Loose chat", { initiativeId: null }),
    ],
    runs: [],
    providers: [],
    settings: defaultSettings,
    initiatives: [docs, shipped, checkout, shelved],
    activeProjectId: project.id,
    activeConversationId: null,
    ...overrides,
  };
}

const ok: ServerEvent = { type: "request.ok", requestId: "11111111-1111-4111-8111-111111111111" };

function renderView(overrides: Partial<React.ComponentProps<typeof InitiativesView>> = {}) {
  const props = {
    snapshot: snapshot(),
    settings: { confirmDestructiveActions: true },
    status: "online" as const,
    selectedInitiativeId: null,
    onSelectInitiative: vi.fn(),
    request: vi.fn(async () => ok),
    onOpenConversation: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  const view = render(<InitiativesView {...props} />);
  return { ...view, props };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  act(() => closeNewInitiativeRequest());
});

describe("Initiatives page", () => {
  it("lists initiatives by status and selects the first active one by default", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "Initiatives" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Initiatives" });
    expect(within(nav).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
      .toEqual(["Active2", "Done1", "Archived1"]);
    const items = within(nav).getAllByRole("button").filter((button) => button.classList.contains("initiatives-list-item"));
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Checkout redesign, 4 chats", "Docs, 1 chat", "Shipped, 0 chats", "Shelved, 0 chats",
    ]);
    expect(items[0]).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { level: 2, name: "Checkout redesign" })).toBeInTheDocument();
    expect(screen.getByText("Active · 4 chats")).toBeInTheDocument();
  });

  it("groups member chats by what they need and opens a chat on click", () => {
    const { props } = renderView();
    const members = screen.getByRole("region", { name: "Chats in this initiative" });
    expect(within(members).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent))
      .toEqual(["Waiting on you1", "Working1", "Done1", "Idle1"]);
    expect(within(members).queryByText("Old archived chat")).not.toBeInTheDocument();
    expect(within(members).queryByText("Loose chat")).not.toBeInTheDocument();
    const idle = within(members).getByRole("button", { name: "Sketch ideas, No project, Idle. Open chat" });
    const waiting = within(members).getByRole("button", { name: "Approve the plan, Studio, Needs approval. Open chat" });
    expect(waiting).toBeInTheDocument();
    fireEvent.click(idle);
    expect(props.onOpenConversation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "idle" }));
  });

  it("selects another initiative from the list", () => {
    const { props, rerender } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Docs, 1 chat" }));
    expect(props.onSelectInitiative).toHaveBeenCalledExactlyOnceWith(docs.id);
    rerender(<InitiativesView {...props} selectedInitiativeId={docs.id} />);
    expect(screen.getByRole("heading", { level: 2, name: "Docs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs chat, Studio, Idle. Open chat" })).toBeInTheDocument();
  });

  it("renames inline with Enter, cancels with Escape and keeps focus on Rename", async () => {
    const { props } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Rename Checkout redesign" }));
    const input = screen.getByRole("textbox", { name: "Initiative name" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "Checkout v2" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.request).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename Checkout redesign" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Rename Checkout redesign" }));
    const again = screen.getByRole("textbox", { name: "Initiative name" });
    fireEvent.change(again, { target: { value: "  Checkout v2  " } });
    fireEvent.submit(again.closest("form")!);
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith({
      type: "initiative.update",
      payload: { id: checkout.id, expectedRevision: 3, name: "Checkout v2" },
    }, { passive: true }));
  });

  it("changes colour and status with the newest known revision", async () => {
    const { props, rerender } = renderView();
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.update",
      payload: { id: checkout.id, expectedRevision: 3, color: "violet" },
    }, { passive: true }));
    // The page's own update moved the revision on before the snapshot did.
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.update",
      payload: { id: checkout.id, expectedRevision: 4, status: "done" },
    }, { passive: true }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: { id: checkout.id, expectedRevision: 5, status: "archived" },
    }), { passive: true }));

    rerender(<InitiativesView {...props} selectedInitiativeId={shipped.id} />);
    expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: { id: shipped.id, expectedRevision: 3, status: "active" },
    }), { passive: true }));

    rerender(<InitiativesView {...props} selectedInitiativeId={shelved.id} />);
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: { id: shelved.id, expectedRevision: 3, status: "active" },
    }), { passive: true }));
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("serializes quick colour changes and arrow keys across swatches without a conflict, ending on the last colour", async () => {
    // A runtime that enforces the revision and answers a little later, while
    // the page's snapshot never catches up.
    const server = { revision: checkout.revision, color: checkout.color as string, status: checkout.status as string };
    const request = vi.fn(async (command: { type: string; payload: Record<string, unknown> }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (command.payload.expectedRevision !== server.revision) {
        throw new Error("The initiative changed elsewhere. Review the latest version and try again.");
      }
      server.revision += 1;
      if (typeof command.payload.color === "string") server.color = command.payload.color;
      if (typeof command.payload.status === "string") server.status = command.payload.status;
      return ok;
    });
    const { props } = renderView({ request: request as never });
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    // Queued behind the first update, while it is still in flight.
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    await waitFor(() => expect(server.color).toBe("blue"));

    const blue = screen.getByRole("radio", { name: "Blue" });
    expect(blue).toHaveAttribute("aria-checked", "true");
    blue.focus();
    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft"]) {
      fireEvent.keyDown(document.activeElement!, { key });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
    // Back to a colour the stale snapshot still shows must still be sent.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(server.color).toBe("teal"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.color).toBe("teal");

    // Mark done then Archive before the snapshot shows either.
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(request.mock.calls.at(-1)?.[0].payload).toMatchObject({ status: "done" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(server.status).toBe("archived"));
    expect(props.onError).not.toHaveBeenCalled();
    const revisions = request.mock.calls.map(([command]) => command.payload.expectedRevision);
    expect(revisions).toEqual(revisions.map((_, index) => checkout.revision + index));
  });

  it("shows the chosen colour until the snapshot catches up, then follows the snapshot, and reverts a failure", async () => {
    const request = vi.fn(async (): Promise<ServerEvent> => ok);
    const { props, rerender } = renderView({ request });
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    await waitFor(() => expect(props.request).toHaveBeenCalledOnce());
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
    const withCheckout = (overrides: Partial<Initiative>) => snapshot({
      initiatives: [docs, shipped, { ...checkout, ...overrides }, shelved],
    });
    rerender(<InitiativesView {...props} snapshot={withCheckout({ color: "violet", revision: 4 })} />);
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
    // A later change from elsewhere wins once the snapshot is past our save.
    rerender(<InitiativesView {...props} snapshot={withCheckout({ color: "pink", revision: 5 })} />);
    expect(screen.getByRole("radio", { name: "Pink" })).toHaveAttribute("aria-checked", "true");

    request.mockImplementationOnce(async () => { throw new Error("The initiative could not be updated."); });
    fireEvent.click(screen.getByRole("radio", { name: "Red" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("The initiative could not be updated."));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Pink" })).toHaveAttribute("aria-checked", "true"));
  });

  it("deletes only after confirmation, counting archived chats, and says the chats keep their history", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const { props, rerender } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // Four listed chats plus the archived member.
    expect(confirm).toHaveBeenLastCalledWith(
      "Delete “Checkout redesign”? Its 5 chats keep their history and leave the initiative.",
    );
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith(
      { type: "initiative.delete", payload: { id: checkout.id } },
      { passive: true },
    ));
    expect(props.onSelectInitiative).toHaveBeenCalledWith(null);

    confirm.mockReturnValueOnce(false);
    rerender(<InitiativesView {...props} selectedInitiativeId={docs.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenLastCalledWith("Delete “Docs”? Its 1 chat keeps its history and leaves the initiative.");
    rerender(<InitiativesView {...props} selectedInitiativeId={shipped.id} />);
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenLastCalledWith("Delete “Shipped”? It has no chats.");
  });

  it("reports failed updates and disables changes while offline", async () => {
    const { props, rerender } = renderView({
      request: vi.fn(async () => { throw new Error("The initiative changed elsewhere. Review the latest version and try again."); }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(
      "The initiative changed elsewhere. Review the latest version and try again.",
    ));
    rerender(<InitiativesView {...props} status="offline" />);
    expect(screen.getByRole("button", { name: "Mark done" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New initiative" })).toBeDisabled();
  });

  it("explains initiatives when there are none and asks for a new one", () => {
    const { props } = renderView({ snapshot: snapshot({ initiatives: [], conversations: [] }) });
    expect(screen.getByText(/groups chats from any project under one name/u)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Chats in this initiative" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New initiative" }));
    expect(props.onSelectInitiative).not.toHaveBeenCalled();
  });
});

describe("New initiative dialog", () => {
  it("creates and assigns an initiative from a request, then reports its id", async () => {
    await loadInitiativeCreateDialog();
    const run = vi.fn(async () => ok);
    const onCreated = vi.fn();
    render(<InitiativeCreateHost snapshot={snapshot()} run={run} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => requestNewInitiative({ conversationId: "loose", onCreated }));
    const dialog = await screen.findByRole("dialog", { name: "New initiative" });
    expect(dialog).toHaveTextContent("“Loose chat” moves into it.");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    const create = within(dialog).getByRole("button", { name: "Create initiative" });
    expect(create).toBeDisabled();
    // Four initiatives exist, so the palette rotation offers its fifth colour.
    expect(within(dialog).getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(name, { target: { value: "  Payments  " } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Blue" }));
    fireEvent.click(create);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledExactlyOnceWith("initiative.create", {
      type: "initiative.create",
      payload: { id: onCreated.mock.calls[0]![0], name: "Payments", color: "blue", conversationId: "loose" },
    }, { reportError: false });
    expect(onCreated.mock.calls[0]![0]).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the name and shows the runtime error when creation fails", async () => {
    await loadInitiativeCreateDialog();
    const run = vi.fn(async () => { throw new Error("Initiatives are limited to 100."); });
    render(<InitiativeCreateHost snapshot={snapshot()} run={run} />);
    act(() => requestNewInitiative());
    const dialog = await screen.findByRole("dialog", { name: "New initiative" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "One too many" } });
    fireEvent.submit(within(dialog).getByRole("textbox", { name: "Name" }).closest("form")!);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Initiatives are limited to 100.");
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("One too many");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

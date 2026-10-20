import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InitiativesView } from "../../src/renderer/src/components/InitiativesView";
import { InitiativeCreateHost } from "../../src/renderer/src/components/initiatives/InitiativeCreateHost";
import { forgetInitiativeBriefDraft } from "../../src/renderer/src/components/initiatives/InitiativeMemory";
import { loadInitiativeCreateDialog } from "../../src/renderer/src/components/lazySurfaceLoaders";
import {
  closeNewInitiativeRequest,
  requestNewInitiative,
} from "../../src/renderer/src/utils/initiativeDialog";
import type {
  AppSnapshot,
  ConversationShell,
  Initiative,
  InitiativeNote,
  ModelBackendProfileView,
  ModelSelection,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { defaultInitiativePreferences } from "../../src/shared/initiatives";

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
    id, name, color: "teal", status: "active", brief: "", preferences: defaultInitiativePreferences(), briefRevision: 0, briefUpdatedAt: null, notesRevision: 0, proposedNoteCount: 0, revision: 3,
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

type ViewProps = React.ComponentProps<typeof InitiativesView>;

function notesEvent(initiativeId: string, notes: InitiativeNote[] = []): ServerEvent {
  return {
    type: "request.result",
    requestId: "22222222-2222-4222-8222-222222222222",
    result: { kind: "initiative.notes", initiativeId, notes },
  };
}

/**
 * `props.request` sees the page's changes; note reads go to `readNotes`, so
 * the assertions about changes stay exact.
 */
function renderView(
  overrides: Partial<ViewProps> = {},
  readNotes: (initiativeId: string) => InitiativeNote[] = () => [],
) {
  const props = {
    snapshot: snapshot(),
    settings: { ...defaultSettings, confirmDestructiveActions: true },
    status: "online" as const,
    selectedInitiativeId: null,
    onSelectInitiative: vi.fn(),
    request: vi.fn(async () => ok),
    onOpenConversation: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  const reads = vi.fn((initiativeId: string) => readNotes(initiativeId));
  const request: ViewProps["request"] = async (command, options) => command.type === "initiative.notes.list"
    ? notesEvent(command.payload.initiativeId, reads(command.payload.initiativeId))
    : props.request(command, options);
  const view = render(<InitiativesView {...props} request={request} />);
  const rerender = (changes: Partial<ViewProps> = {}) => view.rerender(
    <InitiativesView {...props} {...changes} request={request} />,
  );
  return { ...view, props, reads, rerender };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  act(() => closeNewInitiativeRequest());
  forgetInitiativeBriefDraft();
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
    expect(within(members).getByRole("heading", { level: 3, name: "Chats" })).toBeInTheDocument();
    expect(within(members).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent))
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
    rerender({ selectedInitiativeId: docs.id });
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

    rerender({ selectedInitiativeId: shipped.id });
    expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: { id: shipped.id, expectedRevision: 3, status: "active" },
    }), { passive: true }));

    rerender({ selectedInitiativeId: shelved.id });
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
    rerender({ snapshot: withCheckout({ color: "violet", revision: 4 }) });
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
    // A later change from elsewhere wins once the snapshot is past our save.
    rerender({ snapshot: withCheckout({ color: "pink", revision: 5 }) });
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
    rerender({ selectedInitiativeId: docs.id });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenLastCalledWith("Delete “Docs”? Its 1 chat keeps its history and leaves the initiative.");
    rerender({ selectedInitiativeId: shipped.id });
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
    rerender({ status: "offline" });
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

function noteFixture(index: number, overrides: Partial<InitiativeNote> = {}): InitiativeNote {
  return {
    id: `0000000${index}-0000-4000-8000-000000000000`,
    initiativeId: checkout.id,
    title: `Note ${index}`,
    body: `First line ${index}\nSecond line`,
    provenance: "user",
    state: "accepted",
    sourceConversationId: null,
    kind: null,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("Initiative brief", () => {
  const withBrief = (overrides: Partial<Initiative>) => snapshot({
    initiatives: [docs, shipped, { ...checkout, ...overrides }, shelved],
  });

  it("saves a changed brief with its revision, counts bytes and shows the saved text until the snapshot catches up", async () => {
    const { props, rerender } = renderView({
      snapshot: withBrief({ brief: "Old brief", briefRevision: 2, briefUpdatedAt: AT }),
    });
    expect(screen.getByRole("heading", { level: 3, name: "Brief" })).toBeInTheDocument();
    expect(screen.getByText(/^Revision 2 · updated/u)).toBeInTheDocument();
    const editor = screen.getByRole("textbox", { name: "Initiative brief" });
    expect(editor).toHaveValue("Old brief");
    const save = screen.getByRole("button", { name: "Save brief" });
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(save).toBeDisabled();
    expect(discard).toBeDisabled();
    fireEvent.change(editor, { target: { value: "Ship it 🚀" } });
    // UTF-8 bytes, not characters.
    expect(screen.getByText("12 / 8,192 bytes")).toBeInTheDocument();
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith({
      type: "initiative.brief.update",
      payload: { id: checkout.id, expectedBriefRevision: 2, brief: "Ship it 🚀" },
    }, { passive: true }));
    await waitFor(() => expect(save).toBeDisabled());
    expect(editor).toHaveValue("Ship it 🚀");
    await waitFor(() => expect(editor).toHaveFocus());
    rerender({ snapshot: withBrief({ brief: "Ship it 🚀", briefRevision: 3, briefUpdatedAt: AT, revision: 4 }) });
    expect(editor).toHaveValue("Ship it 🚀");
    // A later change from elsewhere then shows as usual.
    rerender({ snapshot: withBrief({ brief: "Changed elsewhere", briefRevision: 4, briefUpdatedAt: AT, revision: 5 }) });
    expect(editor).toHaveValue("Changed elsewhere");
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("refuses an oversized brief and keeps typing back to the saved text clean", () => {
    renderView();
    const editor = screen.getByRole("textbox", { name: "Initiative brief" });
    expect(screen.getByText("Not written yet")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "😀".repeat(2_049) } });
    expect(screen.getByText("8,196 / 8,192 bytes · too long")).toBeInTheDocument();
    expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save brief" })).toBeDisabled();
    fireEvent.change(editor, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("keeps the draft on a conflict and reloads the latest brief on request", async () => {
    const request = vi.fn(async () => { throw new Error("The brief changed elsewhere. Reload to see the latest."); });
    const { props, rerender } = renderView({ request, snapshot: withBrief({ brief: "Mine", briefRevision: 1 }) });
    const editor = screen.getByRole("textbox", { name: "Initiative brief" });
    fireEvent.change(editor, { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The brief changed elsewhere. Reload to see the latest.");
    expect(editor).toHaveValue("My edit");
    // A conflict is reported in place, not as a page error.
    expect(props.onError).not.toHaveBeenCalled();
    rerender({ snapshot: withBrief({ brief: "Theirs", briefRevision: 2, revision: 4 }) });
    expect(editor).toHaveValue("My edit");
    fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    expect(editor).toHaveValue("Theirs");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
  });

  it("saves with Ctrl+Enter or Cmd+Enter and discards with Escape only after confirming a changed draft", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const { props } = renderView();
    const editor = screen.getByRole("textbox", { name: "Initiative brief" });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "Draft" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(editor).toHaveValue("Draft");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(editor).toHaveValue("");

    fireEvent.change(editor, { target: { value: "Saved by keyboard" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "initiative.brief.update",
      payload: expect.objectContaining({ brief: "Saved by keyboard", expectedBriefRevision: 0 }),
    }), { passive: true }));
    fireEvent.change(editor, { target: { value: "Saved with Cmd" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    // Based on the revision the previous save produced.
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ brief: "Saved with Cmd", expectedBriefRevision: 1 }),
    }), { passive: true }));
  });

  it("keeps typing that continues while a save is in flight", async () => {
    let release!: () => void;
    const request = vi.fn(() => new Promise<ServerEvent>((resolve) => { release = () => resolve(ok); }));
    renderView({ request });
    const editor = screen.getByRole("textbox", { name: "Initiative brief" });
    fireEvent.change(editor, { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    fireEvent.change(editor, { target: { value: "First and more" } });
    await act(async () => release());
    expect(editor).toHaveValue("First and more");
    const save = screen.getByRole("button", { name: "Save brief" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({
      type: "initiative.brief.update",
      payload: { id: checkout.id, expectedBriefRevision: 1, brief: "First and more" },
    }, { passive: true }));
  });

  it("keeps an unsaved brief per initiative while another one is open, and forgets it once saved", async () => {
    const { props, rerender } = renderView();
    const editor = () => screen.getByRole("textbox", { name: "Initiative brief" });
    fireEvent.change(editor(), { target: { value: "Checkout draft" } });
    rerender({ selectedInitiativeId: docs.id });
    expect(editor()).toHaveValue("");
    fireEvent.change(editor(), { target: { value: "Docs draft" } });
    rerender({ selectedInitiativeId: checkout.id });
    expect(editor()).toHaveValue("Checkout draft");
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith({
      type: "initiative.brief.update",
      payload: { id: checkout.id, expectedBriefRevision: 0, brief: "Checkout draft" },
    }, { passive: true }));
    const saved = snapshot({
      initiatives: [docs, shipped, { ...checkout, brief: "Checkout draft", briefRevision: 1, briefUpdatedAt: AT, revision: 4 }, shelved],
    });
    rerender({ snapshot: saved, selectedInitiativeId: docs.id });
    expect(editor()).toHaveValue("Docs draft");
    rerender({ snapshot: saved, selectedInitiativeId: checkout.id });
    expect(editor()).toHaveValue("Checkout draft");
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();

    // Discard forgets a kept draft as well.
    rerender({ snapshot: saved, selectedInitiativeId: docs.id });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    rerender({ snapshot: saved, selectedInitiativeId: checkout.id });
    rerender({ snapshot: saved, selectedInitiativeId: docs.id });
    expect(editor()).toHaveValue("");
  });

  it("reports a kept draft whose brief changed elsewhere as a conflict when it is saved", async () => {
    const request = vi.fn(async () => { throw new Error("The brief changed elsewhere. Reload to see the latest."); });
    const { rerender } = renderView({ request });
    fireEvent.change(screen.getByRole("textbox", { name: "Initiative brief" }), { target: { value: "Based on revision 0" } });
    rerender({ selectedInitiativeId: docs.id });
    const moved = snapshot({
      initiatives: [docs, shipped, { ...checkout, brief: "Theirs", briefRevision: 2, briefUpdatedAt: AT, revision: 5 }, shelved],
    });
    rerender({ snapshot: moved, selectedInitiativeId: checkout.id });
    const editor = screen.getByRole("textbox", { name: "Initiative brief" });
    expect(editor).toHaveValue("Based on revision 0");
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({
      type: "initiative.brief.update",
      payload: expect.objectContaining({ expectedBriefRevision: 0 }),
    }), { passive: true }));
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    expect(editor).toHaveValue("Theirs");
  });

  it("orders a brief save and a rename by the revision the save produced", async () => {
    const { props } = renderView();
    fireEvent.change(screen.getByRole("textbox", { name: "Initiative brief" }), { target: { value: "Brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    await waitFor(() => expect(props.request).toHaveBeenCalledTimes(2));
    expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.update",
      payload: { id: checkout.id, expectedRevision: checkout.revision + 1, color: "violet" },
    }, { passive: true });
  });
});

describe("Initiative notes", () => {
  it("explains an empty list, adds a note from the form and returns focus to Add note", async () => {
    const notes: InitiativeNote[] = [];
    const { props, reads } = renderView({}, () => notes);
    expect(await screen.findByText(/^No notes yet\./u)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs review" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    const form = screen.getByRole("form", { name: "Add note" });
    const title = within(form).getByRole("textbox", { name: "Note title" });
    await waitFor(() => expect(title).toHaveFocus());
    const submit = within(form).getByRole("button", { name: "Add note" });
    expect(submit).toBeDisabled();
    fireEvent.change(title, { target: { value: "  Database  " } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Note text" }), { target: { value: "Use Postgres." } });
    notes.push(noteFixture(1, { title: "Database", body: "Use Postgres." }));
    fireEvent.click(submit);
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith({
      type: "initiative.note.create",
      payload: { initiativeId: checkout.id, title: "Database", body: "Use Postgres." },
    }, { passive: true }));
    expect(await screen.findByText("Database")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add note" })).toHaveFocus());
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("cancels the add form with Escape and submits with Ctrl+Enter", async () => {
    const { props } = renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note title" }), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Add note" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add note" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), { target: { value: "Keyboard" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note text" }), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(props.request).toHaveBeenCalledWith(expect.objectContaining({
      type: "initiative.note.create",
      payload: { initiativeId: checkout.id, title: "Keyboard", body: "" },
    }), { passive: true }));
  });

  it("asks before Escape discards a note form with changes", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    renderView({}, () => [noteFixture(1, { title: "Database" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    const title = screen.getByRole("textbox", { name: "Note title" });
    fireEvent.change(title, { target: { value: "Half written" } });
    fireEvent.keyDown(title, { key: "Escape" });
    expect(confirm).toHaveBeenCalledExactlyOnceWith("Discard this note?");
    expect(title).toHaveValue("Half written");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note text" }), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Add note" })).not.toBeInTheDocument();

    // Editing a note asks only once the text differs from the note.
    fireEvent.click(screen.getByRole("button", { name: "Edit Database" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note title" }), { key: "Escape" });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("form", { name: "Edit Database" })).not.toBeInTheDocument();
  });

  it("measures note titles in characters and explains a title that is too long", async () => {
    const { props } = renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    const form = screen.getByRole("form", { name: "Add note" });
    const title = within(form).getByRole("textbox", { name: "Note title" });
    expect(title).not.toHaveAttribute("maxLength");
    // 120 emoji are 240 UTF-16 units but 120 characters: allowed.
    fireEvent.change(title, { target: { value: "😀".repeat(120) } });
    expect(title).not.toHaveAttribute("aria-invalid");
    fireEvent.change(title, { target: { value: "😀".repeat(121) } });
    expect(title).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(within(form).getByRole("button", { name: "Add note" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Note titles are limited to 120 characters.");
    expect(title).toHaveFocus();
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "😀".repeat(120) } });
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith({
      type: "initiative.note.create",
      payload: { initiativeId: checkout.id, title: "😀".repeat(120), body: "" },
    }, { passive: true }));
  });

  it("sends one review decision per proposal however often it is clicked", async () => {
    let release!: () => void;
    const request = vi.fn(() => new Promise<ServerEvent>((resolve) => { release = () => resolve(ok); }));
    const proposal = noteFixture(3, { title: "Cache totals", provenance: "agent", state: "proposed", revision: 2 });
    const { props } = renderView({ request }, () => [proposal]);
    const group = await screen.findByRole("group", { name: "Review Cache totals" });
    const accept = within(group).getByRole("button", { name: "Accept" });
    fireEvent.click(accept);
    fireEvent.click(accept);
    fireEvent.click(within(group).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(accept).toBeDisabled();
    expect(within(group).getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "Edit and accept" })).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(accept).toBeEnabled());
    expect(request).toHaveBeenCalledOnce();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("lists accepted notes with provenance, edits inline and deletes after confirmation", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const { props } = renderView({}, () => [
      noteFixture(1, { title: "Database" }),
      noteFixture(2, { title: "Totals cache", provenance: "agent", revision: 3 }),
    ]);
    const list = await screen.findByRole("list", { name: "Shared notes" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".initiative-note-provenance")?.textContent)).toEqual(["You", "Agent"]);
    expect(within(items[0]!).getByText("First line 1")).toBeInTheDocument();
    expect(screen.getByText(/^2 shared/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Totals cache" }));
    const form = screen.getByRole("form", { name: "Edit Totals cache" });
    expect(within(form).getByRole("textbox", { name: "Note title" })).toHaveValue("Totals cache");
    fireEvent.change(within(form).getByRole("textbox", { name: "Note text" }), { target: { value: "Cache order totals." } });
    fireEvent.click(within(form).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith({
      type: "initiative.note.update",
      payload: { id: noteFixture(2).id, expectedRevision: 3, body: "Cache order totals." },
    }, { passive: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Totals cache" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Delete Database" }));
    expect(confirm).toHaveBeenLastCalledWith("Delete the note “Database”?");
    expect(props.request).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Delete Database" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.note.delete", payload: { id: noteFixture(1).id },
    }, { passive: true }));
  });

  it("reviews agent proposals: accept, edit and accept, and reject", async () => {
    const proposals = [
      noteFixture(3, { title: "Cache totals", provenance: "agent", state: "proposed", revision: 2 }),
      noteFixture(4, { title: "Drop guest checkout", provenance: "agent", state: "proposed" }),
      noteFixture(5, { title: "Rename the form", provenance: "agent", state: "proposed" }),
    ];
    const { props } = renderView({}, () => proposals);
    const review = await screen.findByRole("region", { name: "Needs review" });
    expect(within(review).getByRole("heading", { level: 4 })).toHaveTextContent(/^Needs review\s*3$/u);
    expect(screen.getByText(/^No notes yet\./u)).toBeInTheDocument();

    fireEvent.click(within(review).getByRole("group", { name: "Review Cache totals" }).querySelector("button")!);
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.note.resolve",
      payload: { id: proposals[0]!.id, expectedRevision: 2, decision: "accept" },
    }, { passive: true }));

    const reject = within(within(review).getByRole("group", { name: "Review Drop guest checkout" }))
      .getByRole("button", { name: "Reject" });
    fireEvent.click(reject);
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.note.resolve",
      payload: { id: proposals[1]!.id, expectedRevision: 1, decision: "reject" },
    }, { passive: true }));

    fireEvent.click(within(within(review).getByRole("group", { name: "Review Rename the form" }))
      .getByRole("button", { name: "Edit and accept" }));
    const form = screen.getByRole("form", { name: "Edit and accept Rename the form" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Note title" }), { target: { value: "Rename the payment form" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save and accept" }));
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.note.resolve",
      payload: {
        id: proposals[2]!.id, expectedRevision: 1, decision: "accept",
        title: "Rename the payment form", body: proposals[2]!.body,
      },
    }, { passive: true }));
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("names and opens the chat an agent proposed from, labels its kind, and says when that chat is gone", async () => {
    const proposals = [
      noteFixture(3, {
        title: "Cache totals", provenance: "agent", state: "proposed", sourceConversationId: "working", kind: "decision",
      }),
      noteFixture(4, { title: "Orphan idea", provenance: "agent", state: "proposed", sourceConversationId: null }),
    ];
    const { props } = renderView({}, () => proposals);
    const review = await screen.findByRole("region", { name: "Needs review" });
    // The accessible name is the visible text.
    const source = within(review).getByRole("button", { name: "From Build the form" });
    expect(source).toHaveAttribute("title", "Open the chat that proposed “Cache totals”");
    expect(within(review).getAllByText("Agent")).toHaveLength(2);
    const cache = within(review).getByRole("group", { name: "Review Cache totals" }).closest("li")!;
    expect(within(cache).getByText("Decision")).toHaveClass("initiative-note-kind");
    // A proposal without a kind shows none.
    const orphan = within(review).getByRole("group", { name: "Review Orphan idea" }).closest("li")!;
    expect(orphan.querySelector(".initiative-note-kind")).toBeNull();
    fireEvent.click(source);
    expect(props.onOpenConversation).toHaveBeenCalledWith(expect.objectContaining({ id: "working" }));
    expect(within(review).getByText("From a deleted chat")).toBeInTheDocument();
    // User notes name no source chat.
    expect(screen.queryByText(/^From /u, { selector: ".initiative-note-list *" })).toBeNull();
  });

  it("lists rejected notes in a closed disclosure and deletes one after confirmation", async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    const notes = [
      noteFixture(1),
      noteFixture(6, { title: "Drop guest checkout", provenance: "agent", state: "rejected", sourceConversationId: "waiting" }),
      noteFixture(7, { title: "Use MySQL", provenance: "agent", state: "rejected" }),
    ];
    const { props } = renderView({}, () => notes);
    const notesRegion = await screen.findByRole("region", { name: "Notes" });
    const disclosure = await within(notesRegion).findByText("Rejected", { exact: false, selector: "summary" });
    const details = disclosure.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(disclosure).toHaveTextContent(/^Rejected\s*2$/u);
    // Rejected notes are neither shared notes nor waiting for review.
    expect(within(notesRegion).getByRole("list", { name: "Shared notes" })).not.toHaveTextContent("Use MySQL");
    expect(within(notesRegion).queryByRole("region", { name: "Needs review" })).toBeNull();
    fireEvent.click(disclosure);
    expect(details).toHaveAttribute("open");
    const rejected = within(details).getByRole("list", { name: "Rejected notes" });
    expect(within(rejected).getAllByRole("listitem")).toHaveLength(2);
    expect(within(rejected).getByRole("button", { name: "From Approve the plan" })).toBeInTheDocument();
    fireEvent.click(within(rejected).getByRole("button", { name: "Delete Use MySQL" }));
    expect(confirm).toHaveBeenCalledWith("Delete the rejected note “Use MySQL”?");
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.note.delete",
      payload: { id: notes[2]!.id },
    }, { passive: true }));
    // Focus stays in the disclosure rather than falling to the page.
    await waitFor(() => expect(disclosure).toHaveFocus());

    confirm.mockReturnValue(false);
    fireEvent.click(within(rejected).getByRole("button", { name: "Delete Drop guest checkout" }));
    expect(props.request).toHaveBeenCalledTimes(1);
  });

  it("moves focus to Add note when the last rejected note is deleted", async () => {
    let notes = [
      noteFixture(1),
      noteFixture(7, { title: "Use MySQL", provenance: "agent", state: "rejected" }),
    ];
    const { props } = renderView({ settings: { ...defaultSettings, confirmDestructiveActions: false } }, () => notes);
    const disclosure = await screen.findByText("Rejected", { exact: false, selector: "summary" });
    fireEvent.click(disclosure);
    const remove = within(disclosure.closest("details")!).getByRole("button", { name: "Delete Use MySQL" });
    remove.focus();
    notes = [noteFixture(1)];
    fireEvent.click(remove);
    await waitFor(() => expect(props.request).toHaveBeenCalledExactlyOnceWith({
      type: "initiative.note.delete",
      payload: { id: noteFixture(7).id },
    }, { passive: true }));
    await waitFor(() => expect(screen.queryByText("Rejected", { exact: false, selector: "summary" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Add note" })).toHaveFocus());
  });

  it("gives note titles and text their own direction, isolated from the labels around them", async () => {
    renderView({}, () => [
      noteFixture(1, { title: "קופה", body: "שורה ראשונה\nSecond line" }),
      noteFixture(3, { title: "Cache totals", body: "Per step.", provenance: "agent", state: "proposed" }),
      noteFixture(7, { title: "Use MySQL", provenance: "agent", state: "rejected" }),
    ]);
    const notes = await screen.findByRole("region", { name: "Notes" });
    await within(notes).findByText("קופה");
    const titles = [...notes.querySelectorAll(".initiative-note-title")];
    expect(titles.map((title) => title.textContent)).toEqual(["Cache totals", "קופה", "Use MySQL"]);
    for (const element of [...titles, ...notes.querySelectorAll(".initiative-note-excerpt, .initiative-note-body")]) {
      expect(element).toHaveAttribute("dir", "auto");
    }
    expect(notes.querySelectorAll(".initiative-note-excerpt, .initiative-note-body")).toHaveLength(2);
  });

  it("explains text-direction controls and Unicode separators before saving a note", async () => {
    const { props } = renderView({}, () => []);
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    const form = screen.getByRole("form", { name: "Add note" });
    const title = within(form).getByRole("textbox", { name: "Note title" });
    fireEvent.change(title, { target: { value: "Pay\u202eload" } });
    expect(title).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(within(form).getByRole("button", { name: "Add note" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Remove the text-direction control characters.");
    fireEvent.change(title, { target: { value: "Payload" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Note text" }), { target: { value: "One\u2028two" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add note" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Use ordinary line breaks instead of Unicode line or paragraph separators.");
    expect(props.request).not.toHaveBeenCalled();
  });

  it("lets the user add notes while proposals wait, up to 64 accepted notes", async () => {
    const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const accepted = Array.from({ length: 63 }, (_, index) => noteFixture(1, { id: id(index), title: `Note ${index}` }));
    const pending = Array.from({ length: 5 }, (_, index) => noteFixture(3, {
      id: id(100 + index), title: `Idea ${index}`, provenance: "agent", state: "proposed",
    }));
    const { rerender } = renderView({}, () => [...accepted, ...pending]);
    await screen.findByRole("region", { name: "Needs review" });
    expect(screen.getByRole("button", { name: "Add note" })).toBeEnabled();
    accepted.push(noteFixture(1, { id: id(200), title: "Sixty-fourth" }));
    rerender({ snapshot: snapshot({ initiatives: [docs, shipped, { ...checkout, notesRevision: 1 }, shelved] }) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled());
    expect(screen.getByText("An initiative keeps at most 64 notes.")).toBeInTheDocument();
  });

  it("reads the notes again when the snapshot's note revisions move and disables changes while offline", async () => {
    const { reads, rerender } = renderView({}, () => []);
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    rerender({ snapshot: snapshot({ initiatives: [docs, shipped, { ...checkout, proposedNoteCount: 1 }, shelved] }) });
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    rerender({ snapshot: snapshot({ initiatives: [docs, shipped, { ...checkout, proposedNoteCount: 1, notesRevision: 1 }, shelved] }) });
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(3));
    rerender({
      status: "offline",
      snapshot: snapshot({ initiatives: [docs, shipped, { ...checkout, proposedNoteCount: 1, notesRevision: 1 }, shelved] }),
    });
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Initiative brief" })).toBeDisabled();
  });
});

describe("Initiative tools and defaults", () => {
  const gateway: ModelBackendProfileView = {
    id: "custom:team", displayName: "Team gateway", protocol: "openai-responses",
    authenticationMode: "api-key", source: "custom", enabled: true, configurationRevision: 4,
    endpointIdentity: "opaque-team-route-4", harnessId: "codex-app-server", preset: "custom",
    allowInsecureLocalhost: false, credentialGeneration: null,
    models: [{ id: "team-alpha", displayName: "Team Alpha", contextWindowTokens: 120_000,
      reasoningOptions: [{ value: "medium", label: "Medium", description: "Balanced" },
        { value: "high", label: "High", description: "Thorough" }], capabilities: [] }],
    routing: { mode: "simple", primaryModelId: "team-alpha" }, capabilityHints: [],
    createdAt: AT, updatedAt: AT,
    endpointHost: "example.invalid", authState: "configured", connectionState: "limited",
    compatibility: { harnessId: "codex-app-server", backendProfileId: "custom:team",
      backendProtocol: "openai-responses", state: "partially-compatible", provenance: "probe",
      allowsModelSwitchWithinSession: false, reasonCode: "responses-probe-verified", reason: "Verified exact route." },
    latestProbe: null, canDelete: true, canDisable: true,
  };
  const teamAlpha: ModelSelection = {
    harnessId: gateway.harnessId, backendProfileId: gateway.id, backendProfileDisplayName: gateway.displayName,
    modelId: "team-alpha", alias: "Team Alpha", reasoningEffort: null, contextWindowOverride: 120_000,
    providerOptions: {}, capabilities: [], backendConfigurationRevision: 4,
  };
  // Project identities are UUIDs in the runtime, and the settings contract checks them.
  const studio: Project = { ...project, id: "77777777-7777-4777-8777-777777777777" };
  const noProject: Project = { ...scratch, id: "88888888-8888-4888-8888-888888888888" };
  const withPreferences = (preferences: Partial<Initiative["preferences"]>, projectPreferences?: Project["preferences"]) => snapshot({
    initiatives: [{ ...checkout, preferences: { ...checkout.preferences, ...preferences } }, docs],
    projects: [{ ...studio, ...(projectPreferences ? { preferences: projectPreferences } : {}) }, noProject],
    backendProfiles: [gateway],
  });
  const tools = () => within(screen.getByRole("region", { name: "Tools & defaults" }));
  const row = (id: string) => document.querySelector(`[data-setting-id="${id}"]`) as HTMLElement;
  const preferencesSent = (props: Pick<ViewProps, "request">) => vi.mocked(props.request).mock.calls
    .map(([command]) => (command as { payload: { preferences?: unknown } }).payload.preferences);

  it("says where unset values come from and saves each change as a settings change", async () => {
    const { props, rerender } = renderView({ snapshot: withPreferences({}) });
    const section = tools();
    expect(section.getByRole("combobox", { name: "Default access for this initiative" })).toHaveDisplayValue("Default (Supervised)");
    expect(row("initiative-default-access")).toHaveTextContent("Inherited from each chat's project or Settings");
    expect(row("initiative-access-ceiling")).not.toHaveTextContent("Inherited");
    // Settings has no browser setting, so the browser row never names it.
    expect(row("initiative-browser-access")).toHaveTextContent("Inherited from each chat's project");
    expect(row("initiative-browser-access")).not.toHaveTextContent("Settings");

    fireEvent.change(section.getByRole("combobox", { name: "Default project for this initiative" }), { target: { value: studio.id } });
    await waitFor(() => expect(props.request).toHaveBeenLastCalledWith({
      type: "initiative.update",
      payload: { id: checkout.id, expectedRevision: 3, preferences: { defaultProjectId: studio.id } },
    }, { passive: true }));

    // With a default project, the hints name the exact layer.
    rerender({ snapshot: withPreferences({ defaultProjectId: studio.id }, {
      ...defaultProjectPreferences(), defaultAccessMode: "full", browserAccess: null,
    }) });
    expect(row("initiative-default-access")).toHaveTextContent("Inherited from project");
    expect(tools().getByRole("combobox", { name: "Default access for this initiative" })).toHaveDisplayValue("Default (Full access)");
    expect(row("initiative-browser-access")).toHaveTextContent("Allowed by default");
    expect(row("initiative-browser-access")).not.toHaveTextContent("Settings");
    expect(row("initiative-model")).toHaveTextContent("Inherited from Settings");

    fireEvent.change(tools().getByRole("combobox", { name: "Access limit for chats in this initiative" }), { target: { value: "auto-edit" } });
    fireEvent.change(tools().getByRole("combobox", { name: "Agent browser access for this initiative" }), { target: { value: "block" } });
    // Both changes reach the runtime; ones made before the first is sent merge.
    await waitFor(() => expect(Object.assign({}, ...preferencesSent(props).slice(1)))
      .toEqual({ accessCeiling: "auto-edit", browserAccess: false }));

    rerender({ snapshot: withPreferences({ defaultProjectId: studio.id, accessCeiling: "auto-edit", browserAccess: false }) });
    expect(row("initiative-browser-access")).not.toHaveTextContent("Inherited");
    const full = within(tools().getByRole("combobox", { name: "Default access for this initiative" }))
      .getByRole("option", { name: "Full access — above the limit" });
    expect(full).toBeDisabled();

    // The inherited default shows the access chats actually start with.
    rerender({ snapshot: withPreferences({ defaultProjectId: studio.id, accessCeiling: "auto-edit" }, {
      ...defaultProjectPreferences(), defaultAccessMode: "full",
    }) });
    expect(tools().getByRole("combobox", { name: "Default access for this initiative" }))
      .toHaveDisplayValue("Default (Auto-accept edits)");
    // A saved default above a later limit says it is lowered.
    rerender({ snapshot: withPreferences({ defaultProjectId: studio.id, accessCeiling: "auto-edit", defaultAccessMode: "full" }) });
    expect(row("initiative-default-access")).toHaveTextContent("Lowered to Auto-accept edits by the access limit");
    rerender({ snapshot: withPreferences({ defaultProjectId: studio.id, accessCeiling: "auto-edit", browserAccess: false }) });

    fireEvent.change(tools().getByRole("combobox", { name: "Agent browser access for this initiative" }), { target: { value: "inherit" } });
    await waitFor(() => expect(preferencesSent(props).at(-1)).toEqual({ browserAccess: null }));
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("merges settings changes made while an earlier one is still being sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn(async (command: { type: string }) => {
      if (command.type === "initiative.update" && request.mock.calls.length === 1) await gate;
      return ok;
    });
    renderView({ request: request as never, snapshot: withPreferences({}) });
    fireEvent.change(tools().getByRole("combobox", { name: "Access limit for chats in this initiative" }), { target: { value: "supervised" } });
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    fireEvent.change(tools().getByRole("combobox", { name: "Agent browser access for this initiative" }), { target: { value: "block" } });
    fireEvent.change(tools().getByRole("combobox", { name: "Default project for this initiative" }), { target: { value: noProject.id } });
    release();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]![0]).toEqual({
      type: "initiative.update",
      payload: { id: checkout.id, expectedRevision: 4, preferences: { browserAccess: false, defaultProjectId: noProject.id } },
    });
  });

  it("saves the default model with its reasoning separately and clears both together", async () => {
    const { props } = renderView({
      snapshot: withPreferences({ defaultModel: teamAlpha, defaultReasoningEffort: "medium" }),
    });
    expect(row("initiative-model")).not.toHaveTextContent("Inherited");
    fireEvent.change(tools().getByRole("combobox", { name: "Default reasoning for this initiative" }), { target: { value: "high" } });
    await waitFor(() => expect(preferencesSent(props).at(-1)).toEqual({ defaultModel: teamAlpha, defaultReasoningEffort: "high" }));
    fireEvent.change(tools().getByRole("combobox", { name: "Default model for this initiative" }), { target: { value: "" } });
    await waitFor(() => expect(preferencesSent(props).at(-1)).toEqual({ defaultModel: null, defaultReasoningEffort: null }));
  });

  it("validates the Claude spend limit before saving it", async () => {
    const { props } = renderView({ snapshot: withPreferences({}) });
    const field = tools().getByRole("textbox", { name: "Claude spend limit per turn for this initiative (USD)" });
    // Without a default project, each chat's project decides.
    expect(row("initiative-spend-limit")).toHaveTextContent("Inherited from each chat's project");
    fireEvent.change(field, { target: { value: "1.234" } });
    fireEvent.blur(field);
    expect(await tools().findByText("Use 0.01 to 10,000 with up to two decimals, or empty for no limit.")).toBeInTheDocument();
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "2.50" } });
    fireEvent.blur(field);
    await waitFor(() => expect(preferencesSent(props).at(-1)).toEqual({ claudeMaxBudgetUsd: 2.5 }));
  });

  it("says whether the default project actually sets a Claude spend limit", () => {
    const { rerender } = renderView({ snapshot: withPreferences({ defaultProjectId: studio.id }) });
    expect(row("initiative-spend-limit")).toHaveTextContent("No limit by default");
    expect(row("initiative-spend-limit")).not.toHaveTextContent("Inherited from project");
    rerender({ snapshot: withPreferences({ defaultProjectId: studio.id }, {
      ...defaultProjectPreferences(), claudeMaxBudgetUsd: 3,
    }) });
    expect(row("initiative-spend-limit")).toHaveTextContent("Inherited from project");
    rerender({ snapshot: withPreferences({ defaultProjectId: studio.id, claudeMaxBudgetUsd: 2 }, {
      ...defaultProjectPreferences(), claudeMaxBudgetUsd: 3,
    }) });
    expect(row("initiative-spend-limit")).not.toHaveTextContent("Inherited");
  });

  it("turns the skills folder on and opens it through the desktop bridge, reporting a refusal", async () => {
    const openInitiativeSkillsFolder = vi.fn(async () => undefined);
    vi.stubGlobal("inertia", { ...window.inertia, openInitiativeSkillsFolder });
    const { props, rerender } = renderView({ snapshot: withPreferences({}) });
    expect(tools().queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
    fireEvent.click(tools().getByRole("switch", { name: "Skills folder for this initiative" }));
    await waitFor(() => expect(preferencesSent(props).at(-1)).toEqual({ skillsFolder: true }));

    rerender({ snapshot: withPreferences({ skillsFolder: true }) });
    expect(row("initiative-skills-folder")).toHaveTextContent("Managed by Inertia");
    fireEvent.click(tools().getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(openInitiativeSkillsFolder).toHaveBeenCalledWith(checkout.id));

    openInitiativeSkillsFolder.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'inertia:open-initiative-skills-folder': Error: The initiative's skills folder could not be verified.",
    ));
    fireEvent.click(tools().getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("The initiative's skills folder could not be verified."));

    rerender({ status: "offline", snapshot: withPreferences({ skillsFolder: true }) });
    expect(tools().getByRole("button", { name: "Open folder" })).toBeDisabled();
    expect(tools().getByRole("combobox", { name: "Access limit for chats in this initiative" })).toBeDisabled();
  });
});

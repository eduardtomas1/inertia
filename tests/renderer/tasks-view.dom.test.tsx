import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TasksView, type TasksViewProps } from "../../src/renderer/src/components/TasksView";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type {
  AppSnapshot,
  ConversationShell,
  Project,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { Todo } from "../../src/shared/todos";

const NOW = new Date(2026, 9, 12, 9);
const stamp = "2026-10-12T07:00:00.000Z";
const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";
const createdProjectId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function project(id: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name,
    path: `/workspace/${name.toLocaleLowerCase("en-US")}`,
    normalizedPath: `/workspace/${name.toLocaleLowerCase("en-US")}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6366f1",
    status: "ready",
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

const provider: ProviderInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
  installState: "installed",
  authState: "authenticated",
  canRun: true,
  statusMessage: null,
  models: [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Test model",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "high", label: "High", description: "Deep reasoning" },
      { value: "xhigh", label: "Extra high", description: "Maximum reasoning" },
    ],
    defaultReasoningEffort: "high",
    fastMode: { providerValue: "priority", label: "Fast", description: "Faster responses", isDefault: false },
  }],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "fresh",
      provenance: "provider",
      updatedAt: stamp,
      lastAttemptedAt: stamp,
      refreshing: false,
    },
    rateLimits: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
  },
};

const settings = {
  ...defaultSettings,
  defaultProvider: "codex" as const,
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
  confirmDestructiveActions: false,
};

function todo(id: string, title: string, overrides: Partial<Todo> = {}): Todo {
  return {
    id,
    title,
    note: "",
    priority: null,
    dueDate: null,
    completedAt: null,
    conversationId: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function conversation(overrides: Partial<ConversationShell> = {}): ConversationShell {
  return {
    id: conversationId,
    projectId: firstProjectId,
    title: "Clean the downloads folder",
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "running",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
    ...overrides,
  };
}

function snapshot(todos: Todo[], overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    projects: [project(firstProjectId, "Inertia"), project(secondProjectId, "Companion")],
    conversations: [],
    runs: [],
    providers: [provider],
    backendProfiles: [],
    backendDefaults: [],
    settings,
    todos,
    activeProjectId: firstProjectId,
    activeConversationId: null,
    ...overrides,
  };
}

const ok = (): ServerEvent => ({ type: "request.ok", requestId: "request" });

function harness(initial: AppSnapshot, overrides: Partial<TasksViewProps> = {}) {
  const request = vi.fn(async (_command: CommandWithoutId): Promise<ServerEvent> => ok());
  const onOpenConversation = vi.fn();
  const props = (current: AppSnapshot): TasksViewProps => ({
    snapshot: current,
    settings,
    status: "online",
    projectScopeId: null,
    request,
    onOpenConversation,
    ...overrides,
  });
  const view = render(<TasksView {...props(initial)} />);
  return {
    ...view,
    request,
    onOpenConversation,
    update(next: AppSnapshot) {
      view.rerender(<TasksView {...props(next)} />);
    },
  };
}

type CommandOf<Type extends CommandWithoutId["type"]> = Extract<CommandWithoutId, { type: Type }>;

function sent<Type extends CommandWithoutId["type"]>(
  request: { mock: { calls: [CommandWithoutId][] } },
  type: Type,
): CommandOf<Type>[] {
  return request.mock.calls
    .map(([command]) => command)
    .filter((command): command is CommandOf<Type> => command.type === type);
}

function row(title: string): HTMLElement {
  return screen.getByRole("checkbox", { name: title }).closest("li")!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Tasks view", () => {
  it("invites the first task and adds one with Enter", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([]));
    expect(screen.getByRole("main", { name: "Tasks" })).toBeVisible();
    expect(screen.getByText("Add anything you need to do")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "Add a task" });
    expect(input).toHaveAttribute("placeholder", "Add a task, or press Tab to hand it to an agent");

    await user.type(input, "  Implement remote control  {Enter}");

    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    const [create] = sent(view.request, "todo.create");
    expect(create).toEqual({
      type: "todo.create",
      payload: {
        id: expect.stringMatching(uuid),
        title: "Implement remote control",
        note: "",
        priority: null,
        dueDate: null,
      },
    });
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    view.update(snapshot([todo(create!.payload.id, "Implement remote control")]));
    expect(screen.getByText("1 to do")).toBeVisible();
  });

  it("keeps the typed title when the service refuses the task", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([]), {
      request: vi.fn(async () => { throw new Error("Too many tasks"); }),
    });
    const input = screen.getByRole("textbox", { name: "Add a task" });
    await user.type(input, "Buy milk{Enter}");
    await waitFor(() => expect(input).toHaveValue("Buy milk"));
    view.unmount();
  });

  it("hands a typed task to an agent with Tab and leaves an empty Tab alone", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([]));
    const input = screen.getByRole("textbox", { name: "Add a task" });
    await user.click(input);
    await user.tab();
    expect(view.request).not.toHaveBeenCalled();
    expect(input).not.toHaveFocus();

    await user.click(input);
    await user.type(input, "Clean the downloads folder");
    await user.tab();
    const [create] = sent(view.request, "todo.create");
    expect(create?.payload.title).toBe("Clean the downloads folder");
    expect(input).toHaveValue("");

    view.update(snapshot([todo(create!.payload.id, "Clean the downloads folder")]));
    const detail = screen.getByRole("complementary", { name: "Task details" });
    const agent = within(detail).getByRole("group", { name: "Hand it to an agent" });
    await waitFor(() => expect(agent.contains(document.activeElement)).toBe(true));
    expect(within(agent).getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("lists urgent work first and keeps finished work behind a collapsed Done row", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Write release notes", { createdAt: "2026-10-10T07:00:00.000Z" }),
      todo("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Fix the login crash", { priority: "urgent", dueDate: "2026-10-13" }),
      todo("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Review the design", { priority: "low", dueDate: "2026-10-20" }),
      todo("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Book the venue", { completedAt: stamp }),
    ]));
    expect(screen.getByText("3 to do")).toBeVisible();
    const list = screen.getByRole("list", { name: "To do" });
    expect(within(list).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual([
      "Fix the login crash",
      "Review the design",
      "Write release notes",
    ]);
    const urgent = row("Fix the login crash");
    expect(urgent).toHaveTextContent("Tomorrow");
    expect(urgent.querySelector(".task-urgent")).toHaveTextContent("!");
    expect(row("Review the design")).toHaveTextContent("20 Oct");
    expect(row("Review the design").querySelector(".task-urgent")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Done 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("checkbox", { name: "Book the venue" })).toBeNull();
    await user.click(toggle);
    const reopen = screen.getByRole("checkbox", { name: "Book the venue" });
    expect(reopen).toBeChecked();
    await user.click(reopen);
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", patch: { completed: false } },
    }]);
  });

  it("marks a task done from its circle and moves focus to the next task", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "First"),
      todo("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
    ]));
    await user.click(screen.getByRole("checkbox", { name: "First" }));
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", patch: { completed: true } },
    }]);
    expect(screen.getByRole("checkbox", { name: "Second" })).toHaveFocus();
  });

  it("opens the row menu with a right-click, Shift+F10 and the actions button", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Write release notes")]));
    const title = within(row("Write release notes")).getByRole("button", { name: /^Write release notes/u });
    fireEvent.contextMenu(title, { clientX: 40, clientY: 50 });
    let menu = screen.getByRole("menu", { name: "Actions for Write release notes" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Hand to agent…",
      "Mark as done",
      "Delete",
    ]);
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: "Hand to agent…" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    title.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    menu = screen.getByRole("menu", { name: "Actions for Write release notes" });
    expect(menu).toBeVisible();
    await user.keyboard("{Escape}");

    const actions = screen.getByRole("button", { name: "Actions for Write release notes" });
    await user.click(actions);
    expect(actions).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Actions for Write release notes" })).toBeVisible();
  });

  it("renames from the menu by focusing and selecting the detail title", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Write release notes")]));
    await user.click(screen.getByRole("button", { name: "Actions for Write release notes" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const title = within(screen.getByRole("complementary", { name: "Task details" })).getByRole("textbox", { name: "Title" });
    await waitFor(() => expect(title).toHaveFocus());
    const field = title as HTMLTextAreaElement;
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, "Write release notes".length]);
    await user.keyboard("Write the release notes{Enter}");
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", patch: { title: "Write the release notes" } },
    }]);
    fireEvent.change(title, { target: { value: "Write the notes\nfor 0.0.72" } });
    expect(title).toHaveValue("Write the notes for 0.0.72");
  });

  it("deletes from the menu after the destructive-action confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const view = harness(snapshot([todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Write release notes")]), {
      settings: { ...settings, confirmDestructiveActions: true },
    });
    await user.click(screen.getByRole("button", { name: "Actions for Write release notes" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete “Write release notes”?");
    expect(sent(view.request, "todo.delete")).toEqual([{
      type: "todo.delete",
      payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    }]);
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus();
  });

  it("sets due day, priority and note from the detail", async () => {
    const user = userEvent.setup();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const view = harness(snapshot([todo(id, "Write release notes")]));
    await user.click(screen.getByRole("button", { name: /^Write release notes/u }));
    const detail = screen.getByRole("complementary", { name: "Task details" });

    await user.click(within(detail).getByRole("button", { name: "Due date" }));
    const due = screen.getByRole("menu", { name: "Due date" });
    expect(within(due).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["Today", "Tomorrow", "Next week", "No date"]);
    await user.click(within(due).getByRole("menuitemradio", { name: "Tomorrow" }));

    await user.click(within(detail).getByRole("button", { name: "Priority" }));
    const priority = screen.getByRole("menu", { name: "Priority" });
    expect(within(priority).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["!Urgent", "High", "Medium", "Low", "No priority"]);
    expect(within(priority).getByRole("menuitemradio", { name: "No priority" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(priority).getByRole("menuitemradio", { name: /Urgent/u }));

    const note = within(detail).getByRole("textbox", { name: "Note" });
    expect(note).toHaveAttribute("placeholder", "Add a note");
    await user.type(note, "Include the migration");
    await user.tab();

    expect(sent(view.request, "todo.update").map((command) => command.payload)).toEqual([
      { id, patch: { dueDate: "2026-10-13" } },
      { id, patch: { priority: "urgent" } },
      { id, patch: { note: "Include the migration" } },
    ]);
    view.update(snapshot([todo(id, "Write release notes", { dueDate: "2026-10-13", priority: "urgent", note: "Include the migration" })]));
    expect(within(detail).getByRole("button", { name: "Due date: Tomorrow" })).toBeVisible();
    expect(within(detail).getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  });

  it("saves task edits quietly and starts a task as a normal action", async () => {
    const user = userEvent.setup();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const view = harness(snapshot([todo(id, "Write release notes")]));
    const add = screen.getByRole("textbox", { name: "Add a task" });
    await user.type(add, "Ship it{Enter}");
    await user.click(screen.getByRole("checkbox", { name: "Write release notes" }));
    await user.click(screen.getByRole("button", { name: /^Write release notes/u }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(sent(view.request, "todo.start")).toHaveLength(1));
    const options = (view.request.mock.calls as unknown as [CommandWithoutId, unknown][])
      .map(([command, option]) => [command.type, option]);
    expect(options).toEqual([
      ["todo.create", { passive: true }],
      ["todo.update", { passive: true }],
      ["todo.start", undefined],
    ]);
  });

  it("drops a pending note save for a task that disappeared or was deleted", async () => {
    const user = userEvent.setup();
    const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const view = harness(snapshot([todo(first, "Write release notes"), todo(second, "Clean the downloads folder")]));
    await user.click(screen.getByRole("button", { name: /^Write release notes/u }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Draft");
    view.update(snapshot([todo(second, "Clean the downloads folder")]));
    await waitFor(() => expect(document.querySelector(".task-detail")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 700));

    await user.click(screen.getByRole("button", { name: /^Clean the downloads folder/u }));
    const note = screen.getByRole("textbox", { name: "Note" });
    await user.type(note, "Gone");
    fireEvent.contextMenu(row("Clean the downloads folder"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.blur(note);
    view.update(snapshot([]));
    await new Promise((resolve) => setTimeout(resolve, 700));

    const commands = view.request.mock.calls.map(([command]) => command);
    expect(commands.map(({ type }) => type)).toEqual(["todo.update", "todo.delete"]);
    expect(commands[0]).toEqual({ type: "todo.update", payload: { id: second, patch: { note: "Gone" } } });
  });

  it("adopts a newer title and note when the fields were focused without typing", async () => {
    const user = userEvent.setup();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const view = harness(snapshot([todo(id, "Write release notes", { note: "Old note" })]));
    await user.click(screen.getByRole("button", { name: /^Write release notes/u }));
    const title = screen.getByRole("textbox", { name: "Title" });
    const note = screen.getByRole("textbox", { name: "Note" });
    await user.click(title);
    view.update(snapshot([todo(id, "Write the release notes", { note: "Newer note" })]));
    await user.click(note);
    view.update(snapshot([todo(id, "Write the release notes", { note: "Newest note" })]));
    await user.click(screen.getByRole("textbox", { name: "Add a task" }));
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(sent(view.request, "todo.update")).toEqual([]);
    expect(title).toHaveValue("Write the release notes");
    expect(note).toHaveValue("Newest note");
  });

  it("starts a task in the chosen project and opens its chat", async () => {
    const user = userEvent.setup();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => command.type === "todo.start"
      ? { type: "request.result", requestId: "request", result: { kind: "todo.started", conversationId } }
      : ok());
    const view = harness(snapshot([todo(id, "Clean the downloads folder")]), { request });
    await user.click(screen.getByRole("button", { name: /^Clean the downloads folder/u }));
    const agent = screen.getByRole("group", { name: "Hand it to an agent" });
    expect(within(agent).getByRole("button", { name: /Choose model\..*GPT-5\.6-Sol/u })).toBeVisible();
    expect(within(agent).getByRole("combobox", { name: "Project" })).toHaveValue(firstProjectId);
    await user.selectOptions(within(agent).getByRole("combobox", { name: "Project" }), secondProjectId);
    await user.selectOptions(within(agent).getByRole("combobox", { name: "Reasoning" }), "xhigh");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "Speed" }), "fast");
    await user.click(within(agent).getByRole("button", { name: "Start" }));

    await waitFor(() => expect(sent(request, "todo.start")).toHaveLength(1));
    const [start] = sent(request, "todo.start");
    expect(start!.payload.id).toBe(id);
    expect(start!.payload.conversation).toMatchObject({
      projectId: secondProjectId,
      providerId: "codex",
      modelSelection: {
        harnessId: "codex-app-server",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        providerOptions: { fastMode: "priority" },
      },
    });
    expect(start!.payload.conversation).not.toHaveProperty("title");
    expect(sent(request, "project.create")).toHaveLength(0);
    expect(view.onOpenConversation).not.toHaveBeenCalled();
    const chat = conversation({ projectId: secondProjectId });
    view.update(snapshot([todo(id, "Clean the downloads folder", { conversationId })], { conversations: [chat] }));
    await waitFor(() => expect(view.onOpenConversation).toHaveBeenCalledWith(chat));
  });

  it("adds a picked folder as a project before starting, reusing a known one", async () => {
    const user = userEvent.setup();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const selectDirectory = vi.fn()
      .mockResolvedValueOnce("/Users/me/Downloads/")
      .mockResolvedValueOnce("C:\\Work\\Studio");
    vi.stubGlobal("inertia", { selectDirectory });
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "project.create") {
        return { type: "request.result", requestId: "request", result: { kind: "project.created", projectId: createdProjectId } };
      }
      if (command.type === "todo.start") {
        return { type: "request.result", requestId: "request", result: { kind: "todo.started", conversationId } };
      }
      return ok();
    });
    const studio = project(secondProjectId, "Studio", { path: "C:\\work\\studio", normalizedPath: "c:/work/studio" });
    harness(snapshot([todo(id, "Clean the downloads folder")], {
      projects: [project(firstProjectId, "Inertia"), studio],
    }), { request });
    await user.click(screen.getByRole("button", { name: /^Clean the downloads folder/u }));
    const agent = screen.getByRole("group", { name: "Hand it to an agent" });
    await user.click(within(agent).getByRole("button", { name: "Folder…" }));
    const target = within(agent).getByRole("combobox", { name: "Project" });
    await waitFor(() => expect(target).toHaveDisplayValue("Downloads"));
    await user.click(within(agent).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(sent(request, "todo.start")).toHaveLength(1));
    expect(request.mock.calls.map(([command]) => command.type)).toEqual(["project.create", "todo.start"]);
    expect(sent(request, "project.create")[0]!.payload).toEqual({ name: "Downloads", path: "/Users/me/Downloads/" });
    expect(sent(request, "todo.start")[0]!.payload.conversation.projectId).toBe(createdProjectId);

    await user.click(within(agent).getByRole("button", { name: "Folder…" }));
    await waitFor(() => expect(target).toHaveValue(secondProjectId));
  });

  it("shows a linked task's chat status and opens the chat", async () => {
    const user = userEvent.setup();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const chat = conversation();
    const view = harness(snapshot([todo(id, "Clean the downloads folder", { conversationId })], { conversations: [chat] }));
    expect(row("Clean the downloads folder")).toHaveTextContent("Working");
    await user.click(screen.getByRole("button", { name: /^Clean the downloads folder/u }));
    const detail = screen.getByRole("complementary", { name: "Task details" });
    expect(within(detail).queryByRole("group", { name: "Hand it to an agent" })).toBeNull();
    expect(within(detail).getByText("Working")).toBeVisible();
    await user.click(within(detail).getByRole("button", { name: "Open chat" }));
    expect(view.onOpenConversation).toHaveBeenCalledWith(chat);

    view.update(snapshot([todo(id, "Clean the downloads folder", { conversationId })], {
      conversations: [conversation({ status: "failed" })],
    }));
    expect(row("Clean the downloads folder").querySelector(".task-status")).toHaveTextContent("Failed");
    expect(row("Clean the downloads folder").querySelector(".task-status")).toHaveClass("is-failed");
  });

  it("closes the detail with Escape and returns focus to the row", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Write release notes")]));
    const title = screen.getByRole("button", { name: /^Write release notes/u });
    await user.click(title);
    await user.click(within(screen.getByRole("complementary", { name: "Task details" })).getByRole("textbox", { name: "Note" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    expect(title).toHaveFocus();
    await act(async () => undefined);
  });

  it("lets the closed detail fade out inert before removing it", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Write release notes")]));
    await user.click(screen.getByRole("button", { name: /^Write release notes/u }));
    await user.click(screen.getByRole("button", { name: "Close task details" }));
    const leaving = document.querySelector(".task-detail");
    expect(leaving).toHaveClass("is-leaving");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(leaving).toHaveAttribute("inert");
    expect(document.querySelector(".tasks-layout")).not.toHaveClass("has-detail");
    await waitFor(() => expect(document.querySelector(".task-detail")).toBeNull());
  });
});

describe("Tasks stylesheet", () => {
  const css = readFileSync("src/renderer/src/components/TasksView.css", "utf8");

  it("uses semantic colour tokens only so preset and custom themes apply", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/u);
  });

  it("stays plain: no shadows beyond the popover token, uppercase labels or pill shapes", () => {
    expect(css.match(/box-shadow:[^;]*;/gu) ?? []).toEqual(["box-shadow: var(--shadow-float);"]);
    expect(css).not.toMatch(/text-transform|999px/u);
  });

  it("adapts to narrow containers, reduced motion and forced colours", () => {
    expect(css).toMatch(/@container tasks-view \(max-width: 760px\)/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(/@media \(forced-colors: active\)/u);
  });
});

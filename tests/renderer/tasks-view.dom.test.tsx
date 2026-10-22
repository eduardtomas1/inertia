import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { ServerEvent } from "../../src/shared/contracts";
import {
  check,
  conversation,
  conversationId,
  createdProjectId,
  firstId,
  firstProjectId,
  harness,
  NOW,
  ok,
  project,
  row,
  secondId,
  secondProjectId,
  sent,
  snapshot,
  started,
  stubMatchMedia,
  titleButton,
  todo,
  uuid,
} from "./tasks-fixtures";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubMatchMedia();
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
        dueTime: null,
        projectId: null,
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

  it("keeps finished work behind a collapsed Done row and reopens it from its circle", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "Write release notes"),
      todo(secondId, "Book the venue", { completedAt: doneAt() }),
    ]));
    expect(screen.getByText("1 to do")).toBeVisible();
    const toggle = screen.getByRole("button", { name: "Done 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Done" })).toBeNull();
    await user.click(toggle);
    const reopen = within(screen.getByRole("list", { name: "Done" }))
      .getByRole("checkbox", { name: "Mark as not done: Book the venue" });
    expect(reopen).toBeChecked();
    await user.click(reopen);
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: secondId, patch: { completed: false } },
    }]);
    expect(screen.getByText("2 to do")).toBeVisible();
  });

  it("marks a task done from its circle and moves focus to the next task", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "First"),
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
    ]));
    await user.click(check("First"));
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: firstId, patch: { completed: true } },
    }]);
    expect(titleButton("Second")).toHaveFocus();
  });

  it("opens the row menu with a right-click, Shift+F10 and the actions button", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo(firstId, "Write release notes")]));
    const title = titleButton("Write release notes");
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
    expect(title).toHaveFocus();

    const actions = screen.getByRole("button", { name: "Actions for Write release notes" });
    await user.click(actions);
    expect(actions).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Actions for Write release notes" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(actions).toHaveFocus();
  });

  it("opens the row menu from the circle too, by right-click or the menu keys", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo(firstId, "Write release notes")]));
    const circle = check("Write release notes");
    fireEvent.contextMenu(circle, { clientX: 20, clientY: 50 });
    expect(screen.getByRole("menu", { name: "Actions for Write release notes" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    circle.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Actions for Write release notes" })).toBeVisible();
    await user.keyboard("{Escape}");

    circle.focus();
    fireEvent.keyDown(circle, { key: "ContextMenu" });
    expect(screen.getByRole("menu", { name: "Actions for Write release notes" })).toBeVisible();
    expect(circle).not.toBeChecked();
  });

  it("closes a menu whose task disappeared and keeps focus and Escape working", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Write release notes"), todo(secondId, "Clean the downloads folder")]));
    await user.click(titleButton("Write release notes"));
    await user.click(screen.getByRole("button", { name: "Actions for Clean the downloads folder" }));
    expect(screen.getByRole("menu", { name: "Actions for Clean the downloads folder" })).toBeVisible();

    view.update(snapshot([todo(firstId, "Write release notes")]));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus());

    screen.getByRole("textbox", { name: "Title" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
  });

  it("moves due labels on at local midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 9, 12, 23, 59, 30));
    harness(snapshot([todo(firstId, "Write release notes", { dueDate: "2026-10-13" })]));
    expect(row("Write release notes")).toHaveTextContent("Tomorrow");
    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(row("Write release notes")).toHaveTextContent("Today");
  });

  it("moves due labels on within a minute when the computer wakes after midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 9, 12, 18, 0, 0));
    harness(snapshot([todo(firstId, "Write release notes", { dueDate: "2026-10-13" })]));
    expect(row("Write release notes")).toHaveTextContent("Tomorrow");
    vi.setSystemTime(new Date(2026, 9, 13, 8, 0, 0));
    await act(async () => { vi.advanceTimersByTime(60_001); });
    expect(row("Write release notes")).toHaveTextContent("Today");
  });

  it("ticks a timed due label into overdue on the next minute and refreshes when the window shows again", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 9, 12, 14, 59, 10));
    harness(snapshot([todo(firstId, "Call the bank", { dueDate: "2026-10-12", dueTime: "15:00" })]));
    const due = () => row("Call the bank").querySelector(".task-due");
    expect(due()).toHaveTextContent("Today 3:00 PM");
    expect(due()).not.toHaveClass("is-overdue");
    await act(async () => { vi.advanceTimersByTime(51_000); });
    expect(due()).toHaveClass("is-overdue");

    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    vi.setSystemTime(new Date(2026, 9, 13, 9, 0, 0));
    hidden.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(due()).toHaveTextContent("Overdue · 1 d");
  });

  it("renames from the menu by focusing and selecting the detail title", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Write release notes")]));
    await user.click(screen.getByRole("button", { name: "Actions for Write release notes" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const title = within(screen.getByRole("complementary", { name: "Task details" })).getByRole("textbox", { name: "Title" });
    await waitFor(() => expect(title).toHaveFocus());
    const field = title as HTMLTextAreaElement;
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, "Write release notes".length]);
    await user.keyboard("Write the release notes{Enter}");
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: firstId, patch: { title: "Write the release notes" } },
    }]);
    fireEvent.change(title, { target: { value: "Write the notes\nfor 0.0.72" } });
    expect(title).toHaveValue("Write the notes for 0.0.72");
  });

  it("sets priority and note from the detail", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Write release notes")]));
    await user.click(titleButton("Write release notes"));
    const detail = screen.getByRole("complementary", { name: "Task details" });

    const priorityChip = within(detail).getByRole("button", { name: "Priority" });
    await user.click(priorityChip);
    const priority = screen.getByRole("menu", { name: "Priority" });
    expect(within(priority).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
    expect(within(priority).getByRole("menuitemradio", { name: "No priority" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(priority).getByRole("menuitemradio", { name: "Urgent" }));
    expect(priorityChip).toHaveFocus();

    const note = within(detail).getByRole("textbox", { name: "Note" });
    expect(note).toHaveAttribute("placeholder", "Add a note");
    await user.type(note, "Include the migration");
    await user.tab();

    expect(sent(view.request, "todo.update").map((command) => command.payload)).toEqual([
      { id: firstId, patch: { priority: "urgent" } },
      { id: firstId, patch: { note: "Include the migration" } },
    ]);
    view.update(snapshot([todo(firstId, "Write release notes", { priority: "urgent", note: "Include the migration" })]));
    expect(within(detail).getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  });

  it("opens the due picker from the Due chip and saves day and time in one update", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Write release notes", { dueDate: "2026-10-01" })]));
    await user.click(titleButton("Write release notes"));
    const detail = screen.getByRole("complementary", { name: "Task details" });
    const chip = within(detail).getByRole("button", { name: "Due date: Overdue · 11 d" });
    expect(chip).toHaveClass("is-overdue");
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(chip);
    const picker = screen.getByRole("dialog", { name: "Due" });
    await user.click(within(picker).getByRole("button", { name: /^Tomorrow/u }));
    expect(screen.queryByRole("dialog", { name: "Due" })).toBeNull();
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: firstId, patch: { dueDate: "2026-10-13", dueTime: null } },
    }]);
    view.update(snapshot([todo(firstId, "Write release notes", { dueDate: "2026-10-13", dueTime: "15:00" })]));
    expect(within(detail).getByRole("button", { name: "Due date: Tomorrow 3:00 PM" })).not.toHaveClass("is-overdue");

    await user.click(within(detail).getByRole("button", { name: "Due date: Tomorrow 3:00 PM" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Due" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Task details" })).toBeVisible();
    expect(sent(view.request, "todo.update")).toHaveLength(1);
  });

  it("saves task edits quietly and starts a task as a normal action", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Write release notes")]));
    const add = screen.getByRole("textbox", { name: "Add a task" });
    await user.type(add, "Ship it{Enter}");
    await user.click(check("Write release notes"));
    await user.click(titleButton("Write release notes"));
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start" })).not.toBeNull());
    view.update(snapshot([todo(firstId, "Write release notes")]));
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(sent(view.request, "todo.start")).toHaveLength(1));
    const options = (view.request.mock.calls as unknown as [CommandWithoutId, unknown][])
      .map(([command, option]) => [command.type, option]);
    expect(options).toEqual([
      ["todo.create", { passive: true }],
      ["todo.update", { passive: true }],
      ["todo.update", { passive: true }],
      ["todo.start", undefined],
    ]);
  });

  it("drops a pending note save for a task that disappeared or was deleted", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Write release notes"), todo(secondId, "Clean the downloads folder")]));
    await user.click(titleButton("Write release notes"));
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Draft");
    view.update(snapshot([todo(secondId, "Clean the downloads folder")]));
    await waitFor(() => expect(document.querySelector(".task-detail")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 700));

    await user.click(titleButton("Clean the downloads folder"));
    const note = screen.getByRole("textbox", { name: "Note" });
    await user.type(note, "Gone");
    fireEvent.contextMenu(titleButton("Clean the downloads folder"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.blur(note);
    await act(async () => { view.unmount(); });

    const commands = view.request.mock.calls.map(([command]) => command as CommandWithoutId);
    expect(commands.map(({ type }) => type)).toEqual(["todo.update", "todo.delete"]);
    expect(commands[0]).toEqual({ type: "todo.update", payload: { id: secondId, patch: { note: "Gone" } } });
  });

  it("adopts a newer title and note when the fields were focused without typing", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Write release notes", { note: "Old note" })]));
    await user.click(titleButton("Write release notes"));
    const title = screen.getByRole("textbox", { name: "Title" });
    const note = screen.getByRole("textbox", { name: "Note" });
    await user.click(title);
    view.update(snapshot([todo(firstId, "Write the release notes", { note: "Newer note" })]));
    await user.click(note);
    view.update(snapshot([todo(firstId, "Write the release notes", { note: "Newest note" })]));
    await user.click(screen.getByRole("textbox", { name: "Add a task" }));
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(sent(view.request, "todo.update")).toEqual([]);
    expect(title).toHaveValue("Write the release notes");
    expect(note).toHaveValue("Newest note");
  });

  it("starts a task in the chosen project and stays in Tasks", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> =>
      command.type === "todo.start" ? started() : ok());
    const view = harness(snapshot([todo(firstId, "Clean the downloads folder")]), { request });
    await user.click(titleButton("Clean the downloads folder"));
    const agent = screen.getByRole("group", { name: "Hand it to an agent" });
    expect(within(agent).getByRole("button", { name: /Choose model\..*GPT-5\.6-Sol/u })).toBeVisible();
    expect(within(agent).getByRole("combobox", { name: "Project" })).toHaveValue(firstProjectId);
    await user.selectOptions(within(agent).getByRole("combobox", { name: "Project" }), secondProjectId);
    await user.selectOptions(within(agent).getByRole("combobox", { name: "Reasoning" }), "xhigh");
    await user.selectOptions(within(agent).getByRole("combobox", { name: "Speed" }), "fast");
    await user.click(within(agent).getByRole("button", { name: "Start" }));

    await waitFor(() => expect(sent(request, "todo.start")).toHaveLength(1));
    const [start] = sent(request, "todo.start");
    expect(start!.payload.id).toBe(firstId);
    expect(start!.payload).not.toHaveProperty("replaces");
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

    const chat = conversation({ projectId: secondProjectId });
    view.update(snapshot([todo(firstId, "Clean the downloads folder", {
      conversationId,
      linkedAt: NOW.toISOString(),
      projectId: secondProjectId,
    })], { conversations: [chat] }));
    await act(async () => undefined);
    expect(view.onOpenConversation).not.toHaveBeenCalled();
    expect(screen.getByRole("main", { name: "Tasks" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open chat" })).toHaveFocus();
  });

  it("adds a picked folder as a project before starting, reusing a known one", async () => {
    const user = userEvent.setup();
    const selectDirectory = vi.fn()
      .mockResolvedValueOnce("/Users/me/Downloads/")
      .mockResolvedValueOnce("C:\\Work\\Studio");
    vi.stubGlobal("inertia", { selectDirectory });
    let fail = true;
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "project.create") {
        return { type: "request.result", requestId: "request", result: { kind: "project.created", projectId: createdProjectId } };
      }
      if (command.type === "todo.start") {
        if (fail) {
          fail = false;
          throw new Error("The agent could not start.");
        }
        return started();
      }
      return ok();
    });
    const studio = project(secondProjectId, "Studio", { path: "C:\\work\\studio", normalizedPath: "c:/work/studio" });
    const view = harness(snapshot([todo(firstId, "Clean the downloads folder")], {
      projects: [project(firstProjectId, "Inertia"), studio],
    }), { request });
    await user.click(titleButton("Clean the downloads folder"));
    const agent = screen.getByRole("group", { name: "Hand it to an agent" });
    await user.click(within(agent).getByRole("button", { name: "Folder…" }));
    const target = within(agent).getByRole("combobox", { name: "Project" });
    await waitFor(() => expect(target).toHaveDisplayValue("Downloads"));
    await user.click(within(agent).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(sent(request, "todo.start")).toHaveLength(1));
    expect(request.mock.calls.map(([command]) => command.type)).toEqual(["project.create", "todo.start"]);
    expect(sent(request, "project.create")[0]!.payload).toEqual({ name: "Downloads", path: "/Users/me/Downloads/" });
    expect(sent(request, "todo.start")[0]!.payload.conversation.projectId).toBe(createdProjectId);

    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("The agent could not start."));
    await waitFor(() => expect(within(agent).getByRole("button", { name: "Start" })).toHaveFocus());
    expect(agent).toBeVisible();
    await user.click(within(agent).getByRole("button", { name: "Folder…" }));
    await waitFor(() => expect(target).toHaveValue(secondProjectId));
  });

  it("reports an unexpected start response and lets Start be pressed again", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => command.type === "todo.start"
      ? { type: "request.result", requestId: "request", result: { kind: "project.created", projectId: createdProjectId } }
      : ok());
    const view = harness(snapshot([todo(firstId, "Clean the downloads folder")]), { request });
    await user.click(titleButton("Clean the downloads folder"));
    const start = within(screen.getByRole("group", { name: "Hand it to an agent" })).getByRole("button", { name: "Start" });
    await user.click(start);

    await waitFor(() => expect(view.onError)
      .toHaveBeenCalledWith("The local service returned an unexpected task response."));
    await waitFor(() => expect(start).toBeEnabled());
    expect(view.onOpenConversation).not.toHaveBeenCalled();
  });

  it("reports a folder picker failure and keeps the chosen project", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("inertia", { selectDirectory: vi.fn().mockRejectedValue(new Error("The folder picker is unavailable.")) });
    const view = harness(snapshot([todo(firstId, "Clean the downloads folder")]));
    await user.click(titleButton("Clean the downloads folder"));
    const agent = screen.getByRole("group", { name: "Hand it to an agent" });
    await user.click(within(agent).getByRole("button", { name: "Folder…" }));

    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("The folder picker is unavailable."));
    expect(within(agent).getByRole("combobox", { name: "Project" })).toHaveValue(firstProjectId);
    expect(within(agent).getByRole("button", { name: "Folder…" })).toBeEnabled();
  });

  it("offers Open chat instead of Hand to agent in a linked task's row menu", async () => {
    const user = userEvent.setup();
    const chat = conversation();
    const view = harness(snapshot([
      todo(firstId, "Clean the downloads folder", { conversationId }),
    ], { conversations: [chat] }));
    await user.click(screen.getByRole("button", { name: "Actions for Clean the downloads folder" }));
    const menu = screen.getByRole("menu", { name: "Actions for Clean the downloads folder" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Rename", "Open chat", "Mark as done", "Delete"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Open chat" }));
    expect(view.onOpenConversation).toHaveBeenCalledWith(chat);
  });

  it("closes the detail with Escape and returns focus to the row", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo(firstId, "Write release notes")]));
    const title = titleButton("Write release notes");
    await user.click(title);
    await user.click(within(screen.getByRole("complementary", { name: "Task details" })).getByRole("textbox", { name: "Note" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    expect(title).toHaveFocus();
    await act(async () => undefined);
  });

  it("keeps the card open when Escape closes a select inside it", async () => {
    harness(snapshot([todo(firstId, "Write release notes")]));
    fireEvent.click(titleButton("Write release notes"));
    const reasoning = screen.getByRole("combobox", { name: "Reasoning" });
    reasoning.focus();
    fireEvent.keyDown(reasoning, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Task details" })).not.toHaveClass("is-leaving");
  });

  it("closes the detail with one Escape while the close button's tooltip is showing", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Write release notes")]));
    await user.click(screen.getByRole("button", { name: /^Write release notes/u }));
    const close = screen.getByRole("button", { name: "Close task details" });
    fireEvent.pointerEnter(close, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
    fireEvent.keyDown(close, { key: "Escape" });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.querySelector(".task-detail")).toHaveClass("is-leaving");
    await act(async () => undefined);
  });

  it("lets the closed detail fade out inert before removing it", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo(firstId, "Write release notes")]));
    await user.click(titleButton("Write release notes"));
    await user.click(screen.getByRole("button", { name: "Close task details" }));
    const leaving = document.querySelector(".task-detail");
    expect(leaving).toHaveClass("is-leaving");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(leaving).toHaveAttribute("inert");
    expect(document.querySelector(".tasks-layout")).not.toHaveClass("has-detail");
    await waitFor(() => expect(document.querySelector(".task-detail")).toBeNull());
  });

  it("opens a requested task and focuses the add row on request", async () => {
    const view = harness(snapshot([
      todo(firstId, "Write release notes"),
      todo(secondId, "Book the venue", { completedAt: doneAt() }),
    ]));
    view.setProps({ openTaskRequest: { id: secondId, nonce: 1 } });
    const detail = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(detail).getByRole("textbox", { name: "Title" })).toHaveValue("Book the venue");
    expect(screen.getByRole("list", { name: "Done" })).toBeVisible();
    expect(titleButton("Book the venue")).toHaveAttribute("aria-current", "true");

    view.setProps({ focusAddRequest: 1 });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus());
  });

  it("acts on open and add requests that are already set when Tasks mounts", async () => {
    const first = harness(snapshot([todo(firstId, "Write release notes")]), { focusAddRequest: 3 });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus());
    first.unmount();
    harness(snapshot([todo(firstId, "Write release notes")]), { openTaskRequest: { id: firstId, nonce: 1 } });
    expect(await screen.findByRole("complementary", { name: "Task details" })).toBeVisible();
  });
});

function doneAt(): string {
  return "2026-10-11T07:00:00.000Z";
}

describe("Tasks stylesheet", () => {
  const css = readFileSync("src/renderer/src/components/TasksView.css", "utf8").replaceAll("\r\n", "\n");
  const block = (start: string): string => {
    const from = css.indexOf(start);
    if (from < 0) return "";
    let depth = 0;
    for (let index = css.indexOf("{", from); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      if (depth === 0) return css.slice(from, index + 1);
    }
    return css.slice(from);
  };

  it("uses semantic colour tokens only so preset and custom themes apply", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/u);
    for (const token of ["working", "approval", "input", "failed", "completed"]) {
      expect(css).toContain(`var(--status-${token})`);
    }
  });

  it("stays plain: no shadows beyond the popover token, uppercase labels or pill shapes", () => {
    const shadows = css.match(/box-shadow:[^;]*;/gu) ?? [];
    expect(shadows.length).toBeGreaterThan(0);
    expect(new Set(shadows)).toEqual(new Set(["box-shadow: var(--shadow-float);"]));
    expect(css).not.toMatch(/text-transform|999px/u);
  });

  it("rings the title, note and add fields with the focus colour when they have keyboard focus", () => {
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
    };
    expect(rule(".task-detail-title:focus-visible,\n.task-detail-note:focus-visible,\n.task-add:has(.task-add-input:focus-visible)"))
      .toContain("outline: 2px solid var(--focus-ring);");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.task-add:has\(\.task-add-input:focus-visible\) \{\s*outline: 2px solid Highlight;/u);
  });

  it("pushes the card over the list in narrow containers and scrolls it inside wide ones", () => {
    const narrow = block("@container tasks-view (max-width: 760px)");
    expect(narrow).toMatch(/\.tasks-layout\.has-detail \.tasks-main \{\s*display: none;/u);
    expect(narrow).toMatch(/\.task-detail \{\s*position: static;\s*width: auto;\s*max-height: none;/u);
    expect(narrow).toMatch(/transition: none;/u);
    const card = block(".task-detail {");
    expect(card).toMatch(/position: sticky;/u);
    expect(card).toMatch(/max-height: calc\(100vh - 136px\);/u);
    expect(card).toMatch(/overflow-y: auto;/u);
  });

  it("turns off the shimmer, toast and completion motion under reduced motion and forced colours", () => {
    const reduced = block("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/\.task-row-slot/u);
    expect(reduced).toMatch(/\.tasks-toast,?\s/u);
    expect(reduced).toMatch(/\.task-status\.is-live,\s*\.task-well-headline\.is-live \{\s*animation: none;\s*background: none;\s*-webkit-text-fill-color: currentColor;/u);
    const forced = block("@media (forced-colors: active)");
    expect(forced).toMatch(/\.task-status\.is-live,\s*\.task-well-headline\.is-live \{\s*animation: none;/u);
    expect(css).toMatch(/animation: task-status-shimmer 2s steps\(40, end\) infinite;/u);
    expect(css).toMatch(/\.app-shell\[data-document-visible="false"\] \.task-status\.is-live/u);
    expect(css).toMatch(/\.task-row-slot\.is-collapsing \{\s*grid-template-rows: 0fr;/u);
    expect(css).toMatch(/\.tasks-toast \{\s*animation: dialog-surface-in var\(--dur\) var\(--ease\) backwards;/u);
  });
});

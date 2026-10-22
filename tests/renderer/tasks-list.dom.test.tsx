import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { ConversationShell, ServerEvent } from "../../src/shared/contracts";
import {
  check,
  conversation,
  firstId,
  firstProjectId,
  fourthId,
  harness,
  NOW,
  ok,
  openTitles,
  row,
  secondId,
  secondProjectId,
  sent,
  snapshot,
  stubMatchMedia,
  thirdId,
  titleButton,
  todo,
  turn,
} from "./tasks-fixtures";

const doneAt = "2026-10-11T07:00:00.000Z";

function chat(id: string, overrides: Partial<ConversationShell> = {}): ConversationShell {
  return conversation({ id, ...overrides });
}

function chatId(index: number): string {
  return `${String(index).repeat(8)}-0000-4000-8000-${String(index).repeat(12)}`;
}

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

describe("Task rows", () => {
  it("orders by what needs you, overdue first, and sums it up in one line", () => {
    const ids = [1, 2, 3, 4, 5, 6].map(chatId);
    harness(snapshot([
      todo("10000000-0000-4000-8000-000000000001", "Plain later", { createdAt: "2026-10-01T07:00:00.000Z" }),
      todo("10000000-0000-4000-8000-000000000002", "Urgent someday", { priority: "urgent", dueDate: "2027-02-03" }),
      todo("10000000-0000-4000-8000-000000000003", "Overdue certificate", { dueDate: "2026-10-01" }),
      todo("10000000-0000-4000-8000-000000000004", "Due today", { dueDate: "2026-10-12" }),
      todo("10000000-0000-4000-8000-000000000005", "Agent working", { conversationId: ids[0]! }),
      todo("10000000-0000-4000-8000-000000000006", "Agent ready", { conversationId: ids[1]! }),
      todo("10000000-0000-4000-8000-000000000007", "Agent failed", { conversationId: ids[2]! }),
      todo("10000000-0000-4000-8000-000000000008", "Agent asks", {
        conversationId: ids[3]!,
      }),
      todo("10000000-0000-4000-8000-000000000009", "Agent archived", { conversationId: ids[4]! }),
      todo("10000000-0000-4000-8000-00000000000a", "High flag", { priority: "high" }),
      todo("10000000-0000-4000-8000-00000000000b", "Finished long ago", { completedAt: doneAt }),
    ], {
      conversations: [
        chat(ids[0]!, { status: "running" }),
        chat(ids[1]!, { status: "completed", latestTurn: turn() }),
        chat(ids[2]!, { status: "failed", latestTurn: turn({ status: "failed", terminalReason: "Out of disk" }) }),
        chat(ids[3]!, { status: "needs-input", attentionKind: "approval" }),
        chat(ids[4]!, { status: "completed", archivedAt: "2026-10-12T06:00:00.000Z", latestTurn: turn() }),
        chat(ids[5]!, { status: "idle" }),
      ],
    }));
    expect(openTitles()).toEqual([
      "Agent asks",
      "Agent failed",
      "Agent ready",
      "Agent working",
      "Overdue certificate",
      "Urgent someday",
      "High flag",
      "Due today",
      "Plain later",
      "Agent archived",
    ]);
    expect(screen.getByText("3 need you · 1 working · 6 to do")).toBeVisible();

    const word = (title: string) => row(title).querySelector(".task-status");
    expect(word("Agent working")).toHaveTextContent("Working…");
    expect(word("Agent working")).toHaveClass("is-working");
    expect(word("Agent ready")).toHaveTextContent("Ready for you");
    expect(word("Agent ready")).toHaveClass("is-completed");
    expect(word("Agent failed")).toHaveTextContent("Failed");
    expect(word("Agent failed")).toHaveClass("is-failed");
    expect(word("Agent asks")).toHaveTextContent("Needs your OK");
    expect(word("Agent asks")).toHaveClass("is-approval");
    expect(word("Agent archived")).toHaveTextContent("Chat archived");
    expect(word("Agent archived")).toHaveClass("is-muted");
    expect(row("Agent ready").textContent).not.toMatch(/Done/u);

    const overdue = row("Overdue certificate").querySelector(".task-due");
    expect(overdue).toHaveTextContent("Overdue · 11 d");
    expect(overdue).toHaveClass("is-overdue");
    expect(row("Due today").querySelector(".task-due")).toHaveClass("is-today");
    expect(check("Agent ready")).toHaveAccessibleName("Mark as done: Agent ready (Ready for you)");
    expect(check("Plain later")).toHaveAccessibleName("Mark as done: Plain later");

    expect(row("Urgent someday").querySelector(".task-urgent")).toHaveTextContent("!");
    const high = row("High flag").querySelector(".task-high");
    expect(high).toHaveTextContent("High priority");
    expect(high?.querySelector("svg")).not.toBeNull();
    expect(row("Plain later").querySelector(".task-urgent, .task-high")).toBeNull();
  });

  it("summarises single and empty lists", () => {
    const view = harness(snapshot([
      todo(firstId, "Agent asks", { conversationId: chatId(1) }),
    ], { conversations: [chat(chatId(1), { status: "needs-input", attentionKind: "input" })] }));
    expect(screen.getByText("1 needs you")).toBeVisible();
    expect(row("Agent asks").querySelector(".task-status")).toHaveTextContent("Asked you a question");
    expect(row("Agent asks").querySelector(".task-status")).toHaveClass("is-input");
    view.update(snapshot([todo(firstId, "Agent asks", { completedAt: doneAt })]));
    expect(screen.getByText("All done")).toBeVisible();
    view.update(snapshot([]));
    expect(screen.getByText("Add anything you need to do")).toBeVisible();
  });
});

describe("Task list keyboard", () => {
  it("has one tab stop per row and moves with the arrows, Home and End", async () => {
    const user = userEvent.setup();
    harness(snapshot([
      todo(firstId, "First"),
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
      todo(thirdId, "Third", { createdAt: "2026-10-12T09:00:00.000Z" }),
      todo(fourthId, "Finished", { completedAt: doneAt }),
    ]));
    expect(check("First")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Actions for First" })).toHaveAttribute("tabindex", "-1");
    expect(titleButton("Second")).toHaveAttribute("tabindex", "-1");

    await user.tab();
    expect(titleButton("First")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Done 1" })).toHaveFocus();

    titleButton("First").focus();
    await user.keyboard("{ArrowDown}");
    expect(titleButton("Second")).toHaveFocus();
    expect(titleButton("Second")).toHaveAttribute("tabindex", "0");
    expect(titleButton("First")).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{End}");
    expect(titleButton("Third")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(titleButton("First")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(titleButton("First")).toHaveFocus();
    await user.keyboard("{End}{ArrowDown}");
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    const toggle = screen.getByRole("button", { name: "Done 1" });
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    expect(titleButton("Finished")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(toggle).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(titleButton("Third")).toHaveFocus();
  });

  it("opens with Enter or the right arrow, closes with the left arrow and renames with F2", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo(firstId, "First"), todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" })]));
    titleButton("First").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary", { name: "Task details" })).toBeVisible();
    expect(titleButton("First")).toHaveFocus();
    expect(titleButton("First")).toHaveAttribute("aria-current", "true");
    await user.keyboard("{ArrowLeft}");
    expect(document.querySelector(".tasks-layout")).not.toHaveClass("has-detail");
    expect(titleButton("First")).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(titleButton("Second")).toHaveAttribute("aria-current", "true");
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(titleButton("Second")).toHaveAttribute("aria-current", "true");

    await user.keyboard("{F2}");
    const title = screen.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    await waitFor(() => expect(title).toHaveFocus());
    expect(title.value).toBe("First");
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, "First".length]);
  });

  it("toggles done with Space without opening the card", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "First"), todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" })]));
    titleButton("First").focus();
    await user.keyboard(" ");
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: firstId, patch: { completed: true } },
    }]);
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    expect(titleButton("Second")).toHaveFocus();
  });

  it("deletes with undo: the row hides, Undo restores it with focus, and nothing is sent", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const view = harness(snapshot([todo(firstId, "First"), todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" })]));
    titleButton("First").focus();
    await user.keyboard("{Delete}");
    expect(openTitles()).toEqual(["Second"]);
    expect(titleButton("Second")).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Deleted “First”");
    expect(screen.getByText("1 to do")).toBeVisible();

    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    expect(openTitles()).toEqual(["First", "Second"]);
    await waitFor(() => expect(titleButton("First")).toHaveFocus());
    expect(sent(view.request, "todo.delete")).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("batches deletes, undoes the latest with Cmd/Ctrl+Z, and sends the rest when the timer ends", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const view = harness(snapshot([
      todo(firstId, "First"),
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
      todo(thirdId, "Third", { createdAt: "2026-10-12T09:00:00.000Z" }),
    ]));
    fireEvent.keyDown(titleButton("First"), { key: "Delete" });
    fireEvent.keyDown(titleButton("Second"), { key: "Backspace" });
    expect(screen.getByRole("status")).toHaveTextContent("Deleted 2 tasks");
    expect(openTitles()).toEqual(["Third"]);

    fireEvent.keyDown(titleButton("Third"), { key: "z", ctrlKey: true });
    expect(openTitles()).toEqual(["Second", "Third"]);
    expect(screen.getByRole("status")).toHaveTextContent("Deleted “First”");

    const field = screen.getByRole("textbox", { name: "Add a task" });
    fireEvent.change(field, { target: { value: "Draft" } });
    fireEvent.keyDown(field, { key: "z", metaKey: true });
    expect(openTitles()).toEqual(["Second", "Third"]);
    fireEvent.change(field, { target: { value: "" } });

    await act(async () => { vi.advanceTimersByTime(5_900); });
    expect(sent(view.request, "todo.delete")).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(sent(view.request, "todo.delete")).toEqual([{ type: "todo.delete", payload: { id: firstId } }]);
    view.update(snapshot([
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
      todo(thirdId, "Third", { createdAt: "2026-10-12T09:00:00.000Z" }),
    ]));
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(document.querySelector(".tasks-toast")).toBeNull();
  });

  it("undoes with Cmd/Ctrl+Z after deleting the last open task leaves focus in the empty add field", async () => {
    const user = userEvent.setup();
    harness(snapshot([todo(firstId, "Only")]));
    titleButton("Only").focus();
    await user.keyboard("{Delete}");
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus();
    expect(openTitles()).toEqual([]);
    await user.keyboard("{Meta>}z{/Meta}");
    expect(openTitles()).toEqual(["Only"]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("sends a pending delete when the toast is dismissed, the page hides or Tasks closes", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "First"),
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
      todo(thirdId, "Third", { createdAt: "2026-10-12T09:00:00.000Z" }),
    ]));
    fireEvent.keyDown(titleButton("First"), { key: "Delete" });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(sent(view.request, "todo.delete").map(({ payload }) => payload.id)).toEqual([firstId]);

    fireEvent.keyDown(titleButton("Second"), { key: "Delete" });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(sent(view.request, "todo.delete").map(({ payload }) => payload.id)).toEqual([firstId, secondId]);

    fireEvent.keyDown(titleButton("Third"), { key: "Delete" });
    view.unmount();
    expect(sent(view.request, "todo.delete").map(({ payload }) => payload.id)).toEqual([firstId, secondId, thirdId]);
  });

  it("clears done from the Done row's menu with undo and sends one clear", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "Open"),
      todo(secondId, "Old one", { completedAt: doneAt }),
      todo(thirdId, "Old two", { completedAt: doneAt }),
    ]));
    const actions = screen.getByRole("button", { name: "Done actions" });
    expect(actions).toHaveAttribute("tabindex", "-1");
    await user.click(actions);
    const menu = screen.getByRole("menu", { name: "Done actions" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Clear done"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Clear done" }));
    expect(screen.queryByRole("button", { name: /^Done/u })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Cleared 2 done tasks");
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    const toggle = screen.getByRole("button", { name: "Done 2" });
    await waitFor(() => expect(toggle).toHaveFocus());

    toggle.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(screen.getByRole("menuitem", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(sent(view.request, "todo.clearDone")).toEqual([{ type: "todo.clearDone", payload: { ids: [secondId, thirdId] } }]);
    expect(sent(view.request, "todo.delete")).toEqual([]);
  });

  it("brings deleted and cleared tasks back when the delayed request fails", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "todo.delete" || command.type === "todo.clearDone") throw new Error("Not connected.");
      return ok();
    });
    const tasks = () => [
      todo(firstId, "Keep me"),
      todo(secondId, "Other"),
      todo(thirdId, "Old one", { completedAt: doneAt }),
    ];
    const view = harness(snapshot(tasks()), { request });
    titleButton("Keep me").focus();
    await user.keyboard("{Delete}");
    await user.click(screen.getByRole("button", { name: "Done actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Clear done" }));
    expect(openTitles()).toEqual(["Other"]);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(openTitles()).toEqual(["Keep me", "Other"]));
    expect(screen.getByRole("button", { name: "Done 1" })).toBeVisible();

    view.update(snapshot(tasks()));
    expect(openTitles()).toEqual(["Keep me", "Other"]);
    expect(screen.getByRole("button", { name: "Done 1" })).toBeVisible();
  });

  it("clears only the done tasks it showed when another task finishes before the toast closes", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "Open"),
      todo(secondId, "Old one", { completedAt: doneAt }),
    ]));
    await user.click(screen.getByRole("button", { name: "Done actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Clear done" }));
    await user.click(check("Open"));
    view.update(snapshot([
      todo(firstId, "Open", { completedAt: "2026-10-12T09:00:00.000Z" }),
      todo(secondId, "Old one", { completedAt: doneAt }),
    ]));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(sent(view.request, "todo.clearDone")).toEqual([{ type: "todo.clearDone", payload: { ids: [secondId] } }]);
    expect(sent(view.request, "todo.delete")).toEqual([]);
  });

  it("clears only the visible done tasks when the list is scoped to a project", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "Mine", { completedAt: doneAt, projectId: firstProjectId }),
      todo(secondId, "Theirs", { completedAt: doneAt, projectId: secondProjectId }),
    ]), { projectScopeId: firstProjectId });
    await user.click(screen.getByRole("button", { name: "Done actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Clear done" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(sent(view.request, "todo.clearDone")).toEqual([{ type: "todo.clearDone", payload: { ids: [firstId] } }]);
    expect(sent(view.request, "todo.delete")).toEqual([]);
  });

  it("does nothing destructive with the keys while offline and disables menu items except Open chat", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "Linked", { conversationId: chatId(1) }),
    ], { conversations: [chat(chatId(1))] }), { status: "offline" });
    titleButton("Linked").focus();
    await user.keyboard(" {Delete}");
    expect(view.request).not.toHaveBeenCalled();
    expect(openTitles()).toEqual(["Linked"]);
    expect(check("Linked")).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Add a task" })).toBeDisabled();

    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = screen.getByRole("menu", { name: "Actions for Linked" });
    expect(within(menu).getAllByRole("menuitem").map((item) => [item.textContent, (item as HTMLButtonElement).disabled]))
      .toEqual([["Rename", true], ["Open chat", false], ["Mark as done", true], ["Delete", true]]);
    expect(within(menu).getByRole("menuitem", { name: "Open chat" })).toHaveFocus();
  });
});

describe("Task completion", () => {
  it("holds the finished row, collapses it and only then moves it under Done", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const view = harness(snapshot([
      todo(firstId, "First"),
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
    ]));
    fireEvent.click(check("First"));
    expect(check("First")).toBeChecked();
    expect(row("First")).toHaveClass("is-completing");
    expect(row("First")).not.toHaveClass("is-collapsing");
    expect(screen.queryByRole("button", { name: /^Done/u })).toBeNull();
    expect(screen.getByText("2 to do")).toBeVisible();
    view.update(snapshot([
      todo(firstId, "First", { completedAt: NOW.toISOString() }),
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
    ]));
    expect(openTitles()).toEqual(["First", "Second"]);

    await act(async () => { vi.advanceTimersByTime(400); });
    expect(row("First")).toHaveClass("is-collapsing");
    expect(screen.getByRole("button", { name: "Done 1" })).toBeVisible();
    expect(screen.getByText("1 to do")).toBeVisible();

    await act(async () => { vi.advanceTimersByTime(180); });
    expect(openTitles()).toEqual(["Second"]);
    expect(screen.getByRole("button", { name: "Done 1" })).toBeVisible();
  });

  it("moves the row at once under reduced motion", () => {
    stubMatchMedia(true);
    harness(snapshot([
      todo(firstId, "First"),
      todo(secondId, "Second", { createdAt: "2026-10-12T08:00:00.000Z" }),
    ]));
    fireEvent.click(check("First"));
    expect(openTitles()).toEqual(["Second"]);
    expect(screen.getByRole("button", { name: "Done 1" })).toBeVisible();
  });

  it("puts the row back when the service refuses the completion", async () => {
    stubMatchMedia(true);
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "todo.update") throw new Error("Offline");
      return ok();
    });
    harness(snapshot([todo(firstId, "First")]), { request });
    fireEvent.click(check("First"));
    await waitFor(() => expect(openTitles()).toEqual(["First"]));
    expect(check("First")).not.toBeChecked();
  });
});

describe("Project scope", () => {
  it("shows the scoped project's tasks with unassigned ones and creates into the scope", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([
      todo(firstId, "Mine", { projectId: firstProjectId }),
      todo(secondId, "Theirs", { projectId: secondProjectId }),
      todo(thirdId, "Unassigned"),
    ]), { projectScopeId: firstProjectId });
    expect(openTitles()).toEqual(["Mine", "Unassigned"]);
    expect(screen.getByText("2 to do")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Add a task" }), "New one{Enter}");
    expect(sent(view.request, "todo.create")[0]!.payload.projectId).toBe(firstProjectId);

    view.setProps({ projectScopeId: null });
    expect(openTitles()).toEqual(["Mine", "Theirs", "Unassigned"]);
  });

  it("closes the card when its task leaves the scope", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Mine", { projectId: firstProjectId })]), { projectScopeId: firstProjectId });
    await user.click(titleButton("Mine"));
    await user.click(screen.getByRole("button", { name: "Project: Inertia" }));
    const menu = screen.getByRole("menu", { name: "Project" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["Inertia", "Companion", "No project"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Companion" }));
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: firstId, patch: { projectId: secondProjectId } },
    }]);
    view.update(snapshot([todo(firstId, "Mine", { projectId: secondProjectId })]));
    expect(document.querySelector(".tasks-layout")).not.toHaveClass("has-detail");
    expect(openTitles()).toEqual([]);
  });
});

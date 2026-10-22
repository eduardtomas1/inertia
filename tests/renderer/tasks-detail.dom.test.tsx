import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { ConversationShell, ServerEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { Todo } from "../../src/shared/todos";
import {
  conversation,
  conversationId,
  firstId,
  harness,
  NOW,
  ok,
  otherConversationId,
  row,
  secondProjectId,
  sent,
  settings,
  snapshot,
  started,
  stubMatchMedia,
  titleButton,
  todo,
  turn,
} from "./tasks-fixtures";

const longAgo = "2026-10-12T05:00:00.000Z";

function linked(overrides: Partial<Todo> = {}): Todo {
  return todo(firstId, "Clean the downloads folder", { conversationId, linkedAt: longAgo, ...overrides });
}

function openCard(): HTMLElement {
  fireEvent.click(titleButton("Clean the downloads folder"));
  return screen.getByRole("complementary", { name: "Task details" });
}

function well(card: HTMLElement): HTMLElement {
  return card.querySelector<HTMLElement>(".task-well")!;
}

function actionNames(card: HTMLElement): [string, boolean][] {
  return [...card.querySelectorAll<HTMLButtonElement>(".task-actions-row button")]
    .map((button) => [button.textContent ?? "", button.classList.contains("primary-button")]);
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

describe("Task card wells", () => {
  const cases: {
    name: string;
    chat: Partial<ConversationShell> | null;
    todo?: Partial<Todo>;
    headline: string;
    actions: [string, boolean][];
    tone: string;
  }[] = [
    { name: "working", chat: { status: "running" }, headline: "Codex is working on it", actions: [["Stop", false], ["Open chat", true]], tone: "is-working" },
    { name: "approval", chat: { status: "needs-input", attentionKind: "approval" }, headline: "Codex wants your OK", actions: [["Open chat", true]], tone: "is-approval" },
    { name: "question", chat: { status: "needs-input", attentionKind: "input" }, headline: "Codex asked you a question", actions: [["Open chat", true]], tone: "is-input" },
    {
      name: "limited",
      chat: { status: "failed", latestTurn: turn({ status: "failed", usageLimited: true }) },
      headline: "Codex hit a usage limit",
      actions: [["Open chat", true]],
      tone: "is-approval",
    },
    {
      name: "review",
      chat: { status: "completed", latestTurn: turn({ completedAt: new Date(NOW.getTime() - 7_200_000).toISOString() }) },
      headline: "Finished · 2 h ago",
      actions: [["Open chat", false], ["Mark as done", true]],
      tone: "is-completed",
    },
    {
      name: "failed",
      chat: { status: "failed", latestTurn: turn({ status: "failed", terminalReason: "provider-error" }) },
      headline: "Failed",
      actions: [["Open chat", false], ["Try again", true]],
      tone: "is-failed",
    },
    {
      name: "stopped",
      chat: { status: "idle", latestTurn: turn({ status: "cancelled" }) },
      headline: "Stopped",
      actions: [["Open chat", false], ["Hand off again", true]],
      tone: "is-muted",
    },
    {
      name: "archived",
      chat: { status: "running", archivedAt: longAgo },
      headline: "This chat was archived.",
      actions: [["Open chat", false], ["Hand off again", true]],
      tone: "is-muted",
    },
    {
      name: "parked",
      chat: { status: "idle", latestTurn: null },
      headline: "The chat never started.",
      actions: [["Open chat", false], ["Hand off again", true]],
      tone: "is-muted",
    },
    {
      name: "done",
      chat: { status: "completed", latestTurn: turn() },
      todo: { completedAt: "2026-10-11T07:00:00.000Z" },
      headline: "Done · 11 Oct",
      actions: [["Open chat", false], ["Reopen", true]],
      tone: "is-muted",
    },
    {
      name: "done without a chat",
      chat: null,
      todo: { completedAt: "2026-10-11T07:00:00.000Z", conversationId: null, linkedAt: null },
      headline: "Done · 11 Oct",
      actions: [["Reopen", true]],
      tone: "is-muted",
    },
  ];

  for (const entry of cases) {
    it(`shows the ${entry.name} well with one primary action`, async () => {
      harness(snapshot([linked(entry.todo)], {
        conversations: entry.chat ? [conversation(entry.chat)] : [],
      }));
      if (entry.todo?.completedAt) fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
      const card = openCard();
      expect(well(card)).toHaveClass(entry.tone);
      expect(well(card).querySelector(".task-well-headline")).toHaveTextContent(entry.headline);
      expect(actionNames(card)).toEqual(entry.actions);
      expect(within(card).queryByRole("group", { name: "Hand it to an agent" })).toBeNull();
      if (entry.name === "failed") {
        expect(well(card).querySelector(".task-well-detail")).toBeNull();
      }
    });
  }

  it("names the agent with the provider label from settings", () => {
    harness(snapshot([linked()], { conversations: [conversation()] }), {
      settings: { ...settings, providerIdentityLabels: { codex: "Work Codex" } },
    });
    expect(well(openCard())).toHaveTextContent("Work Codex is working on it");
  });

  it("stops a working agent with the composer's stop command", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([linked()], { conversations: [conversation()] }));
    const card = openCard();
    await user.click(within(card).getByRole("button", { name: "Stop" }));
    expect(sent(view.request, "agent.stop")).toEqual([{ type: "agent.stop", payload: { conversationId } }]);
    expect(view.onOpenConversation).not.toHaveBeenCalled();
  });

  it("marks a ready task done from the card and with Cmd/Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const chat = conversation({ status: "completed", latestTurn: turn() });
    const view = harness(snapshot([linked()], { conversations: [chat] }));
    let card = openCard();
    await user.click(within(card).getByRole("button", { name: "Mark as done" }));
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: firstId, patch: { completed: true } },
    }]);
    expect(well(card)).toHaveTextContent("Done ·");
    await user.click(within(card).getByRole("button", { name: "Reopen" }));
    view.update(snapshot([linked()], { conversations: [chat] }));
    card = screen.getByRole("complementary", { name: "Task details" });
    await waitFor(() => expect(well(card)).toHaveTextContent("Finished"));

    fireEvent.keyDown(within(card).getByRole("textbox", { name: "Note" }), { key: "Enter", ctrlKey: true });
    expect(sent(view.request, "todo.update").map(({ payload }) => payload.patch)).toEqual([
      { completed: true },
      { completed: false },
      { completed: true },
    ]);
  });

  it("opens the chat from the card and never navigates on its own", async () => {
    const user = userEvent.setup();
    const chat = conversation({ status: "completed", latestTurn: turn() });
    const view = harness(snapshot([linked()], { conversations: [chat] }));
    const card = openCard();
    await user.click(within(card).getByRole("button", { name: "Open chat" }));
    expect(view.onOpenConversation).toHaveBeenCalledWith(chat);
  });

  it("offers the row's actions minus Rename from the card's more menu", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([linked()], { conversations: [conversation()] }));
    const card = openCard();
    const more = within(card).getByRole("button", { name: "More actions for Clean the downloads folder" });
    await user.click(more);
    const menu = screen.getByRole("menu", { name: "More actions for Clean the downloads folder" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Open chat", "Mark as done", "Delete"]);
    await user.keyboard("{Escape}");
    expect(more).toHaveFocus();
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(document.querySelector(".tasks-layout")).not.toHaveClass("has-detail");
    expect(screen.getByRole("status")).toHaveTextContent("Deleted “Clean the downloads folder”");
    expect(sent(view.request, "todo.delete")).toEqual([]);
  });
});

describe("Starting from the card", () => {
  it("stays in Tasks, shows the starting well and focuses Open chat until the chat works", async () => {
    const user = userEvent.setup();
    let finish: (event: ServerEvent) => void = () => undefined;
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => command.type === "todo.start"
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(ok()));
    const view = harness(snapshot([todo(firstId, "Clean the downloads folder")]), { request });
    const card = openCard();
    await user.click(within(card).getByRole("button", { name: "Start" }));

    expect(well(card).querySelector(".task-well-headline")).toHaveTextContent("Starting…");
    expect(well(card).querySelector(".task-well-headline")).toHaveClass("is-live");
    expect(row("Clean the downloads folder").querySelector(".task-status")).toHaveTextContent("Starting…");
    const openChat = within(card).getByRole("button", { name: "Open chat" });
    expect(openChat).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(openChat).toHaveFocus());
    expect(within(card).queryByRole("group", { name: "Hand it to an agent" })).toBeNull();

    await act(async () => { finish(started()); });
    const chat = conversation();
    view.update(snapshot([todo(firstId, "Clean the downloads folder", {
      conversationId,
      linkedAt: NOW.toISOString(),
    })], { conversations: [chat] }));
    expect(well(card)).toHaveTextContent("Codex is working on it");
    expect(openChat).toHaveFocus();
    expect(openChat).not.toHaveAttribute("aria-disabled");
    await user.keyboard("{Enter}");
    expect(view.onOpenConversation).toHaveBeenCalledWith(chat);
  });

  it("starts with Cmd/Ctrl+Enter from the note and saves the note first", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> =>
      command.type === "todo.start" ? started() : ok());
    harness(snapshot([todo(firstId, "Clean the downloads folder")]), { request });
    const card = openCard();
    const note = within(card).getByRole("textbox", { name: "Note" });
    await user.type(note, "Only the screenshots");
    fireEvent.keyDown(note, { key: "Enter", metaKey: true });
    await waitFor(() => expect(sent(request, "todo.start")).toHaveLength(1));
    expect(request.mock.calls.map(([command]) => command.type)).toEqual(["todo.update", "todo.start"]);
    expect(sent(request, "todo.update")[0]!.payload.patch).toEqual({ note: "Only the screenshots" });
  });

  it("tries a failed hand-off again with the previous model and replaces the old chat", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> =>
      command.type === "todo.start" ? started(otherConversationId) : ok());
    const previous = {
      ...providerNativeModelSelection({ providerId: "codex" }),
      modelId: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    };
    const chat = conversation({
      projectId: secondProjectId,
      modelSelection: previous,
      status: "failed",
      latestTurn: turn({ status: "failed" }),
    });
    harness(snapshot([linked()], { conversations: [chat] }), { request });
    const card = openCard();
    await user.click(within(card).getByRole("button", { name: "Try again" }));
    const form = within(card).getByRole("group", { name: "Hand it to an agent" });
    expect(well(card)).toHaveTextContent("Failed");
    expect(within(form).getByRole("combobox", { name: "Reasoning" })).toHaveValue("xhigh");
    expect(within(form).getByRole("combobox", { name: "Project" })).toHaveValue(secondProjectId);
    await waitFor(() => expect(within(form).getByRole("button", { name: "Start" })).toHaveFocus());

    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("group", { name: "Hand it to an agent" })).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Try again" }));
    await user.click(within(card).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(sent(request, "todo.start")).toHaveLength(1));
    const [start] = sent(request, "todo.start");
    expect(start!.payload.replaces).toBe(conversationId);
    expect(start!.payload.conversation).toMatchObject({
      projectId: secondProjectId,
      modelSelection: { reasoningEffort: "xhigh" },
    });
    expect(well(card)).toHaveTextContent("Starting…");
  });

  it("returns focus to the retry button when the form is cancelled", async () => {
    const user = userEvent.setup();
    harness(snapshot([linked()], {
      conversations: [conversation({ status: "failed", latestTurn: turn({ status: "failed" }) })],
    }));
    const card = openCard();
    await user.click(within(card).getByRole("button", { name: "Try again" }));
    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("group", { name: "Hand it to an agent" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Try again" })).toHaveFocus();
  });

  it("never offers the hand-off on a done task", () => {
    harness(snapshot([todo(firstId, "Clean the downloads folder", { completedAt: "2026-10-11T07:00:00.000Z" })]));
    fireEvent.click(screen.getByRole("button", { name: "Done 1" }));
    const card = openCard();
    expect(within(card).queryByRole("group", { name: "Hand it to an agent" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Reopen" })).toHaveClass("primary-button");
  });
});

describe("Task card edits", () => {
  it("reverts the title and note the service refused", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "todo.update") throw new Error("Tasks are too large.");
      return ok();
    });
    harness(snapshot([todo(firstId, "Clean the downloads folder", { note: "Old note" })]), { request });
    const card = openCard();
    const title = within(card).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Clean everything{Enter}");
    await waitFor(() => expect(title).toHaveValue("Clean the downloads folder"));

    const note = within(card).getByRole("textbox", { name: "Note" });
    await user.clear(note);
    await user.type(note, "New note");
    await user.tab();
    await waitFor(() => expect(note).toHaveValue("Old note"));
    expect(sent(request, "todo.update").map(({ payload }) => payload.patch)).toEqual([
      { title: "Clean everything" },
      { note: "New note" },
    ]);
  });

  it("keeps a saved title while the save is in flight", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => command.type === "todo.update"
      ? new Promise((resolve) => { finish = () => resolve(ok()); })
      : Promise.resolve(ok()));
    harness(snapshot([todo(firstId, "Clean the downloads folder")]), { request });
    const card = openCard();
    const title = within(card).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Clean everything{Enter}");
    await user.click(within(card).getByRole("textbox", { name: "Note" }));
    await user.click(title);
    await user.tab();
    expect(title).toHaveValue("Clean everything");
    await act(async () => finish());
    expect(title).toHaveValue("Clean everything");
    expect(sent(request, "todo.update")).toHaveLength(1);
  });

  it("flushes a dirty note when the page hides or the window is hidden", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Clean the downloads folder")]));
    const card = openCard();
    const note = within(card).getByRole("textbox", { name: "Note" });
    await user.type(note, "First");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(sent(view.request, "todo.update").map(({ payload }) => payload.patch)).toEqual([{ note: "First" }]);

    await user.type(note, " and second");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    visibility.mockRestore();
    expect(sent(view.request, "todo.update").map(({ payload }) => payload.patch)).toEqual([
      { note: "First" },
      { note: "First and second" },
    ]);
  });

  it("makes the card read-only while offline", () => {
    harness(snapshot([todo(firstId, "Clean the downloads folder")]), { status: "offline" });
    const card = openCard();
    expect(within(card).getByRole("textbox", { name: "Title" })).toHaveAttribute("readonly");
    expect(within(card).getByRole("textbox", { name: "Note" })).toHaveAttribute("readonly");
    for (const name of ["Due date", "Priority", "Project"]) {
      expect(within(card).getByRole("button", { name })).toBeDisabled();
    }
    expect(within(card).getByRole("button", { name: "Start" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Close task details" })).toBeEnabled();
  });

  it("shows the task's project on the third chip and clears it with No project", async () => {
    const user = userEvent.setup();
    const view = harness(snapshot([todo(firstId, "Clean the downloads folder", { projectId: secondProjectId })]));
    const card = openCard();
    const chip = within(card).getByRole("button", { name: "Project: Companion" });
    expect(chip).toHaveClass("is-set");
    await user.click(chip);
    const menu = screen.getByRole("menu", { name: "Project" });
    expect(within(menu).getByRole("menuitemradio", { name: "Companion" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(menu).getByRole("menuitemradio", { name: "No project" }));
    expect(chip).toHaveFocus();
    expect(sent(view.request, "todo.update")).toEqual([{
      type: "todo.update",
      payload: { id: firstId, patch: { projectId: null } },
    }]);
  });
});

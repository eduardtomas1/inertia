import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskBoard } from "../../src/renderer/src/components/TaskBoard";
import { conversation, snapshot } from "./task-board-fixtures";

const chats = [conversation({ id: "ready", projectId: "p", title: "Plan retries" }), conversation({ id: "done", projectId: "p", title: "Ship notes", settledAt: "2026-09-01T10:00:00.000Z" })];
function props() {
  return { snapshot: snapshot(chats), online: true, projectId: null, onProjectChange: vi.fn(), onOpen: vi.fn(), run: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn() };
}

describe("task board interactions", () => {
  it("creates a task without starting an agent and preserves project selection focus", async () => {
    const callbacks = props(); render(<TaskBoard {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("textbox", { name: "Task title" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Check cancellation" } });
    screen.getByRole("combobox", { name: "New task project" }).focus();
    fireEvent.change(screen.getByRole("combobox", { name: "New task project" }), { target: { value: "p" } });
    expect(screen.getByRole("combobox", { name: "New task project" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument());
    expect(callbacks.run).toHaveBeenCalledExactlyOnceWith("task.create", { type: "conversation.create", payload: { projectId: "p", title: "Check cancellation", activate: false } }, { reportError: false });
    await waitFor(() => expect(screen.getByRole("button", { name: "New task" })).toHaveFocus());
  });

  it("uses canonical settle/reopen commands, opens chats, and displays mutation errors", async () => {
    const callbacks = props(); render(<TaskBoard {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan retries" }));
    expect(callbacks.onOpen).toHaveBeenCalledWith(expect.objectContaining(chats[0]!));
    fireEvent.click(screen.getByRole("button", { name: "Settle Plan retries" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reopen Ship notes" })).toBeEnabled());
    expect(callbacks.run).toHaveBeenCalledWith("task.settle:ready", { type: "conversation.settle", payload: { conversationId: "ready" } }, { reportError: false });
    callbacks.run.mockRejectedValueOnce(new Error("Task changed. Please retry."));
    fireEvent.click(screen.getByRole("button", { name: "Reopen Ship notes" }));
    await screen.findByText("Task changed. Please retry.");
    expect(callbacks.run).toHaveBeenLastCalledWith("task.settle:done", { type: "conversation.unsettle", payload: { conversationId: "done" } }, { reportError: false });
    expect(within(screen.getByRole("region", { name: "Done" })).getByRole("button", { name: "Ship notes" })).toBeVisible();
  });

  it("keeps a settle control focused while its command is pending and after it fails", async () => {
    const callbacks = props();
    let fail!: (error: Error) => void;
    callbacks.run.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    render(<TaskBoard {...callbacks} />);
    const settle = screen.getByRole("button", { name: "Settle Plan retries" });
    settle.focus(); fireEvent.click(settle);
    expect(settle).not.toBeDisabled();
    expect(settle).toHaveAttribute("aria-disabled", "true");
    expect(settle).toHaveTextContent("Saving…");
    fireEvent.click(settle);
    expect(callbacks.run).toHaveBeenCalledTimes(1);
    fail(new Error("The task could not be updated."));
    await screen.findByText("The task could not be updated.");
    expect(settle).toHaveFocus();
    expect(settle).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the title field focused while a task is created", async () => {
    const callbacks = props();
    let fail!: (error: Error) => void;
    callbacks.run.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    render(<TaskBoard {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const title = screen.getByRole("textbox", { name: "Task title" });
    expect(title).toHaveAccessibleDescription("Create a chat to plan your work. The agent starts when you send a message.");
    fireEvent.change(title, { target: { value: "Check cancellation" } });
    fireEvent.submit(title);
    expect(title).not.toBeDisabled();
    expect(title).toHaveAttribute("readonly");
    fail(new Error("The task could not be created."));
    await screen.findByText("The task could not be created.");
    expect(title).toHaveFocus();
    expect(title).not.toHaveAttribute("readonly");
  });

  it("names empty columns in one quiet sentence", () => {
    render(<TaskBoard {...props()} />);
    expect(within(screen.getByRole("region", { name: "Working" })).getByText("No agents working.")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getByText("Nothing needs your attention.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "quarterly" } });
    expect(screen.getAllByText("No matching tasks.")).toHaveLength(4);
    expect(screen.getByText("No tasks match. Try another search or project.")).toBeVisible();
  });

  it("filters cards and disables mutations offline", () => {
    render(<TaskBoard {...props()} online={false} />);
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Settle Plan retries" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "Ship" } });
    expect(screen.queryByRole("button", { name: "Plan retries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ship notes" })).toBeVisible();
  });
});

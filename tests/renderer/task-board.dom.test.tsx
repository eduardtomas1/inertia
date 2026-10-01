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

  it("filters cards and disables mutations offline", () => {
    render(<TaskBoard {...props()} online={false} />);
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Settle Plan retries" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "Ship" } });
    expect(screen.queryByRole("button", { name: "Plan retries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ship notes" })).toBeVisible();
  });
});

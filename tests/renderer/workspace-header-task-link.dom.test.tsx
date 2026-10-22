import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { conversationLinkedTask } from "../../src/renderer/src/components/AppLayout";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import type { Todo } from "../../src/shared/todos";
import { conversation } from "./composer-fixtures";
import { hoverTooltipText } from "./tooltip-fixtures";

type HeaderProps = ComponentProps<typeof WorkspaceHeader>;

const chat = conversation("33333333-3333-4333-8333-333333333333");

function props(overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    project: {
      id: "11111111-1111-4111-8111-111111111111", name: "Studio", path: "/studio",
      normalizedPath: "/studio", repositoryIdentity: null, repositoryRoot: null,
      repositoryRelativePath: "", groupingMode: null, gitRepositoryLimit: 64,
      color: "#6366f1", status: "ready", createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
    conversation: chat, view: "workspace",
    sidebarCollapsed: false, gitStatus: null, branches: [], actions: [], busy: false,
    onOpenSidebar: vi.fn(), onOpenSettings: vi.fn(), onCloseSettings: vi.fn(),
    onOpenFolder: vi.fn(), onRevealFolder: vi.fn(), onOpenFiles: vi.fn(),
    onRefreshBranches: vi.fn(), onSwitchBranch: vi.fn(),
    onCreateBranch: vi.fn(), onCreateConversationOnBranch: vi.fn(),
    onCreateConversationInWorktree: vi.fn(), onCreateConversationInIsolatedWorktree: vi.fn(),
    onCommit: vi.fn(), onOpenPullRequest: vi.fn(), onPull: vi.fn(), onPush: vi.fn(),
    onRunAction: vi.fn(),
    ...overrides,
  };
}

function todo(id: string, conversationId: string | null, completedAt: string | null = null): Todo {
  return {
    id, title: `Task ${id}`, note: "", priority: null, dueDate: null, dueTime: null, projectId: null,
    completedAt, conversationId, linkedAt: null,
    createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z",
  };
}

describe("chat header task link", () => {
  it("links back to the task that started the chat and opens it", () => {
    const onOpenTask = vi.fn();
    render(<WorkspaceHeader {...props({ linkedTask: { id: "task-1", title: "Clean the downloads folder" }, onOpenTask })} />);
    const link = screen.getByRole("button", { name: "Task" });
    expect(link).toHaveClass("header-task-link");
    expect(link.querySelector(".lucide-list-todo")).toHaveAttribute("aria-hidden", "true");
    expect(link).toHaveAccessibleDescription("Clean the downloads folder");
    expect(link.closest(".header-title-wrap")).toBeNull();
    expect(link.previousElementSibling).toHaveClass("header-title-wrap", "has-task-link");
    expect(hoverTooltipText(link)).toBe("Clean the downloads folder");
    fireEvent.click(link);
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith("task-1");
  });

  it("stays out of chats without a task and of other views", () => {
    const onOpenTask = vi.fn();
    const task = { id: "task-1", title: "Clean the downloads folder" };
    const view = render(<WorkspaceHeader {...props({ onOpenTask })} />);
    expect(screen.queryByRole("button", { name: "Task" })).toBeNull();
    expect(view.container.querySelector(".header-title-wrap")).not.toHaveClass("has-task-link");
    view.rerender(<WorkspaceHeader {...props({ linkedTask: task, onOpenTask, view: "tasks" })} />);
    expect(screen.queryByRole("button", { name: "Task" })).toBeNull();
    view.rerender(<WorkspaceHeader {...props({ linkedTask: task, onOpenTask, conversation: null })} />);
    expect(screen.queryByRole("button", { name: "Task" })).toBeNull();
    view.rerender(<WorkspaceHeader {...props({ linkedTask: task })} />);
    expect(screen.queryByRole("button", { name: "Task" })).toBeNull();
  });
});

describe("conversation linked task", () => {
  it("prefers an open task linked to the chat and falls back to a done one", () => {
    const done = todo("done", chat.id, "2026-10-20T11:00:00.000Z");
    const open = todo("open", chat.id);
    const other = todo("other", "44444444-4444-4444-8444-444444444444");
    expect(conversationLinkedTask([done, other, open], chat.id)).toEqual({ id: "open", title: "Task open" });
    expect(conversationLinkedTask([done, other], chat.id)).toEqual({ id: "done", title: "Task done" });
    expect(conversationLinkedTask([other], chat.id)).toBeNull();
    expect(conversationLinkedTask(undefined, chat.id)).toBeNull();
    expect(conversationLinkedTask([open], null)).toBeNull();
  });
});

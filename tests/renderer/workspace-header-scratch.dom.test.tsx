import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { conversation } from "./composer-fixtures";
import { hoverTooltipText } from "./tooltip-fixtures";

type HeaderProps = ComponentProps<typeof WorkspaceHeader>;

function props(project: Partial<NonNullable<HeaderProps["project"]>>): HeaderProps {
  return {
    project: {
      id: "11111111-1111-4111-8111-111111111111", name: "Studio", path: "/studio",
      normalizedPath: "/studio", repositoryIdentity: null, repositoryRoot: null,
      repositoryRelativePath: "", groupingMode: null, gitRepositoryLimit: 64,
      color: "#6366f1", status: "ready", createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z", ...project,
    },
    conversation: conversation("33333333-3333-4333-8333-333333333333"), view: "workspace",
    sidebarCollapsed: false, gitStatus: null, branches: [], actions: [], busy: false,
    onOpenSidebar: vi.fn(), onOpenSettings: vi.fn(), onCloseSettings: vi.fn(),
    onOpenFolder: vi.fn(), onRevealFolder: vi.fn(), onOpenFiles: vi.fn(),
    onRefreshBranches: vi.fn(), onSwitchBranch: vi.fn(),
    onCreateBranch: vi.fn(), onCreateConversationOnBranch: vi.fn(),
    onCreateConversationInWorktree: vi.fn(), onCreateConversationInIsolatedWorktree: vi.fn(),
    onCommit: vi.fn(), onOpenPullRequest: vi.fn(), onPull: vi.fn(), onPush: vi.fn(),
    onRunAction: vi.fn(), onCreateConversationInProject: vi.fn(),
  };
}

describe("workspace header project crumb", () => {
  it("names a new chat without a project instead of a project called No project", () => {
    const callbacks = props({ name: "No project", path: "/data/scratch", workspaceKind: "scratch" });
    render(<WorkspaceHeader {...callbacks} />);
    const crumb = screen.getByRole("button", { name: "New chat without a project" });
    expect(crumb).not.toHaveAttribute("title");
    expect(hoverTooltipText(crumb)).toBe("New chat without a project");
    expect(screen.queryByRole("button", { name: "New chat in No project" })).not.toBeInTheDocument();
    fireEvent.click(crumb);
    expect(callbacks.onCreateConversationInProject).toHaveBeenCalledOnce();
  });

  it("keeps naming the project for project chats", () => {
    render(<WorkspaceHeader {...props({})} />);
    expect(hoverTooltipText(screen.getByRole("button", { name: "New chat in Studio" }))).toBe("New chat in Studio");
  });

  it("describes the title hint outside the heading text", () => {
    const callbacks = props({});
    const noop = vi.fn();
    render(
      <WorkspaceHeader
        {...callbacks}
        conversationMenu={{
          activeConversationId: callbacks.conversation!.id, detachedChatLimitReached: false, isDetached: false,
          runs: [], splitConversationIds: new Set(), onAcknowledgeRun: noop, onArchiveConversation: noop,
          onCloseConversationSplit: noop, onDeleteConversation: noop, onDismissRun: noop,
          onOpenConversationInSplit: noop, onOpenConversationInWindow: noop, onPinConversation: noop,
          onRestoreConversation: noop, onSettleConversation: noop, onSnoozeConversation: noop,
        }}
      />,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    const title = callbacks.conversation!.title;
    expect(heading).toHaveTextContent(new RegExp(`^${title}$`, "u"));
    expect(screen.getByRole("button", { name: title })).toHaveAccessibleDescription("Chat actions · double-click to rename");
  });
});

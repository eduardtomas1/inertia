import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { conversation } from "./composer-fixtures";

type HeaderProps = ComponentProps<typeof WorkspaceHeader>;

function props(): HeaderProps {
  return {
    project: {
      id: "11111111-1111-4111-8111-111111111111", name: "Studio", path: "/studio",
      normalizedPath: "/studio", repositoryIdentity: null, repositoryRoot: null,
      repositoryRelativePath: "", groupingMode: null, gitRepositoryLimit: 64,
      color: "#6366f1", status: "ready", createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
    conversation: conversation("33333333-3333-4333-8333-333333333333"), view: "workspace",
    sidebarCollapsed: false, gitStatus: null, branches: [],
    actions: [{ id: "check", label: "Check workspace", command: "node --version", preview: false }],
    busy: false,
    onOpenSidebar: vi.fn(), onOpenSettings: vi.fn(),
    onOpenFolder: vi.fn(), onRevealFolder: vi.fn(), onOpenFiles: vi.fn(),
    onRefreshBranches: vi.fn(), onSwitchBranch: vi.fn(),
    onCreateBranch: vi.fn(), onCreateConversationOnBranch: vi.fn(),
    onCreateConversationInWorktree: vi.fn(), onCreateConversationInIsolatedWorktree: vi.fn(),
    onCommit: vi.fn(), onOpenPullRequest: vi.fn(), onPull: vi.fn(), onPush: vi.fn(),
    onRunAction: vi.fn(),
  };
}

const gitStatus: NonNullable<HeaderProps["gitStatus"]> = {
  isRepository: true, root: "/studio", branch: "main", upstream: null,
  ahead: 0, behind: 0, hasRemote: false, files: [], insertions: 0, deletions: 0,
};

describe("workspace header project action ownership", () => {
  it("keeps the focused project action available when initial Git discovery completes", async () => {
    const callbacks = props();
    const view = render(<WorkspaceHeader {...callbacks} />);
    fireEvent.click(await screen.findByRole("button", { name: "Project action options" }));
    const action = await screen.findByRole("menuitem", { name: /Check workspace/u });
    await waitFor(() => expect(action).toHaveFocus());

    view.rerender(<WorkspaceHeader {...callbacks} gitStatus={gitStatus} />);

    expect(screen.getByRole("menu", { name: "Project actions" })).toBeInTheDocument();
    expect(action).toHaveFocus();
    expect(callbacks.onRunAction).not.toHaveBeenCalled();
    fireEvent.click(action);
    expect(callbacks.onRunAction).toHaveBeenCalledExactlyOnceWith(callbacks.actions[0]);
    expect(screen.queryByRole("menu", { name: "Project actions" })).not.toBeInTheDocument();
  });

  it.each(["project", "conversation"])("still dismisses project actions when the %s owner changes", async (owner) => {
    const callbacks = props();
    const view = render(<WorkspaceHeader {...callbacks} gitStatus={gitStatus} />);
    fireEvent.click(await screen.findByRole("button", { name: "Project action options" }));
    const action = await screen.findByRole("menuitem", { name: /Check workspace/u });
    await waitFor(() => expect(action).toHaveFocus());

    const nextId = "22222222-2222-4222-8222-222222222222";
    view.rerender(<WorkspaceHeader {...callbacks} gitStatus={gitStatus}
      project={owner === "project" ? { ...callbacks.project!, id: nextId } : callbacks.project}
      conversation={owner === "conversation" ? conversation(nextId) : callbacks.conversation} />);

    expect(screen.queryByRole("menu", { name: "Project actions" })).not.toBeInTheDocument();
    expect(callbacks.onRunAction).not.toHaveBeenCalled();
  });

  it("still dismisses Git actions when its Git root changes", async () => {
    const callbacks = props();
    const view = render(<WorkspaceHeader {...callbacks} gitStatus={gitStatus} />);
    fireEvent.click(await screen.findByRole("button", { name: "More Git actions" }));
    expect(await screen.findByRole("menu", { name: "Git actions" })).toBeInTheDocument();

    view.rerender(<WorkspaceHeader {...callbacks} gitStatus={{ ...gitStatus, root: "/other-checkout" }} />);

    expect(screen.queryByRole("menu", { name: "Git actions" })).not.toBeInTheDocument();
  });

  it("falls back to a header Branches menu without a checkout strip and dismisses it when the Git root changes", async () => {
    const callbacks = props();
    const view = render(<WorkspaceHeader {...callbacks} gitStatus={gitStatus} />);
    fireEvent.click(await screen.findByRole("button", { name: "More Git actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Switch branch/u }));
    expect(await screen.findByRole("menu", { name: "Branches" })).toBeInTheDocument();
    expect(callbacks.onRefreshBranches).toHaveBeenCalled();

    view.rerender(<WorkspaceHeader {...callbacks} gitStatus={{ ...gitStatus, root: "/other-checkout" }} />);

    await waitFor(() => expect(screen.queryByRole("menu", { name: "Branches" })).not.toBeInTheDocument());
  });
});

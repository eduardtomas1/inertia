import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { OpenInControl } from "../../src/renderer/src/components/workspace-header/OpenInControl";
import { ProjectActionsControl } from "../../src/renderer/src/components/workspace-header/ProjectActionsControl";
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
    onOpenSidebar: vi.fn(), onOpenSettings: vi.fn(), onCloseSettings: vi.fn(),
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

function ClickDuringCommit({ trigger }: { trigger: string }): null {
  useLayoutEffect(() => {
    screen.getByRole("button", { name: trigger }).click();
  }, [trigger]);
  return null;
}

describe("workspace header action menus first click", () => {
  it("opens the Project actions menu when the first click lands before mount effects run", async () => {
    render(
      <>
        <ProjectActionsControl
          presentation="toolbar"
          projectId="11111111-1111-4111-8111-111111111111"
          actions={[{ id: "check", label: "Check workspace", command: "node --version", preview: false }]}
          runs={null}
          onRunAction={vi.fn()}
        />
        <ClickDuringCommit trigger="Project action options" />
      </>,
    );

    expect(screen.getByRole("button", { name: "Project action options" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Project actions" })).toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: /Check workspace/u })).toBeInTheDocument();
  });

  it("opens the Open checkout menu when the first click lands before mount effects run", async () => {
    render(
      <>
        <OpenInControl
          presentation="toolbar"
          checkoutName="Studio"
          checkoutPath="/studio"
          filesAvailable
          onOpenFolder={vi.fn()}
          onRevealFolder={vi.fn()}
          onOpenFiles={vi.fn()}
        />
        <ClickDuringCommit trigger="Choose where to open" />
      </>,
    );

    expect(screen.getByRole("button", { name: "Choose where to open" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Open checkout" })).toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: /Folder/u })).toBeInTheDocument();
  });
});

describe("workspace header settings control", () => {
  it("offers Close settings with the same gear inside Settings", () => {
    const callbacks = props();
    render(<WorkspaceHeader {...callbacks} view="settings" />);
    expect(screen.queryByRole("button", { name: /^Settings$/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(callbacks.onCloseSettings).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSettings).not.toHaveBeenCalled();
  });
});

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

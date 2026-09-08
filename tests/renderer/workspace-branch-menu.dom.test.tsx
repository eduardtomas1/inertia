import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import WorkspaceBranchMenu from "../../src/renderer/src/components/WorkspaceBranchMenu";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import type { Project } from "../../src/shared/contracts";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111", name: "Inertia", path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia", repositoryIdentity: null, repositoryRoot: null,
  repositoryRelativePath: "", groupingMode: null, gitRepositoryLimit: 64, color: "#6366f1",
  status: "ready", createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
};
function props() {
  return {
    project, conversation: null, busy: false,
    gitStatus: { isRepository: true, root: project.path, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true, files: [], insertions: 0, deletions: 0 },
    branches: [
      { name: "main", current: true, remote: false, worktreePath: null },
      { name: "occupied", current: false, remote: false, worktreePath: null, checkedOut: true },
      { name: "origin/topic", current: false, remote: true, worktreePath: null },
    ],
    onClose: vi.fn(), onRefreshBranches: vi.fn(), onSwitchBranch: vi.fn(), onCreateBranch: vi.fn(),
    onCreateConversationInWorktree: vi.fn(), onCreateConversationOnBranch: vi.fn(), onCreateConversationInIsolatedWorktree: vi.fn(),
  };
}

describe("branch menu interaction", () => {
  it("navigates branch choices, skips occupied branches and scrolls keyboard focus into view", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<WorkspaceBranchMenu {...props()} />);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "main Current" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "origin/topic Track" })).toHaveFocus();
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
  });

  it("preserves text-editing keys in search and branch creation", () => {
    render(<WorkspaceBranchMenu {...props()} />);
    for (const input of [screen.getByRole("searchbox"), screen.getByRole("textbox", { name: "New branch name" })]) {
      input.focus();
      for (const key of ["Home", "End", "ArrowLeft", "ArrowRight"]) {
        expect(fireEvent.keyDown(input, { key })).toBe(true);
        expect(input).toHaveFocus();
      }
    }
  });

  it("keeps the search and failed checkout available for retry, then closes on success", async () => {
    const callbacks = props();
    callbacks.onSwitchBranch.mockRejectedValueOnce(new Error("Commit or stash local changes first.")).mockResolvedValueOnce(undefined);
    render(<WorkspaceBranchMenu {...callbacks} />);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "topic" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await screen.findByRole("alert");
    expect(search).toHaveValue("topic");
    expect(callbacks.onClose).not.toHaveBeenCalled();
    const target = screen.getByRole("menuitemradio", { name: "origin/topic Track" });
    expect(target).toBeEnabled();
    fireEvent.click(target);
    await waitFor(() => expect(callbacks.onClose).toHaveBeenCalledOnce());
    expect(callbacks.onSwitchBranch).toHaveBeenLastCalledWith("origin/topic", true);
  });

  it("selects the current branch without a mutation and ignores settlement after dismissal", async () => {
    const callbacks = props();
    let finish!: () => void;
    callbacks.onSwitchBranch.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { unmount } = render(<WorkspaceBranchMenu {...callbacks} />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "main Current" }));
    expect(callbacks.onSwitchBranch).not.toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    callbacks.onClose.mockClear();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "origin/topic Track" }));
    unmount();
    await act(async () => { finish(); await Promise.resolve(); });
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it("dismisses old checkout state on project navigation without letting late completion close the new menu", async () => {
    const callbacks = props();
    let finish!: () => void;
    callbacks.onSwitchBranch.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const header = (target: Project) => <WorkspaceHeader {...callbacks} project={target}
      view="workspace" activeTool={null} sidebarCollapsed={false} theme="dark" actions={[]}
      onOpenSidebar={vi.fn()} onToggleTools={vi.fn()} onOpenEnvironment={vi.fn()} onCycleTheme={vi.fn()}
      onOpenSettings={vi.fn()} onOpenConnectionsSettings={vi.fn()} onOpenProject={vi.fn()}
      onCommit={vi.fn()} onOpenPullRequest={vi.fn()} onPull={vi.fn()} onPush={vi.fn()} onRunAction={vi.fn()} />;
    const view = render(header(project));
    fireEvent.click(screen.getByRole("button", { name: /^main$/u }));
    const search = await screen.findByRole("searchbox");
    fireEvent.change(search, { target: { value: "topic" } });
    fireEvent.keyDown(search, { key: "Enter" });
    view.rerender(header({ ...project, id: "22222222-2222-4222-8222-222222222222" }));
    expect(screen.queryByRole("menu", { name: "Branches" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^main$/u }));
    expect(await screen.findByRole("searchbox")).toHaveValue("");
    await act(async () => { finish(); await Promise.resolve(); });
    expect(screen.getByRole("menu", { name: "Branches" })).toBeInTheDocument();
  });
});

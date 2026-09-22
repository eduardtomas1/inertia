import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import type {
  GitStatusSnapshot,
  Project,
} from "../../src/shared/contracts";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: "",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#6366f1",
  status: "ready",
  createdAt: "2026-07-29T10:00:00.000Z",
  updatedAt: "2026-07-29T10:00:00.000Z",
};

const modified = {
  path: "src/app.ts",
  status: "modified",
  insertions: 2,
  deletions: 1,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
};

function status(
  available: boolean,
  overrides: Partial<GitStatusSnapshot> = {},
): GitStatusSnapshot {
  return {
    isRepository: true,
    root: "/workspace/inertia",
    branch: "feature/pr",
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: true,
    pullRequest: {
      available,
      remoteName: "origin",
      forge: available ? "github" : null,
      unavailableReason: available ? null : "unsupported-forge",
    },
    files: [],
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

type HeaderProps = ComponentProps<typeof WorkspaceHeader>;

async function renderHeader(
  gitStatus: GitStatusSnapshot,
  overrides: Partial<HeaderProps> = {},
): Promise<HeaderProps> {
  const props: HeaderProps = {
    project,
    conversation: null,
    view: "workspace",
    sidebarCollapsed: false,
    gitStatus,
    branches: [],
    actions: [],
    busy: false,
    onOpenSidebar: vi.fn(),
    onOpenSettings: vi.fn(),
   
    onOpenFolder: vi.fn(),
    onRevealFolder: vi.fn(),
    onOpenFiles: vi.fn(),
    onRefreshBranches: vi.fn(),
    onSwitchBranch: vi.fn(),
    onCreateBranch: vi.fn(),
    onCreateConversationOnBranch: vi.fn(),
    onCreateConversationInWorktree: vi.fn(),
    onCreateConversationInIsolatedWorktree: vi.fn(),
    onCommit: vi.fn(),
    onOpenPullRequest: vi.fn(),
    onPushAndCreatePullRequest: vi.fn(),
    onFetch: vi.fn(),
    onPull: vi.fn(),
    onPush: vi.fn(),
    onRefreshGitStatus: vi.fn(),
    onRunAction: vi.fn(),
    ...overrides,
  };
  render(<WorkspaceHeader {...props} />);
  await screen.findByRole("group", { name: "Open checkout" });
  return props;
}

describe("WorkspaceHeader Git split button", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("opens pull requests from the complete Git menu and refreshes status on open", async () => {
    const props = await renderHeader(status(true, { upstream: "origin/feature/pr" }));

    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    expect(props.onRefreshGitStatus).toHaveBeenCalledOnce();
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Pull request/u }));
    expect(props.onOpenPullRequest).toHaveBeenCalledOnce();
  });

  it("derives Commit from local changes and keeps the complete Git menu", async () => {
    const props = await renderHeader(status(true, {
      upstream: "origin/feature/pr",
      files: [modified],
      insertions: 2,
      deletions: 1,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(props.onCommit).toHaveBeenCalledOnce();

    const more = screen.getByRole("button", { name: "More Git actions" });
    fireEvent.click(more);
    expect(await screen.findByRole("menu", { name: "Git actions" })).toBeInTheDocument();
    const pullReason = screen.getByText("Commit or stash local changes before pulling.");
    expect(pullReason.closest("button")).toHaveAttribute("aria-disabled", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Git actions" })).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("promotes Pull when a clean checkout is behind", async () => {
    const props = await renderHeader(status(true, { upstream: "origin/feature/pr", behind: 2 }));

    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(props.onPull).toHaveBeenCalledOnce();
  });

  it("pushes and opens a pull request from a clean feature branch that is ahead", async () => {
    const props = await renderHeader(status(true, { upstream: "origin/feature/pr", ahead: 2 }));

    fireEvent.click(screen.getByRole("button", { name: "Push & create PR" }));
    expect(props.onPushAndCreatePullRequest).toHaveBeenCalledOnce();
    expect(props.onPush).not.toHaveBeenCalled();
  });

  it("pushes plainly when the forge cannot open pull requests", async () => {
    const props = await renderHeader(status(false, { upstream: "origin/feature/pr", ahead: 1 }));

    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(props.onPush).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Pull request" })).not.toBeInTheDocument();
  });

  it("keeps a disabled primary hoverable and explains why", async () => {
    const props = await renderHeader(status(true, { upstream: "origin/feature/pr" }));

    const primary = screen.getByRole("button", { name: "Commit" });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(primary).not.toBeDisabled();
    expect(primary).toHaveAttribute("title", "Branch is up to date. Nothing to commit or push.");
    expect(primary).toHaveAccessibleDescription("Branch is up to date. Nothing to commit or push.");
    fireEvent.click(primary);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("offers Create branch on a detached HEAD", async () => {
    const props = await renderHeader(status(true, { branch: null }));

    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    expect(props.onRefreshBranches).toHaveBeenCalled();
  });

  it("moves focus through all Git explanations and restores the trigger on Escape", async () => {
    await renderHeader(status(true, { upstream: "origin/feature/pr", behind: 2 }));

    const trigger = screen.getByRole("button", { name: "More Git actions" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Git actions" });
    const commit = screen.getByRole("menuitem", { name: /^Commit/u });
    const push = screen.getByRole("menuitem", { name: /^Publish branch|^Push/u });
    const branches = screen.getByRole("menuitem", { name: /^Switch branch/u });
    await waitFor(() => expect(commit).toHaveFocus());

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(push).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /^Pull request/u })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /^Pull 2/u })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(commit).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(branches).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Git actions" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes the Git menu before a sibling header action runs", async () => {
    await renderHeader(status(true, { upstream: "origin/feature/pr" }));

    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    expect(await screen.findByRole("menu", { name: "Git actions" })).toBeInTheDocument();
    const open = screen.getByRole("button", { name: /^Open Inertia in/u });
    fireEvent.pointerDown(open);
    fireEvent.click(open);

    expect(screen.queryByRole("menu", { name: "Git actions" })).not.toBeInTheDocument();
  });

  it("hides Git entirely outside a repository", async () => {
    await renderHeader(status(true, { isRepository: false }));

    expect(screen.queryByRole("group", { name: "Git actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Open checkout" })).toBeInTheDocument();
  });

  it("focuses and explains an all-disabled Git menu, guards activation, and closes on focus-out", async () => {
    const props = await renderHeader(status(false, {
      branch: null,
      upstream: null,
      hasRemote: false,
      pullRequest: {
        available: false,
        remoteName: null,
        forge: null,
        unavailableReason: "no-remotes",
      },
    }));

    const trigger = screen.getByRole("button", { name: "More Git actions" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Git actions" });
    const commit = screen.getByRole("menuitem", { name: /^Commit/u });
    await waitFor(() => expect(commit).toHaveFocus());
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).not.toBeDisabled();
    expect(screen.getByText(/^Detached HEAD: create and check out a branch/u)).toBeInTheDocument();

    fireEvent.click(commit);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(menu).toBeInTheDocument();

    screen.getByRole("button", { name: /^Open Inertia in/u }).focus();
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Git actions" }))
      .not.toBeInTheDocument());
  });
});

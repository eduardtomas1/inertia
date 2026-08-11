import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import type { EnvironmentSummarySnapshot } from "../../src/renderer/src/utils/environmentSummary";
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

const summary: EnvironmentSummarySnapshot = {
  projectName: "Inertia",
  runtime: { status: "online", label: "Ready" },
  changes: null,
  branch: { label: "Branch", value: "feature/pr" },
  checks: [],
  subagents: [],
  attachments: [],
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

function renderHeader(
  gitStatus: GitStatusSnapshot,
  onOpenPullRequest = vi.fn(),
  onPush = vi.fn(),
  activeTool: "changes" | null = null,
  onCommit = vi.fn(),
): void {
  render(
    <WorkspaceHeader
      project={project}
      conversation={null}
      view="workspace"
      activeTool={activeTool}
      sidebarCollapsed={false}
      theme="dark"
      gitStatus={gitStatus}
      branches={[]}
      actions={[]}
      busy={false}
      environmentSummary={summary}
      environmentOpen={false}
      onOpenSidebar={vi.fn()}
      onToggleTools={vi.fn()}
      onSetEnvironmentOpen={vi.fn()}
      onCycleTheme={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenConnectionsSettings={vi.fn()}
      onOpenProject={vi.fn()}
      onRefreshBranches={vi.fn()}
      onSwitchBranch={vi.fn()}
      onCreateBranch={vi.fn()}
      onCreateConversationOnBranch={vi.fn()}
      onCreateConversationInWorktree={vi.fn()}
      onCreateConversationInIsolatedWorktree={vi.fn()}
      onCommit={onCommit}
      onOpenPullRequest={onOpenPullRequest}
      onPull={vi.fn()}
      onPush={onPush}
      onRunAction={vi.fn()}
      onStopRun={vi.fn()}
    />,
  );
}

describe("WorkspaceHeader Git pull request availability", () => {
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

  it("shows and invokes the action for a supported selected remote", async () => {
    const onOpenPullRequest = vi.fn();
    renderHeader(status(true, {
      upstream: "origin/feature/pr",
    }), onOpenPullRequest);

    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Pull request/u }));
    expect(onOpenPullRequest).toHaveBeenCalledOnce();
  });

  it("does not advertise a PR action merely because some remote exists", () => {
    renderHeader(status(false));

    expect(screen.queryByRole("button", { name: "Pull request" }))
      .not.toBeInTheDocument();
  });

  it("omits Runs and keeps the remaining utility actions adjacent", () => {
    renderHeader(status(false));

    expect(screen.queryByRole("button", { name: /^Open runs/u }))
      .not.toBeInTheDocument();
    const actions = screen.getAllByRole("button");
    const environment = actions.findIndex((button) =>
      button.getAttribute("aria-label") === "Open environment summary");
    expect(actions[environment + 1]).toHaveAccessibleName(
      "Change theme (current: dark)",
    );
    expect(actions[environment + 2]).toHaveAccessibleName(
      "Open workspace tools",
    );
  });

  it("uses one contextual primary action and keeps the complete Git menu", async () => {
    const onCommit = vi.fn();
    const current = status(true, {
      upstream: "origin/feature/pr",
      files: [{
        path: "src/app.ts",
        status: "modified",
        insertions: 2,
        deletions: 1,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: ".",
        worktreeStatus: "M",
      }],
      insertions: 2,
      deletions: 1,
    });
    render(
      <WorkspaceHeader
        project={project}
        conversation={null}
        view="workspace"
        activeTool={null}
        sidebarCollapsed={false}
        theme="dark"
        gitStatus={current}
        branches={[]}
        actions={[]}
        busy={false}
        environmentSummary={summary}
        environmentOpen={false}
        onOpenSidebar={vi.fn()}
        onToggleTools={vi.fn()}
        onSetEnvironmentOpen={vi.fn()}
        onCycleTheme={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenConnectionsSettings={vi.fn()}
        onOpenProject={vi.fn()}
        onRefreshBranches={vi.fn()}
        onSwitchBranch={vi.fn()}
        onCreateBranch={vi.fn()}
        onCreateConversationOnBranch={vi.fn()}
        onCreateConversationInWorktree={vi.fn()}
        onCreateConversationInIsolatedWorktree={vi.fn()}
        onCommit={onCommit}
        onOpenPullRequest={vi.fn()}
        onPull={vi.fn()}
        onPush={vi.fn()}
        onRunAction={vi.fn()}
        onStopRun={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(onCommit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Pull request" }))
      .not.toBeInTheDocument();

    const more = screen.getByRole("button", { name: "More Git actions" });
    fireEvent.click(more);
    expect(await screen.findByRole("menu", { name: "Git actions" })).toBeInTheDocument();
    const pullReason = screen.getByText(
      "Commit or discard local changes before pulling.",
    );
    expect(pullReason.closest("button")).toHaveAttribute("aria-disabled", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Git actions" }))
      .not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it("promotes pull when a clean checkout is behind", () => {
    const onPull = vi.fn();
    render(
      <WorkspaceHeader
        project={project}
        conversation={null}
        view="workspace"
        activeTool={null}
        sidebarCollapsed={false}
        theme="dark"
        gitStatus={status(true, { upstream: "origin/feature/pr", behind: 2 })}
        branches={[]}
        actions={[]}
        busy={false}
        environmentSummary={summary}
        environmentOpen={false}
        onOpenSidebar={vi.fn()}
        onToggleTools={vi.fn()}
        onSetEnvironmentOpen={vi.fn()}
        onCycleTheme={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenConnectionsSettings={vi.fn()}
        onOpenProject={vi.fn()}
        onRefreshBranches={vi.fn()}
        onSwitchBranch={vi.fn()}
        onCreateBranch={vi.fn()}
        onCreateConversationOnBranch={vi.fn()}
        onCreateConversationInWorktree={vi.fn()}
        onCreateConversationInIsolatedWorktree={vi.fn()}
        onCommit={vi.fn()}
        onOpenPullRequest={vi.fn()}
        onPull={onPull}
        onPush={vi.fn()}
        onRunAction={vi.fn()}
        onStopRun={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pull 2" }));
    expect(onPull).toHaveBeenCalledOnce();
  });

  it("routes the clean-ahead primary action to push rather than pull request", () => {
    const onOpenPullRequest = vi.fn();
    const onPush = vi.fn();
    renderHeader(status(true, {
      upstream: "origin/feature/pr",
      ahead: 2,
    }), onOpenPullRequest, onPush);

    fireEvent.click(screen.getByRole("button", { name: "Push 2" }));

    expect(onPush).toHaveBeenCalledOnce();
    expect(onOpenPullRequest).not.toHaveBeenCalled();
  });

  it("moves focus through all Git explanations and restores the trigger on Escape", async () => {
    renderHeader(status(true, {
      upstream: "origin/feature/pr",
      behind: 2,
    }));

    const trigger = screen.getByRole("button", { name: "More Git actions" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Git actions" });
    const commit = screen.getByRole("menuitem", { name: /^Commit/u });
    const pull = screen.getByRole("menuitem", { name: /^Pull 2/u });
    const pullRequest = screen.getByRole("menuitem", { name: /^Pull request/u });
    await waitFor(() => expect(commit).toHaveFocus());

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(pull).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(commit).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(pullRequest).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Git actions" }))
      .not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes the Git menu before a sibling header action runs", async () => {
    renderHeader(status(true, { upstream: "origin/feature/pr" }));

    fireEvent.click(screen.getByRole("button", { name: "More Git actions" }));
    expect(await screen.findByRole("menu", { name: "Git actions" })).toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerDown(open);
    fireEvent.click(open);

    expect(screen.queryByRole("menu", { name: "Git actions" }))
      .not.toBeInTheDocument();
  });

  it("lets the Changes panel own repository-scoped actions without a duplicate root action", () => {
    renderHeader(status(true, {
      upstream: "origin/feature/pr",
      ahead: 1,
    }), vi.fn(), vi.fn(), "changes");

    expect(screen.queryByRole("button", { name: "Push 1" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More Git actions" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "feature/pr" }))
      .toBeInTheDocument();
  });

  it("focuses and explains an all-disabled Git menu, guards activation, and closes on focus-out", async () => {
    const onCommit = vi.fn();
    renderHeader(status(false, {
      branch: null,
      upstream: null,
      hasRemote: false,
      pullRequest: {
        available: false,
        remoteName: null,
        forge: null,
        unavailableReason: "no-remotes",
      },
    }), vi.fn(), vi.fn(), null, onCommit);

    const trigger = screen.getByRole("button", { name: "More Git actions" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Git actions" });
    const commit = screen.getByRole("menuitem", { name: /^Commit/u });
    await waitFor(() => expect(commit).toHaveFocus());
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).not.toBeDisabled();

    fireEvent.click(commit);
    expect(onCommit).not.toHaveBeenCalled();
    expect(menu).toBeInTheDocument();

    screen.getByRole("button", { name: "Open" }).focus();
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Git actions" }))
      .not.toBeInTheDocument());
  });
});

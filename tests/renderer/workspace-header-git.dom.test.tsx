import { fireEvent, render, screen } from "@testing-library/react";
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

function status(available: boolean): GitStatusSnapshot {
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
  };
}

function renderHeader(
  gitStatus: GitStatusSnapshot,
  onOpenPullRequest = vi.fn(),
): void {
  render(
    <WorkspaceHeader
      project={project}
      conversation={null}
      view="workspace"
      activeTool={null}
      sidebarCollapsed={false}
      theme="dark"
      gitStatus={gitStatus}
      branches={[]}
      actions={[]}
      busy={false}
      activityOpen={false}
      activeRunCount={0}
      attentionRunCount={0}
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
      onOpenPullRequest={onOpenPullRequest}
      onPull={vi.fn()}
      onRunAction={vi.fn()}
      onToggleActivity={vi.fn()}
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

  it("shows and invokes the action for a supported selected remote", () => {
    const onOpenPullRequest = vi.fn();
    renderHeader(status(true), onOpenPullRequest);

    fireEvent.click(screen.getByRole("button", { name: "Pull request" }));
    expect(onOpenPullRequest).toHaveBeenCalledOnce();
  });

  it("does not advertise a PR action merely because some remote exists", () => {
    renderHeader(status(false));

    expect(screen.queryByRole("button", { name: "Pull request" }))
      .not.toBeInTheDocument();
  });
});

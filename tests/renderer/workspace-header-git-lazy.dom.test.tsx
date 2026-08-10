import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentSummarySnapshot } from "../../src/renderer/src/utils/environmentSummary";
import type { GitStatusSnapshot, Project } from "../../src/shared/contracts";

const deferredMenu = vi.hoisted(() => {
  let release!: () => void;
  return {
    pending: new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
  };
});

vi.mock("../../src/renderer/src/components/WorkspaceGitActionMenu", async () => {
  await deferredMenu.pending;
  return {
    default: () => (
      <div role="menu" aria-label="Git actions">
        <button type="button" role="menuitem" autoFocus>Commit</button>
      </div>
    ),
  };
});

import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";

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

const gitStatus: GitStatusSnapshot = {
  isRepository: true,
  root: "/workspace/inertia",
  branch: "feature/pr",
  upstream: "origin/feature/pr",
  ahead: 0,
  behind: 0,
  hasRemote: true,
  pullRequest: {
    available: true,
    remoteName: "origin",
    forge: "github",
    unavailableReason: null,
  },
  files: [],
  insertions: 0,
  deletions: 0,
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

describe("WorkspaceHeader deferred Git menu", () => {
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

  it("does not reclaim focus after the cold menu resolves once focus has left", async () => {
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
        onOpenPullRequest={vi.fn()}
        onPull={vi.fn()}
        onPush={vi.fn()}
        onRunAction={vi.fn()}
        onToggleActivity={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "More Git actions" });
    fireEvent.click(trigger);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Git actions");

    const openProject = screen.getByRole("button", { name: "Open" });
    openProject.focus();
    deferredMenu.release();

    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("menu", { name: "Git actions" })).not.toBeInTheDocument();
    expect(openProject).toHaveFocus();
  });
});

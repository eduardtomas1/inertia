import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  loadCommitDialog: vi.fn(),
  prefetchWorkspaceTool: vi.fn(),
}));

import { EnvironmentPanel } from "../../src/renderer/src/components/EnvironmentPanel";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { WorkspacePanel } from "../../src/renderer/src/components/WorkspacePanel";
import type { EnvironmentSummarySnapshot } from "../../src/renderer/src/utils/environmentSummary";
import type { Conversation, Project } from "../../src/shared/contracts";

type EnvironmentRun = EnvironmentSummarySnapshot["checks"][number];

function environmentRun(
  overrides: Partial<EnvironmentRun> = {},
): EnvironmentRun {
  return {
    id: "check",
    kind: "check",
    projectId: "project-1",
    conversationId: null,
    label: "Check",
    status: "running",
    canStop: false,
    port: null,
    contextLabel: null,
    canOpenPreview: false,
    canAcknowledge: false,
    canDismiss: false,
    ...overrides,
  };
}

const summary: EnvironmentSummarySnapshot = {
  projectName: "Inertia",
  workspace: {
    label: "Worktree",
    value: "environment-panel",
    path: "/workspace/worktrees/environment-panel",
  },
  openTarget: {
    name: "inertia",
    path: "/workspace/worktrees/environment-panel",
  },
  runtime: { status: "online" },
  changes: {
    files: 2,
    insertions: 9,
    deletions: 4,
    repositories: 2,
  },
  gitState: "ready",
  gitNotice: null,
  branch: { label: "Branches", value: "2 repositories" },
  repositories: [{
    repositoryPath: ".",
    state: "ready",
    error: null,
    branch: "codex/summary",
    upstream: "origin/codex/summary",
    ahead: 1,
    behind: 0,
    hasRemote: true,
    pullRequest: {
      available: true,
      remoteName: "origin",
      forge: "github",
      unavailableReason: null,
    },
    files: 2,
    insertions: 9,
    deletions: 4,
    clean: false,
    truncated: false,
    authorityRef: "root-authority",
    commitAction: {
      id: "commit",
      label: "Commit",
      detail: "Review and commit 2 changed files.",
      disabled: false,
    },
    pushAction: {
      id: "push",
      label: "Push 1",
      detail: "Commit local changes before pushing.",
      disabled: true,
    },
  }, {
    repositoryPath: "packages/docs",
    state: "ready",
    error: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    pullRequest: undefined,
    files: 0,
    insertions: 0,
    deletions: 0,
    clean: true,
    truncated: false,
    authorityRef: "docs-authority",
    commitAction: {
      id: "commit",
      label: "Commit",
      detail: "There are no local changes to commit.",
      disabled: true,
    },
    pushAction: {
      id: "push",
      label: "Push",
      detail: "Check out a local branch first.",
      disabled: true,
    },
  }],
  checks: [],
  localServers: [{
    ...environmentRun({
      id: "preview-service",
      kind: "service",
      conversationId: "conversation-2",
      label: "Docs preview",
      canStop: true,
      port: 4173,
      contextLabel: "Docs chat (docs/preview) · npm run preview",
      canOpenPreview: true,
    }),
    url: "http://127.0.0.1:4173",
  }],
  usage: {
    providerId: "codex",
    providerLabel: "Codex",
    context: {
      quality: "current",
      remainingPercent: 72,
      valueLabel: "72%",
      accessibleLabel: "Context 72% remaining",
      updatedAt: "2026-08-12T10:00:00.000Z",
    },
    quota: {
      freshness: "current",
      source: "selected-route",
      updatedAt: "2026-08-12T10:00:00.000Z",
      limits: [{
        id: "five-hour",
        label: "Five-hour limit",
        remainingPercent: 64,
        windowMinutes: 300,
        resetsAt: "2026-08-12T12:00:00.000Z",
      }],
    },
  },
  subagents: [{
    id: "trace-1",
    providerName: "Review",
    providerRole: "reviewer",
    status: "running",
  }],
  attachments: [
    { id: "attachment-1", name: "reference.png", mimeType: "image/png" },
    { id: "attachment-2", name: "requirements.pdf", mimeType: "application/pdf" },
    {
      id: "attachment-3",
      name: "forecast.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ],
};

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

function HeaderHarness({
  activeProject = null,
  conversation = null,
  activeTool = null,
  workspaceToolsUnavailableReason = null,
  onOpenSettings = vi.fn(),
  onOpenConnectionsSettings = vi.fn(),
  onOpenEnvironment = vi.fn(),
  onOpenBrowser,
}: {
  activeProject?: Project | null;
  conversation?: Conversation | null;
  activeTool?: "environment" | "preview" | null;
  workspaceToolsUnavailableReason?: string | null;
  onOpenSettings?: () => void;
  onOpenConnectionsSettings?: () => void;
  onOpenEnvironment?: () => void;
  onOpenBrowser?: () => void;
}): React.JSX.Element {
  return (
    <WorkspaceHeader
      project={activeProject}
      conversation={conversation}
      view="workspace"
      activeTool={activeTool}
      sidebarCollapsed={false}
      theme="dark"
      gitStatus={null}
      branches={[]}
      actions={[]}
      busy={false}
      onOpenSidebar={vi.fn()}
      onToggleTools={vi.fn()}
      workspaceToolsUnavailableReason={workspaceToolsUnavailableReason}
      onOpenEnvironment={onOpenEnvironment}
      onOpenBrowser={onOpenBrowser}
      onCycleTheme={vi.fn()}
      onOpenSettings={onOpenSettings}
      onOpenConnectionsSettings={onOpenConnectionsSettings}
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
    />
  );
}

const panelActions = () => ({
  onOpenChanges: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenProject: vi.fn(),
  onRevealProject: vi.fn(),
  onRetryGit: vi.fn(),
  onRefreshUsage: vi.fn(),
  onStopRun: vi.fn(),
  onOpenRunPreview: vi.fn(),
  onAcknowledgeRun: vi.fn(),
  onDismissRun: vi.fn(),
});

function EnvironmentFocusHarness(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<"environment" | "changes" | "files">(
    "environment",
  );
  return (
    <WorkspacePanel
      activeTab={activeTab}
      onTabChange={(tab) => {
        if (tab === "environment" || tab === "changes" || tab === "files") {
          setActiveTab(tab);
        }
      }}
      tabs={["environment", "changes", "files"]}
    >
      {activeTab === "environment" ? (
        <EnvironmentPanel
          summary={summary}
          workspaceToolsAvailable
          {...panelActions()}
          onOpenChanges={() => setActiveTab("changes")}
          onOpenFiles={() => setActiveTab("files")}
        />
      ) : <p>{activeTab}</p>}
    </WorkspacePanel>
  );
}

describe("Environment panel", () => {
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

  it("renders the compact truthful hierarchy and repository-scoped actions", () => {
    const actions = panelActions();
    render(<EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />);

    const panel = screen.getByLabelText("Environment details");
    expect(within(panel).getByLabelText("9 insertions and 4 deletions")).toBeVisible();
    expect(within(panel).getByText("Worktree")).toBeVisible();
    expect(within(panel).getByText("2 repositories")).toBeVisible();
    expect(within(panel).getByText("Local Servers")).toBeVisible();
    expect(within(panel).getByText("Usage")).toBeVisible();
    expect(within(panel).getByRole("heading", { name: "Repository" })).toBeVisible();
    expect(within(panel).getByRole("heading", { name: "Editor" })).toBeVisible();
    expect(within(panel).queryByText("Ready", { exact: true })).not.toBeInTheDocument();
    expect(within(panel).queryByText("Recap", { exact: true })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByText("Commit and Push").closest("summary")!);
    fireEvent.click(within(panel).getAllByRole("button", { name: "Commit" })
      .find((button) => !button.hasAttribute("disabled"))!);
    expect(actions.onOpenChanges).toHaveBeenCalledWith(".", "commit");
    expect(within(panel).getByRole("button", { name: "Push 1" })).toBeDisabled();

    fireEvent.click(within(panel).getByText("Local Servers").closest("summary")!);
    expect(within(panel).getByText("http://127.0.0.1:4173 · Docs chat (docs/preview) · npm run preview")).toBeVisible();
    fireEvent.click(within(panel).getByRole("button", {
      name: /Open preview for Docs preview/u,
    }));
    expect(actions.onOpenRunPreview).toHaveBeenCalledWith(summary.localServers[0]);

    fireEvent.click(within(panel).getByText("Usage").closest("summary")!);
    expect(within(panel).getByText("Context window")).toBeVisible();
    expect(within(panel).getByText("64% left")).toBeVisible();
    expect(within(panel).getByText("Current")).toBeVisible();
    expect(within(panel).getByText("reference.png")).toBeVisible();
    expect(within(panel).getByText("requirements.pdf")).toBeVisible();
    expect(within(panel).getByText("forecast.xlsx")).toBeVisible();
    expect(panel.querySelector(".lucide-file-spreadsheet")).not.toBeNull();
  });

  it("does not offer repository mutations without scoped Git authority", () => {
    const actions = panelActions();
    const repository = {
      ...summary.repositories[0]!,
      authorityRef: null,
      commitAction: {
        ...summary.repositories[0]!.commitAction!,
        disabled: true,
        detail: "Scoped Git access is unavailable. Refresh the workspace before changing this repository.",
      },
      pushAction: {
        ...summary.repositories[0]!.pushAction!,
        disabled: true,
        detail: "Scoped Git access is unavailable. Refresh the workspace before changing this repository.",
      },
    };
    render(
      <EnvironmentPanel
        summary={{ ...summary, repositories: [repository] }}
        workspaceToolsAvailable
        {...actions}
      />,
    );

    fireEvent.click(screen.getByText("Commit and Push").closest("summary")!);
    const commit = screen.getByRole("button", { name: "Commit" });
    const push = screen.getByRole("button", { name: "Push 1" });
    expect(commit).toBeDisabled();
    expect(push).toBeDisabled();
    expect(commit).toHaveAttribute("title", expect.stringContaining("Scoped Git access is unavailable"));
    expect(push).toHaveAttribute("title", expect.stringContaining("Scoped Git access is unavailable"));
    fireEvent.click(commit);
    fireEvent.click(push);
    expect(actions.onOpenChanges).not.toHaveBeenCalled();
  });

  it("routes the header Environment control and reflects its active state", () => {
    const onOpenEnvironment = vi.fn();
    const view = render(
      <HeaderHarness activeProject={project} onOpenEnvironment={onOpenEnvironment} />,
    );
    const trigger = screen.getByRole("button", { name: "Open Environment" });
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(trigger);
    expect(onOpenEnvironment).toHaveBeenCalledOnce();

    view.rerender(
      <HeaderHarness activeProject={project} activeTool="environment" />,
    );
    expect(screen.getByRole("button", { name: "Open Environment" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("opens Browser directly for the active chat and reflects its active state", () => {
    const onOpenBrowser = vi.fn();
    const conversation = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Browser chat",
      worktreePath: null,
    } as Conversation;
    const view = render(
      <HeaderHarness
        activeProject={project}
        conversation={conversation}
        onOpenBrowser={onOpenBrowser}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Open Browser" });
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(trigger);
    expect(onOpenBrowser).toHaveBeenCalledOnce();

    view.rerender(
      <HeaderHarness
        activeProject={project}
        conversation={conversation}
        activeTool="preview"
        onOpenBrowser={onOpenBrowser}
      />,
    );
    expect(screen.getByRole("button", { name: "Open Browser" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("does not offer Environment before a task has a project", () => {
    render(<HeaderHarness />);
    expect(screen.queryByRole("button", { name: "Open Environment" }))
      .not.toBeInTheDocument();
  });

  it("distinguishes clean, loading, unknown, unavailable, and failed Git states", () => {
    const actions = panelActions();
    const view = render(
      <EnvironmentPanel
        summary={{ ...summary, gitState: "loading" }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("button", { name: "Changes Checking…" })).toBeDisabled();
    expect(screen.getByText("Checking branch…")).toBeVisible();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          changes: { ...summary.changes!, files: 0, insertions: 0, deletions: 0 },
          gitState: "ready",
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("button", { name: "Changes Clean" })).toBeEnabled();

    for (const [gitState, label] of [
      ["unknown", "Repository not checked"],
      ["unavailable", "No Git repository"],
    ] as const) {
      view.rerender(
        <EnvironmentPanel
          summary={{ ...summary, branch: null, changes: null, gitState }}
          workspaceToolsAvailable
          {...actions}
        />,
      );
      expect(screen.getByText(label)).toBeVisible();
    }

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          changes: null,
          gitState: "error",
          gitNotice: "Permission denied.",
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("button", { name: "Changes Unavailable" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(actions.onRetryGit).toHaveBeenCalledOnce();
  });

  it("promotes runtime status only when attention is required", () => {
    const actions = panelActions();
    const view = render(
      <EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />,
    );
    expect(screen.queryByText(/workspace runtime/iu)).not.toBeInTheDocument();

    view.rerender(
      <EnvironmentPanel
        summary={{ ...summary, runtime: { status: "connecting" } }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to workspace");

    view.rerender(
      <EnvironmentPanel
        summary={{ ...summary, runtime: { status: "offline" } }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Workspace runtime unavailable");
  });

  it("shows current, stale, refreshing, and unavailable Usage without inventing quota", () => {
    const actions = panelActions();
    const view = render(
      <EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />,
    );
    const usage = () => screen.getByText("Usage").closest("details")!;
    const openUsage = () => {
      if (!usage().hasAttribute("open")) {
        fireEvent.click(usage().querySelector("summary")!);
      }
      return usage();
    };
    openUsage();
    expect(within(usage()).getByText("Current")).toBeVisible();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          usage: {
            ...summary.usage!,
            context: {
              ...summary.usage!.context,
              quality: "stale",
              valueLabel: "72% · stale",
              accessibleLabel: "Context 72% remaining, stale",
            },
            quota: {
              ...summary.usage!.quota,
              freshness: "stale",
              limits: [],
            },
          },
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(within(openUsage()).getByText("Stale")).toBeVisible();
    fireEvent.click(within(openUsage()).getByRole("button", { name: "Refresh usage" }));
    expect(actions.onRefreshUsage).toHaveBeenCalledOnce();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          usage: {
            ...summary.usage!,
            context: {
              quality: "unavailable",
              remainingPercent: null,
              valueLabel: "Unavailable",
              accessibleLabel: "Context usage unavailable",
              updatedAt: null,
            },
            quota: {
              ...summary.usage!.quota,
              freshness: "refreshing",
              limits: [],
            },
          },
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(within(openUsage()).getAllByText("Refreshing").length).toBeGreaterThan(0);
    expect(within(openUsage()).getByRole("button", { name: "Refreshing" })).toBeDisabled();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          usage: {
            ...summary.usage!,
            quota: {
              ...summary.usage!.quota,
              freshness: "unavailable",
              source: "isolated",
              limits: [],
            },
          },
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(within(openUsage()).getByText("Unavailable for this backend"))
      .toBeVisible();
    expect(within(openUsage()).queryByRole("button", { name: "Refresh usage" }))
      .not.toBeInTheDocument();

    view.rerender(
      <EnvironmentPanel
        summary={{ ...summary, usage: null }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(within(openUsage()).getByText(/Usage is unavailable/iu)).toBeVisible();
  });

  it("shows only validated live servers and a truthful empty disclosure", () => {
    const actions = panelActions();
    render(
      <EnvironmentPanel
        summary={{ ...summary, localServers: [] }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    const localServers = screen.getByText("Local Servers").closest("details")!;
    expect(localServers.querySelector("summary")).toHaveTextContent("0");
    fireEvent.click(localServers.querySelector("summary")!);
    expect(within(localServers).getByText("No validated local service ports are active."))
      .toBeVisible();
  });

  it("moves keyboard focus to the selected workspace tool", async () => {
    const user = userEvent.setup();
    render(<EnvironmentFocusHarness />);
    for (const scenario of [
      { action: /Changes/u, tab: "Changes" },
      { action: "Editor view", tab: "Files" },
    ]) {
      if (scenario.tab === "Files") {
        await user.click(screen.getByRole("tab", { name: "Environment" }));
      }
      const action = within(screen.getByLabelText("Environment details"))
        .getByRole("button", { name: scenario.action });
      action.focus();
      await user.keyboard("{Enter}");
      const destination = screen.getByRole("tab", { name: scenario.tab });
      expect(destination).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(destination).toHaveFocus());
    }
  });

  it("keeps section labelling unique across split Environment panels", () => {
    const actions = panelActions();
    const view = render(
      <>
        <EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />
        <EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />
      </>,
    );
    const labels = [...view.container.querySelectorAll<HTMLElement>(
      ".environment-panel [aria-labelledby]",
    )].map((element) => element.getAttribute("aria-labelledby"));
    expect(labels).not.toContain(null);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(document.getElementById(label!)).not.toBeNull();
  });

  it("preserves all run controls and sibling owner context", () => {
    const actions = panelActions();
    const failed = environmentRun({
      id: "failed-check",
      conversationId: "conversation-2",
      label: "Typecheck",
      status: "failed",
      contextLabel: "Release chat (codex/release)",
      canAcknowledge: true,
      canDismiss: true,
    });
    render(
      <EnvironmentPanel
        summary={{ ...summary, checks: [failed] }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    fireEvent.click(screen.getByText("Active work").closest("summary")!);
    fireEvent.click(screen.getByRole("button", {
      name: "Acknowledge Typecheck · Release chat (codex/release)",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "Dismiss Typecheck · Release chat (codex/release)",
    }));
    fireEvent.click(screen.getByText("Local Servers").closest("summary")!);
    fireEvent.click(screen.getByRole("button", {
      name: /Stop Docs preview · Docs chat/u,
    }));
    expect(actions.onAcknowledgeRun).toHaveBeenCalledWith(failed);
    expect(actions.onDismissRun).toHaveBeenCalledWith(failed);
    expect(actions.onStopRun).toHaveBeenCalledWith(summary.localServers[0]);
  });

  it("moves focus to the next run action when a row disappears", () => {
    const actions = panelActions();
    const running = environmentRun({ id: "build", label: "Build", canStop: true });
    const failed = environmentRun({
      id: "typecheck",
      label: "Typecheck",
      status: "failed",
      canAcknowledge: true,
    });
    const view = render(
      <EnvironmentPanel
        summary={{ ...summary, checks: [running, failed] }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    fireEvent.click(screen.getByText("Active work").closest("summary")!);
    const stop = screen.getByRole("button", { name: "Stop Build" });
    stop.focus();
    fireEvent.click(stop);
    view.rerender(
      <EnvironmentPanel
        summary={{ ...summary, checks: [failed] }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("button", { name: "Acknowledge Typecheck" }))
      .toHaveFocus();
  });

  it("does not steal focus after the user leaves a disappearing run action", () => {
    const actions = panelActions();
    const running = environmentRun({ id: "build", label: "Build", canStop: true });
    const view = render(
      <>
        <EnvironmentPanel
          summary={{ ...summary, checks: [running] }}
          workspaceToolsAvailable
          {...actions}
        />
        <button type="button">Outside</button>
      </>,
    );
    fireEvent.click(screen.getByText("Active work").closest("summary")!);
    const stop = screen.getByRole("button", { name: "Stop Build" });
    const outside = screen.getByRole("button", { name: "Outside" });
    stop.focus();
    fireEvent.click(stop);
    outside.focus();
    view.rerender(
      <>
        <EnvironmentPanel
          summary={{ ...summary, checks: [] }}
          workspaceToolsAvailable
          {...actions}
        />
        <button type="button">Outside</button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("names detached state and the platform file manager truthfully", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    try {
      render(
        <EnvironmentPanel
          summary={{ ...summary, branch: { label: "Branch", value: "Detached HEAD" } }}
          workspaceToolsAvailable
          {...panelActions()}
        />,
      );
      expect(screen.getAllByText("Detached HEAD")[0]).toBeVisible();
      expect(screen.getByRole("button", { name: "Open in Finder" })).toBeVisible();
    } finally {
      Reflect.deleteProperty(window, "inertia");
    }
  });

  it("explains why provisional worktree tools are unavailable", () => {
    const reason = "Workspace tools are available after the first message creates this isolated worktree.";
    render(
      <HeaderHarness
        activeProject={project}
        workspaceToolsUnavailableReason={reason}
      />,
    );
    expect(screen.getByRole("button", { name: reason })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Environment" })).toBeEnabled();
  });
});

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  loadCommitDialog: vi.fn(),
  prefetchWorkspaceTool: vi.fn(),
}));

import { AgentsSurface, ENVIRONMENT_ATTACHMENTS_EXPANDED_STORAGE_KEY } from "../../src/renderer/src/components/AgentsSurface";
import {
  CheckoutBranchControlProvider,
  CheckoutBranchSlot,
} from "../../src/renderer/src/components/CheckoutBranchControl";
import { UsageSurface } from "../../src/renderer/src/components/UsageSurface";
import WorkspaceGitActionMenu from "../../src/renderer/src/components/WorkspaceGitActionMenu";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { OpenInControl } from "../../src/renderer/src/components/workspace-header/OpenInControl";
import { PanelLayoutControls } from "../../src/renderer/src/components/workspace-header/PanelLayoutControls";
import { ProjectActionsControl } from "../../src/renderer/src/components/workspace-header/ProjectActionsControl";
import type { EnvironmentSummarySnapshot } from "../../src/renderer/src/utils/environmentSummary";
import type { WorkspaceRunsModel } from "../../src/renderer/src/utils/workspaceRuns";
import type { Project } from "../../src/shared/contracts";
import { nativePreviewSuspended } from "../../src/renderer/src/utils/nativePreviewOverlay";

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
    { id: "attachment-1", name: "reference.png", mimeType: "image/png", size: 1024 },
    { id: "attachment-2", name: "requirements.pdf", mimeType: "application/pdf", size: 2048 },
    {
      id: "attachment-3",
      name: "forecast.xlsx",
      size: 4096,
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

function runsModel(
  overrides: Partial<WorkspaceRunsModel> = {},
): WorkspaceRunsModel {
  return {
    localServers: summary.localServers,
    checks: summary.checks,
    onStopRun: vi.fn(),
    onOpenRunPreview: vi.fn(),
    onAcknowledgeRun: vi.fn(),
    onDismissRun: vi.fn(),
    ...overrides,
  };
}

function agentsSurface(overrides: Partial<EnvironmentSummarySnapshot> = {}): React.JSX.Element {
  const next = { ...summary, ...overrides };
  return (
    <AgentsSurface
      runtimeStatus={next.runtime.status}
      attachments={next.attachments}
      subagents={[]}
      turns={[]}
    />
  );
}

function RunControl({
  runs,
  actions = [],
}: {
  runs: WorkspaceRunsModel;
  actions?: Parameters<typeof ProjectActionsControl>[0]["actions"];
}): React.JSX.Element {
  return (
    <ProjectActionsControl
      presentation="toolbar"
      projectId={project.id}
      actions={actions}
      runs={runs}
      onRunAction={vi.fn()}
      onAddAction={vi.fn()}
    />
  );
}

async function openRunMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Project action options" }));
  const menu = await screen.findByRole("menu", { name: "Project actions" });
  await within(menu).findByRole("group", { name: "Running" });
  return menu;
}

describe("Environment content in its workspace surfaces", () => {
  beforeEach(() => {
    window.localStorage.clear();
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

  it("keeps the attachment gallery collapsed until there is more than the recent set", () => {
    render(agentsSurface());

    expect(screen.getByRole("list", { name: "Recent attachments" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show all/u })).toBeNull();
  });

  it("expands the attachment gallery to scroll every attachment and remembers the choice", async () => {
    const gallery = {
      ...summary,
      attachments: Array.from({ length: 9 }, (_, index) => ({
        id: `gallery-${index}`,
        name: `shot-${index}.png`,
        mimeType: "image/png" as const,
        size: 2048,
      })),
    };
    const view = render(agentsSurface(gallery));
    const section = document.querySelector(".environment-attachments")!;

    expect(section).toHaveAttribute("data-expanded", "false");
    expect(within(screen.getByRole("list", { name: "Recent attachments" }))
      .getAllByRole("listitem")).toHaveLength(3);

    const toggle = screen.getByRole("button", { name: "Show all 9" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!))
      .toContainElement(screen.getByRole("list", { name: "Recent attachments" }));

    await userEvent.click(toggle);

    expect(section).toHaveAttribute("data-expanded", "true");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "All attachments" }))
      .getAllByRole("listitem")).toHaveLength(9);
    expect(screen.queryByRole("list", { name: "Recent attachments" })).toBeNull();
    expect(window.localStorage.getItem(ENVIRONMENT_ATTACHMENTS_EXPANDED_STORAGE_KEY)).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));

    expect(section).toHaveAttribute("data-expanded", "false");
    expect(window.localStorage.getItem(ENVIRONMENT_ATTACHMENTS_EXPANDED_STORAGE_KEY)).toBe("false");

    // A remembered expansion collapses again when the chat drops back to the
    // recent set, so the toggle never claims to hide attachments that are gone.
    await userEvent.click(screen.getByRole("button", { name: "Show all 9" }));
    view.rerender(agentsSurface());

    expect(document.querySelector(".environment-attachments"))
      .toHaveAttribute("data-expanded", "false");
    expect(screen.getByRole("list", { name: "Recent attachments" })).toBeInTheDocument();
  });

  it("opens real recent-attachment previews by ID from Agents and closes on context change", async () => {
    const view = render(agentsSurface());
    const list = screen.getByRole("list", { name: "Recent attachments" });
    const imageButton = within(list).getByRole("button", { name: "Preview attachment reference.png" });
    const thumbnail = imageButton.querySelector("img")!;
    expect(thumbnail).toHaveAttribute("src", "inertia://bundle/attachment-preview/attachment-1");
    expect(imageButton).toHaveTextContent("PNG image · 1.0 KB");
    fireEvent.load(thumbnail);
    expect(thumbnail.parentElement).toHaveAttribute("data-thumbnail-state", "ready");
    await userEvent.click(imageButton);
    expect(nativePreviewSuspended()).toBe(true);
    const preview = await screen.findByRole("dialog", { name: "reference.png" });
    const fullImage = within(preview).getByRole("img", { name: "reference.png" });
    expect(fullImage).toHaveAttribute("src", thumbnail.getAttribute("src"));
    fireEvent.error(fullImage);
    expect(within(preview).getByRole("alert")).toHaveTextContent("Preview unavailable");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(nativePreviewSuspended()).toBe(false);
    await userEvent.click(imageButton);
    await screen.findByRole("dialog", { name: "reference.png" });
    view.rerender(agentsSurface({ attachments: [] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("list", { name: "Recent attachments" })).toBeNull();
    expect(nativePreviewSuspended()).toBe(false);
  });

  it("keeps delegated work and every recent attachment in the Agents surface", () => {
    render(agentsSurface());
    const agents = screen.getByRole("region", { name: "Agents" });
    expect(within(agents).getByRole("heading", { name: "Delegated work" })).toBeVisible();
    expect(within(agents).getByText("No provider-reported subagents in this conversation.")).toBeVisible();
    expect(within(agents).getByText("reference.png")).toBeVisible();
    expect(within(agents).getByText("requirements.pdf")).toBeVisible();
    expect(within(agents).getByText("forecast.xlsx")).toBeVisible();
    expect(agents.querySelector(".lucide-file-spreadsheet")).not.toBeNull();
  });

  it("promotes runtime status in Agents only when attention is required", () => {
    const view = render(agentsSurface());
    expect(screen.queryByText(/workspace runtime/iu)).not.toBeInTheDocument();

    view.rerender(agentsSurface({ runtime: { status: "connecting" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to workspace");

    view.rerender(agentsSurface({ runtime: { status: "offline" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Workspace runtime unavailable");
  });

  it("keeps section labelling unique across split Agents surfaces", () => {
    const view = render(<>{agentsSurface()}{agentsSurface()}</>);
    const labels = [...view.container.querySelectorAll<HTMLElement>(
      ".agents-surface [aria-labelledby]",
    )].map((element) => element.getAttribute("aria-labelledby"));
    expect(labels.length).toBeGreaterThan(1);
    expect(labels).not.toContain(null);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(document.getElementById(label!)).not.toBeNull();
  });

  it("shows every provider limit with its window, reset and this chat's context in Usage", () => {
    render(<UsageSurface usage={summary.usage} onRefreshUsage={vi.fn()} />);
    const usage = screen.getByRole("region", { name: "Usage" });
    expect(within(usage).getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(within(usage).getByText("Current")).toBeVisible();
    const meter = within(usage).getByRole("meter", { name: "Five-hour limit remaining" });
    expect(meter).toHaveAttribute("aria-valuenow", "64");
    expect(within(usage).getByText("64% left")).toBeVisible();
    expect(within(usage).getByText("Context window")).toBeVisible();
    // The visible value is aria-hidden; the readable label sits beside it as
    // visually hidden text instead of an aria-label on a generic element.
    expect(within(usage).getByText("Context 72% remaining").closest("b")).toHaveTextContent("72%");
    expect(within(usage).queryByRole("button", { name: "Refresh usage" })).not.toBeInTheDocument();
  });

  it("shows current, stale, refreshing, and unavailable Usage without inventing quota", () => {
    const onRefreshUsage = vi.fn();
    const view = render(<UsageSurface usage={summary.usage} onRefreshUsage={onRefreshUsage} />);
    expect(screen.getByText("Current")).toBeVisible();

    view.rerender(
      <UsageSurface
        onRefreshUsage={onRefreshUsage}
        usage={{
          ...summary.usage!,
          context: {
            ...summary.usage!.context,
            quality: "stale",
            valueLabel: "72% · stale",
            accessibleLabel: "Context 72% remaining, stale",
          },
          quota: { ...summary.usage!.quota, freshness: "stale", limits: [] },
        }}
      />,
    );
    expect(screen.getByText("Stale")).toBeVisible();
    expect(screen.getByText("No provider limit windows are available.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    expect(onRefreshUsage).toHaveBeenCalledOnce();

    view.rerender(
      <UsageSurface
        onRefreshUsage={onRefreshUsage}
        usage={{
          ...summary.usage!,
          quota: { ...summary.usage!.quota, freshness: "refreshing", limits: [] },
        }}
      />,
    );
    expect(screen.getByText("Refreshing provider limits…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refreshing" })).toBeDisabled();

    view.rerender(
      <UsageSurface
        onRefreshUsage={onRefreshUsage}
        usage={{
          ...summary.usage!,
          quota: {
            ...summary.usage!.quota,
            freshness: "unavailable",
            source: "isolated",
            limits: [],
          },
        }}
      />,
    );
    expect(screen.getByText("Unavailable for this backend")).toBeVisible();
    expect(screen.getByText(/not shared with this custom backend route/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Refresh usage" })).not.toBeInTheDocument();

    view.rerender(<UsageSurface usage={null} onRefreshUsage={onRefreshUsage} />);
    expect(screen.getByText(/Usage is unavailable/iu)).toBeVisible();
  });

  it("moves local servers into Run with their status in text, not a dot", async () => {
    const runs = runsModel();
    render(<RunControl runs={runs} />);
    expect(screen.getByRole("button", { name: "Add action, 1 running" })).toBeVisible();

    const menu = await openRunMenu();
    const server = within(menu).getByRole("group", {
      name: "Docs preview · Docs chat (docs/preview) · npm run preview",
    });
    expect(within(server).getByText("Running · http://127.0.0.1:4173 · Docs chat (docs/preview) · npm run preview"))
      .toBeVisible();
    expect(document.querySelector(".header-live-dot, .header-run-state")).toBeNull();
    fireEvent.click(within(server).getByRole("menuitem", { name: /Stop Docs preview · Docs chat/u }));
    expect(runs.onStopRun).toHaveBeenCalledWith(summary.localServers[0]);
    fireEvent.click(within(server).getByRole("menuitem", { name: /Open preview for Docs preview/u }));
    expect(runs.onOpenRunPreview).toHaveBeenCalledWith(summary.localServers[0]);
    expect(screen.queryByRole("menu", { name: "Project actions" })).not.toBeInTheDocument();
  });

  it("offers only Add action when no validated server or check is active", () => {
    render(<RunControl runs={runsModel({ localServers: [], checks: [] })} />);
    expect(screen.getByRole("button", { name: "Add action" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Project action options" })).not.toBeInTheDocument();
    expect(screen.queryByText(/running/iu)).not.toBeInTheDocument();
  });

  it("preserves all run controls and sibling owner context in Run", async () => {
    const failed = environmentRun({
      id: "failed-check",
      conversationId: "conversation-2",
      label: "Typecheck",
      status: "failed",
      contextLabel: "Release chat (codex/release)",
      canAcknowledge: true,
      canDismiss: true,
    });
    const runs = runsModel({ checks: [failed] });
    render(<RunControl runs={runs} />);
    const menu = await openRunMenu();
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Acknowledge Typecheck · Release chat (codex/release)",
    }));
    fireEvent.click(within(menu).getByRole("menuitem", {
      name: "Dismiss Typecheck · Release chat (codex/release)",
    }));
    expect(runs.onAcknowledgeRun).toHaveBeenCalledWith(failed);
    expect(runs.onDismissRun).toHaveBeenCalledWith(failed);
    expect(within(menu).getByText(/Needs attention/u)).toBeVisible();
  });

  it("moves focus to the next run action when a row disappears", async () => {
    const running = environmentRun({ id: "build", label: "Build", canStop: true });
    const failed = environmentRun({
      id: "typecheck",
      label: "Typecheck",
      status: "failed",
      canAcknowledge: true,
    });
    const runs = runsModel({ localServers: [], checks: [running, failed] });
    const view = render(<RunControl runs={runs} />);
    const menu = await openRunMenu();
    const stop = within(menu).getByRole("menuitem", { name: "Stop Build" });
    stop.focus();
    fireEvent.click(stop);
    view.rerender(<RunControl runs={{ ...runs, checks: [failed] }} />);
    expect(screen.getByRole("menuitem", { name: "Acknowledge Typecheck" })).toHaveFocus();
  });

  it("does not steal focus after the user leaves a disappearing run action", async () => {
    const running = environmentRun({ id: "build", label: "Build", canStop: true });
    const failed = environmentRun({
      id: "typecheck",
      label: "Typecheck",
      status: "failed",
      canAcknowledge: true,
    });
    const runs = runsModel({ localServers: [], checks: [running, failed] });
    const view = render(
      <>
        <RunControl runs={runs} />
        <button type="button">Outside</button>
      </>,
    );
    const menu = await openRunMenu();
    const stop = within(menu).getByRole("menuitem", { name: "Stop Build" });
    stop.focus();
    fireEvent.click(stop);
    screen.getByRole("button", { name: "Outside" }).focus();
    view.rerender(
      <>
        <RunControl runs={{ ...runs, checks: [failed] }} />
        <button type="button">Outside</button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("names the platform file manager truthfully in Open", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin", copyText: vi.fn() },
    });
    try {
      const onRevealFolder = vi.fn();
      render(
        <OpenInControl
          presentation="toolbar"
          checkoutName="inertia"
          checkoutPath={summary.openTarget?.path ?? null}
          filesAvailable
          onOpenFolder={vi.fn()}
          onRevealFolder={onRevealFolder}
          onOpenFiles={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Choose where to open" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /^Finder/u }));
      expect(onRevealFolder).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Open inertia in Finder" })).toBeVisible();
    } finally {
      Reflect.deleteProperty(window, "inertia");
    }
  });

  it("names detached state in the checkout strip branch selector", async () => {
    const onRefreshBranches = vi.fn();
    render(
      <CheckoutBranchControlProvider
        value={{
          project,
          conversation: null,
          gitStatus: {
            isRepository: true,
            root: project.path,
            branch: null,
            upstream: null,
            ahead: 0,
            behind: 0,
            hasRemote: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
          branches: [],
          busy: false,
          onRefreshBranches,
          onSwitchBranch: vi.fn(),
          onCreateBranch: vi.fn(),
          onCreateConversationOnBranch: vi.fn(),
          onCreateConversationInWorktree: vi.fn(),
          onCreateConversationInIsolatedWorktree: vi.fn(),
        }}
      >
        <CheckoutBranchSlot branch="Detached HEAD" />
      </CheckoutBranchControlProvider>,
    );
    const trigger = await screen.findByRole("button", {
      name: "Detached HEAD, create or check out a branch",
    });
    expect(trigger).toHaveTextContent("Detached HEAD · Create branch");
    fireEvent.click(trigger);
    expect(onRefreshBranches).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("surfaces Git failures in the Git menu instead of a separate Environment row", () => {
    render(
      <WorkspaceGitActionMenu
        status={{
          isRepository: true,
          root: project.path,
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
        }}
        busy={false}
        notice="Permission denied."
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Permission denied.")).toHaveAttribute("role", "status");
  });

  it("does not offer workspace actions before a task has a project", () => {
    render(
      <WorkspaceHeader
        project={null}
        conversation={null}
        view="workspace"
        sidebarCollapsed={false}
        gitStatus={null}
        branches={[]}
        actions={[]}
        busy={false}
        onOpenSidebar={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenFolder={vi.fn()}
        onRevealFolder={vi.fn()}
        onOpenFiles={vi.fn()}
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
      />,
    );
    expect(screen.queryByRole("group", { name: "Project actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Open checkout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Git actions" })).not.toBeInTheDocument();
  });

  it("explains why provisional worktree tools are unavailable while the right panel stays reachable", () => {
    const reason = "Workspace tools are available after the first message creates this isolated worktree.";
    const onToggleRightPanel = vi.fn();
    render(
      <PanelLayoutControls
        usage={null}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        terminalUnavailableLabel={reason}
        rightPanelAvailable
        rightPanelOpen={false}
        liveAgentCount={0}
        onToggleTerminal={vi.fn()}
        onToggleRightPanel={onToggleRightPanel}
        onOpenUsage={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: reason })).toBeDisabled();
    const toggle = screen.getByRole("button", { name: "Toggle right panel" });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(onToggleRightPanel).toHaveBeenCalledOnce();
  });
});

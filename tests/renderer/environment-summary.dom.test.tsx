import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { EnvironmentPanel } from "../../src/renderer/src/components/EnvironmentPanel";
import type { Project } from "../../src/shared/contracts";
import type { EnvironmentSummarySnapshot } from "../../src/renderer/src/utils/environmentSummary";

const summary: EnvironmentSummarySnapshot = {
  projectName: "Inertia",
  workspace: {
    label: "Worktree",
    value: "environment-panel",
    path: "/workspace/worktrees/environment-panel",
  },
  repository: { name: "inertia", path: "/workspace/inertia" },
  runtime: { status: "online" },
  changes: {
    files: 2,
    insertions: 9,
    deletions: 4,
    repositories: 1,
  },
  gitState: "ready",
  gitNotice: null,
  branch: { label: "Branch", value: "codex/summary" },
  checks: [{ id: "check-1", label: "Typecheck", status: "running" }],
  subagents: [{
    id: "trace-1",
    providerName: "Review",
    providerRole: "reviewer",
    status: "running",
  }],
  attachments: [
    { id: "attachment-1", name: "reference.png", mimeType: "image/png" },
    { id: "attachment-2", name: "requirements.pdf", mimeType: "application/pdf" },
  ],
  localServers: [{ url: "http://localhost:4173/" }],
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
  workspaceToolsUnavailableReason = null,
  onOpenSettings = vi.fn(),
  onOpenConnectionsSettings = vi.fn(),
  onOpenEnvironment = vi.fn(),
}: {
  activeProject?: Project | null;
  workspaceToolsUnavailableReason?: string | null;
  onOpenSettings?: () => void;
  onOpenConnectionsSettings?: () => void;
  onOpenEnvironment?: () => void;
}): React.JSX.Element {
  return (
    <WorkspaceHeader
      project={activeProject}
      conversation={null}
      view="workspace"
      activeTool={null}
      sidebarCollapsed={false}
      theme="dark"
      gitStatus={null}
      branches={[]}
      actions={[]}
      busy={false}
      activityOpen={false}
      activeRunCount={0}
      attentionRunCount={0}
      onOpenSidebar={vi.fn()}
      onToggleTools={vi.fn()}
      workspaceToolsUnavailableReason={workspaceToolsUnavailableReason}
      onOpenEnvironment={onOpenEnvironment}
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
      onToggleActivity={vi.fn()}
    />
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

  it("reports real context and routes each available action", () => {
    const actions = {
      onOpenChanges: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenPreview: vi.fn(),
      onOpenProject: vi.fn(),
      onRevealProject: vi.fn(),
    };
    render(<EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />);

    expect(screen.getByRole("heading", { name: "Inertia" })).toBeVisible();
    expect(screen.getByText("environment-panel")).toBeVisible();
    expect(screen.getByText("codex/summary")).toBeVisible();
    expect(screen.getByText("inertia", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("9 insertions and 4 deletions")).toBeVisible();
    expect(screen.getByText("reference.png")).toBeVisible();
    expect(screen.getByText("requirements.pdf")).toBeVisible();
    expect(screen.getByText("http://localhost:4173/")).toBeVisible();
    expect(screen.getByText("Typecheck")).toBeVisible();
    expect(screen.getByText("Review")).toBeVisible();
    expect(screen.queryByText("Ready", { exact: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /changed files/u }));
    fireEvent.click(screen.getByRole("button", { name: /Browse files/u }));
    fireEvent.click(screen.getByRole("button", { name: /localhost:4173/u }));
    fireEvent.click(screen.getByRole("button", { name: /Open project/u }));
    fireEvent.click(screen.getByRole("button", { name: /Reveal/u }));
    expect(actions.onOpenChanges).toHaveBeenCalledOnce();
    expect(actions.onOpenFiles).toHaveBeenCalledOnce();
    expect(actions.onOpenPreview).toHaveBeenCalledOnce();
    expect(actions.onOpenProject).toHaveBeenCalledOnce();
    expect(actions.onRevealProject).toHaveBeenCalledOnce();
  });

  it("routes the header Environment control to the panel", () => {
    const onOpenEnvironment = vi.fn();
    render(<HeaderHarness activeProject={project} onOpenEnvironment={onOpenEnvironment} />);

    const trigger = screen.getByRole("button", { name: "Open Environment" });
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(trigger);
    expect(onOpenEnvironment).toHaveBeenCalledOnce();
  });

  it("does not offer Environment before a task has a project", () => {
    render(<HeaderHarness />);
    expect(screen.queryByRole("button", { name: "Open Environment" }))
      .not.toBeInTheDocument();
  });

  it("distinguishes clean, loading, unavailable, and failed repository states", () => {
    const actions = {
      onOpenChanges: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenPreview: vi.fn(),
      onOpenProject: vi.fn(),
      onRevealProject: vi.fn(),
    };
    const view = render(
      <EnvironmentPanel
        summary={{ ...summary, gitState: "loading" }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByText("Loading repository state…")).toBeVisible();
    expect(screen.getByRole("button", { name: /Checking working tree/u })).toBeDisabled();
    expect(screen.queryByLabelText("9 insertions and 4 deletions"))
      .not.toBeInTheDocument();

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
    expect(screen.getByText("Working tree clean")).toBeVisible();
    expect(screen.getByRole("button", { name: /Working tree clean/u })).toBeEnabled();

    view.rerender(
      <EnvironmentPanel
        summary={{ ...summary, changes: null, gitState: "unavailable" }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByText("No Git repository")).toBeVisible();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          gitState: "error",
          gitNotice: "Permission denied.",
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByText("Repository details unavailable")).toBeVisible();
    expect(screen.getByText(/Permission denied\./u)).toBeVisible();
    expect(screen.getByRole("button", { name: /Repository details unavailable/u })).toBeDisabled();
    expect(screen.queryByLabelText("9 insertions and 4 deletions"))
      .not.toBeInTheDocument();
    expect(actions.onOpenChanges).not.toHaveBeenCalled();
  });

  it("only promotes runtime state when live details need attention", () => {
    const actions = {
      onOpenChanges: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenPreview: vi.fn(),
      onOpenProject: vi.fn(),
      onRevealProject: vi.fn(),
    };
    const view = render(
      <EnvironmentPanel
        summary={summary}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.queryByText("Ready", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace runtime/u)).not.toBeInTheDocument();

    view.rerender(
      <EnvironmentPanel
        summary={{ ...summary, runtime: { status: "connecting" } }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to workspace");
    expect(screen.getByRole("status")).toHaveTextContent("may be incomplete");

    view.rerender(
      <EnvironmentPanel
        summary={{ ...summary, runtime: { status: "offline" } }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Workspace runtime unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("may be out of date");
  });

  it("omits empty secondary sections and keeps the main actions in keyboard order", async () => {
    const user = userEvent.setup();
    const actions = {
      onOpenChanges: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenPreview: vi.fn(),
      onOpenProject: vi.fn(),
      onRevealProject: vi.fn(),
    };
    render(
      <EnvironmentPanel
        summary={{
          ...summary,
          localServers: [],
          checks: [],
          subagents: [],
          attachments: [],
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Local servers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Active work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent attachments" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No recent task attachments/u)).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole("button", { name: "Open project" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Reveal" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Browse files" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /changed files/u })).toHaveFocus();
  });

  it("keeps every labelled section unique when split panes both show Environment", () => {
    const actions = {
      onOpenChanges: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenPreview: vi.fn(),
      onOpenProject: vi.fn(),
      onRevealProject: vi.fn(),
    };
    const view = render(
      <>
        <EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />
        <EnvironmentPanel summary={summary} workspaceToolsAvailable {...actions} />
      </>,
    );
    const labelled = [...view.container.querySelectorAll<HTMLElement>(
      ".environment-panel [aria-labelledby], .environment-panel[aria-labelledby]",
    )];
    const labels = labelled.map((element) =>
      element.getAttribute("aria-labelledby"));

    expect(labels).not.toContain(null);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) {
      expect(document.getElementById(label!)).not.toBeNull();
    }
  });

  it("routes the Private Connect indicator directly to Connections & devices settings", async () => {
    const onOpenSettings = vi.fn();
    const onOpenConnectionsSettings = vi.fn();
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPrivateConnectState: vi.fn(async () => ({
          available: true,
          enabled: true,
          status: "ready",
          statusMessage: null,
          externalUrl: "https://inertia.tailnet.ts.net",
          activeSessions: 0,
          devices: [],
          pendingPairings: [],
          invitation: null,
          notice: null,
          diagnostics: { tailscale: "connected", magicDns: "available", gatewayPort: 1, servePort: 8443, externalUrl: "https://inertia.tailnet.ts.net", mappingOwnership: "owned", errorClass: null },
        })),
        onPrivateConnectState: vi.fn(() => vi.fn()),
      },
    });
    try {
      render(<HeaderHarness
        activeProject={project}
        onOpenSettings={onOpenSettings}
        onOpenConnectionsSettings={onOpenConnectionsSettings}
      />);
      const indicator = await screen.findByRole("button", {
        name: "Connections & devices ready",
      });
      indicator.click();
      expect(onOpenConnectionsSettings).toHaveBeenCalledOnce();
      expect(onOpenSettings).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, "inertia");
    }
  });

  it("surfaces a pending browser approval outside Settings", async () => {
    const onOpenConnectionsSettings = vi.fn();
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPrivateConnectState: vi.fn(async () => ({
          available: true,
          enabled: true,
          status: "ready",
          statusMessage: null,
          externalUrl: "https://inertia.tailnet.ts.net",
          activeSessions: 0,
          devices: [],
          pendingPairings: [{
            requestId: "11111111-1111-4111-8111-111111111111",
            deviceLabel: "Phone",
            comparisonCode: "123456",
            receivedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:05:00.000Z",
            tailnetLabel: "example",
          }],
          invitation: null,
          notice: null,
          diagnostics: { tailscale: "connected", magicDns: "available", gatewayPort: 1, servePort: 8443, externalUrl: "https://inertia.tailnet.ts.net", mappingOwnership: "owned", errorClass: null },
        })),
        onPrivateConnectState: vi.fn(() => vi.fn()),
      },
    });
    try {
      render(<HeaderHarness
        activeProject={project}
        onOpenConnectionsSettings={onOpenConnectionsSettings}
      />);
      const indicator = await screen.findByRole("button", {
        name: "Connections & devices, 1 pairing approval waiting",
      });
      expect(indicator).toHaveTextContent("Approve device");
      const alert = screen.getByRole("alert", {
        name: "Private Connect pairing approval",
      });
      expect(alert).toHaveTextContent("Phone wants to connect");
      expect(alert).toHaveTextContent("123456");
      expect(alert).toHaveTextContent("example");
      screen.getByRole("button", { name: "Review access" }).click();
      expect(onOpenConnectionsSettings).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(window, "inertia");
    }
  });

  it("explains why isolated-worktree draft tools are not ready", () => {
    const reason =
      "Workspace tools are available after the first message creates this isolated worktree.";
    render(
      <HeaderHarness
        activeProject={project}
        workspaceToolsUnavailableReason={reason}
      />,
    );

    expect(screen.getByRole("button", { name: reason })).toBeDisabled();
  });
});

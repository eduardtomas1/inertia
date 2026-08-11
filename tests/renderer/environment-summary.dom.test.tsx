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

import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { EnvironmentPanel } from "../../src/renderer/src/components/EnvironmentPanel";
import { WorkspacePanel } from "../../src/renderer/src/components/WorkspacePanel";
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
  localPreviewTargets: [{ url: "http://localhost:4173/" }],
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

function EnvironmentFocusHarness(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<"environment" | "changes" | "files" | "preview">(
    "environment",
  );
  return (
    <WorkspacePanel
      activeTab={activeTab}
      onTabChange={(tab) => {
        if (tab === "environment" || tab === "changes" || tab === "files" || tab === "preview") {
          setActiveTab(tab);
        }
      }}
      tabs={["environment", "changes", "files", "preview"]}
    >
      {activeTab === "environment" ? (
        <EnvironmentPanel
          summary={summary}
          workspaceToolsAvailable
          onOpenChanges={() => setActiveTab("changes")}
          onOpenFiles={() => setActiveTab("files")}
          onOpenPreview={() => setActiveTab("preview")}
          onOpenProject={vi.fn()}
          onRevealProject={vi.fn()}
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

  it("reports real context and routes each available action", () => {
    const actions = {
      onOpenChanges: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenPreview: vi.fn(),
      onOpenProject: vi.fn(),
      onRevealProject: vi.fn(),
      onRetryGit: vi.fn(),
      onCommit: vi.fn(),
      onPush: vi.fn(),
    };
    render(
      <EnvironmentPanel
        summary={summary}
        workspaceToolsAvailable
        commitAction={{
          id: "commit",
          label: "Commit",
          detail: "Commit two changed files.",
          disabled: false,
        }}
        pushAction={{
          id: "push",
          label: "Push 1",
          detail: "Push one commit.",
          disabled: false,
        }}
        {...actions}
      />,
    );

    expect(screen.getAllByText("Worktree")[0]).toBeVisible();
    expect(screen.getByText("codex/summary")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Repository" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Editor" })).toBeVisible();
    expect(screen.getByLabelText("9 insertions and 4 deletions")).toBeVisible();
    expect(screen.queryByText("Ready", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Usage", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Recap", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("reference.png")).not.toBeInTheDocument();
    expect(screen.queryByText("requirements.pdf")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Changes/u }));
    fireEvent.click(screen.getByText("Commit and Push").closest("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    fireEvent.click(screen.getByRole("button", { name: "Push 1" }));
    fireEvent.click(screen.getByText("Local Servers").closest("summary")!);
    expect(screen.getByText("Last opened in Preview")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /localhost:4173/u }));
    fireEvent.click(screen.getByRole("button", { name: /Open repository inertia externally/u }));
    fireEvent.click(screen.getByRole("button", { name: "Editor view" }));
    fireEvent.click(screen.getByRole("button", { name: /Open in/u }));
    expect(actions.onOpenChanges).toHaveBeenCalledOnce();
    expect(actions.onOpenFiles).toHaveBeenCalledOnce();
    expect(actions.onOpenPreview).toHaveBeenCalledOnce();
    expect(actions.onOpenProject).toHaveBeenCalledOnce();
    expect(actions.onRevealProject).toHaveBeenCalledOnce();
    expect(actions.onCommit).toHaveBeenCalledOnce();
    expect(actions.onPush).toHaveBeenCalledOnce();
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

  it("distinguishes clean, loading, uninspected, unavailable, and failed repository states", () => {
    const actions = {
      onOpenChanges: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenPreview: vi.fn(),
      onOpenProject: vi.fn(),
      onRevealProject: vi.fn(),
      onRetryGit: vi.fn(),
    };
    const view = render(
      <EnvironmentPanel
        summary={{ ...summary, branch: null, gitState: "loading" }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("button", { name: "Changes Checking…" })).toBeDisabled();
    expect(screen.getByText("Checking branch…")).toBeVisible();
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
    expect(screen.getByLabelText("0 insertions and 0 deletions")).toBeVisible();
    expect(screen.getByRole("button", { name: /Changes/u })).toBeEnabled();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          changes: { ...summary.changes!, files: 0, insertions: 0, deletions: 0 },
          gitState: "ready",
          gitNotice: "The repository scan did not inspect every directory.",
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByLabelText("0 insertions and 0 deletions")).toBeVisible();
    expect(screen.getByText(/did not inspect every directory/u)).toBeVisible();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          branch: null,
          changes: null,
          gitState: "unknown",
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );
    expect(screen.getByRole("button", { name: "Changes Not checked" }))
      .toBeDisabled();
    expect(screen.getByText("Repository not checked")).toBeVisible();

    view.rerender(
      <EnvironmentPanel
        summary={{
          ...summary,
          branch: null,
          changes: null,
          gitState: "unavailable",
        }}
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
    expect(screen.getByRole("button", { name: "Changes Unavailable" })).toBeDisabled();
    expect(screen.getByText(/Permission denied\./u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByLabelText("9 insertions and 4 deletions"))
      .not.toBeInTheDocument();
    expect(actions.onOpenChanges).not.toHaveBeenCalled();
    expect(actions.onRetryGit).toHaveBeenCalledOnce();
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

  it("keeps detached state explicit and names the platform file manager", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    try {
      render(
        <EnvironmentPanel
          summary={{
            ...summary,
            branch: { label: "Branch", value: "Detached HEAD" },
          }}
          workspaceToolsAvailable
          onOpenChanges={vi.fn()}
          onOpenFiles={vi.fn()}
          onOpenPreview={vi.fn()}
          onOpenProject={vi.fn()}
          onRevealProject={vi.fn()}
        />,
      );

      expect(screen.getByText("Detached HEAD")).toBeVisible();
      expect(screen.getByRole("button", { name: "Open in Finder" }))
        .toBeVisible();
    } finally {
      Reflect.deleteProperty(window, "inertia");
    }
  });

  it("shows a truthful empty server disclosure without filler sections", () => {
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
          localPreviewTargets: [],
          checks: [],
          subagents: [],
          attachments: [],
        }}
        workspaceToolsAvailable
        {...actions}
      />,
    );

    expect(screen.getByText("Local Servers")).toBeVisible();
    const localServers = screen.getByText("Local Servers").closest("details")!;
    expect(localServers).not.toHaveAttribute("open");
    expect(localServers.querySelector("summary")).toHaveTextContent("0");
    fireEvent.click(localServers.querySelector("summary")!);
    expect(localServers).toHaveAttribute("open");
    expect(screen.getByText("Open a local URL in Preview to show it here."))
      .toBeVisible();
    expect(screen.queryByRole("heading", { name: "Active work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent attachments" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No recent task attachments/u)).not.toBeInTheDocument();

  });

  it("moves keyboard focus to the selected tool tab after an Environment action", async () => {
    const user = userEvent.setup();
    render(<EnvironmentFocusHarness />);
    const scenarios: Array<{ action: string | RegExp; tab: string }> = [
      { action: /Changes/u, tab: "Changes" },
      { action: "Editor view", tab: "Files" },
      { action: /localhost:4173/u, tab: "Preview" },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      if (index > 0) {
        await user.click(screen.getByRole("tab", { name: "Environment" }));
      }
      if (scenario.tab === "Preview") {
        await user.click(screen.getByText("Local Servers"));
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

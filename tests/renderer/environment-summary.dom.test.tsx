import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import type { Project } from "../../src/shared/contracts";
import type { EnvironmentSummarySnapshot } from "../../src/renderer/src/utils/environmentSummary";

const summary: EnvironmentSummarySnapshot = {
  projectName: "Inertia",
  runtime: { status: "online", label: "Ready" },
  changes: {
    files: 2,
    insertions: 9,
    deletions: 4,
    repositories: 1,
  },
  branch: { label: "Branch", value: "codex/summary" },
  checks: [],
  subagents: [],
  attachments: [],
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
}: {
  activeProject?: Project | null;
  workspaceToolsUnavailableReason?: string | null;
  onOpenSettings?: () => void;
  onOpenConnectionsSettings?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
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
        environmentSummary={summary}
        environmentOpen={open}
        onOpenSidebar={vi.fn()}
        onToggleTools={vi.fn()}
        workspaceToolsUnavailableReason={workspaceToolsUnavailableReason}
        onSetEnvironmentOpen={setOpen}
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
        onRunAction={vi.fn()}
        onToggleActivity={vi.fn()}
      />
      <button type="button">Outside</button>
    </>
  );
}

describe("environment summary header popover", () => {
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

  it("starts open, reports real context, and restores focus after Escape", async () => {
    render(<HeaderHarness />);
    const trigger = screen.getByRole("button", {
      name: "Close environment summary",
    });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Environment summary" }))
      .toBeVisible();
    expect(screen.getByText("codex/summary")).toBeVisible();
    expect(screen.getByLabelText("9 insertions and 4 deletions")).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Environment summary",
    })).not.toBeInTheDocument());
    expect(screen.getByRole("button", {
      name: "Open environment summary",
    })).toHaveFocus();
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

  it("closes when the user clicks outside", async () => {
    render(<HeaderHarness />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Environment summary",
    })).not.toBeInTheDocument());
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

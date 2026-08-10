import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityCenter } from "../../src/renderer/src/components/ActivityCenter";
import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import { CommitDialog } from "../../src/renderer/src/components/CommitDialog";
import { EnvironmentSummary } from "../../src/renderer/src/components/EnvironmentSummary";
import { AppStatusOverlays } from "../../src/renderer/src/components/AppStatusOverlays";
import { ProviderAuthDialog } from "../../src/renderer/src/components/ProviderAuthDialog";
import { RouteChangeConfirmation } from "../../src/renderer/src/components/composer/RouteChangeConfirmation";
import {
  nativePreviewSuspended,
} from "../../src/renderer/src/utils/nativePreviewOverlay";
import type {
  ProviderInfo,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly cols = 90;
    readonly rows = 24;
    readonly options: Record<string, unknown> = {};

    loadAddon(): void {}
    open(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    dispose(): void {}
  },
}));

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

const provider: ProviderInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
  installState: "installed",
  authState: "unauthenticated",
  canRun: false,
  statusMessage: "Sign in required",
  models: [],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
    rateLimits: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
  },
};

const environmentSummary = {
  projectName: "Inertia",
  runtime: { status: "online" as const, label: "Ready" },
  changes: null,
  branch: null,
  checks: [],
  subagents: [],
  attachments: [],
};

async function expectSuspended(): Promise<void> {
  await waitFor(() => expect(nativePreviewSuspended()).toBe(true));
}

async function expectRestored(): Promise<void> {
  await waitFor(() => expect(nativePreviewSuspended()).toBe(false));
}

describe("trusted overlay native preview suspension", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
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

  it("owns the commit dialog lifecycle", async () => {
    const onClose = vi.fn();
    const view = render(
      <CommitDialog
        open
        repositoryPath="."
        status={null}
        diff={{ fingerprint: "empty", files: [] }}
        diffParsing={false}
        diffError={null}
        reviewStates={[]}
        busy={false}
        onClose={onClose}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Commit changes" }))
      .toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    await expectSuspended();

    view.rerender(
      <CommitDialog
        open={false}
        repositoryPath="."
        status={null}
        diff={{ fingerprint: "empty", files: [] }}
        diffParsing={false}
        diffError={null}
        reviewStates={[]}
        busy={false}
        onClose={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    await expectRestored();

  });

  it("blocks commit actions until the complete diff is authoritative", async () => {
    const onCommit = vi.fn(async () => undefined);
    const status = {
      isRepository: true,
      root: "/workspace/inertia",
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: false,
      files: [{
        path: "src/app.ts",
        status: "modified",
        insertions: 1,
        deletions: 0,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
      }],
      insertions: 1,
      deletions: 0,
    };
    const view = render(
      <CommitDialog
        open
        repositoryPath="."
        status={status}
        diff={{ fingerprint: "pending", files: [] }}
        diffParsing
        diffError={null}
        reviewStates={[]}
        busy={false}
        onClose={vi.fn()}
        onCommit={onCommit}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "Keep review state honest" },
    });
    expect(screen.getByRole("status"))
      .toHaveTextContent("Preparing the complete diff");
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();

    view.rerender(
      <CommitDialog
        open
        repositoryPath="."
        status={status}
        diff={{ fingerprint: "ready", files: [] }}
        diffParsing={false}
        diffError={null}
        reviewStates={[]}
        busy={false}
        onClose={vi.fn()}
        onCommit={onCommit}
      />,
    );
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
  });

  it("owns the provider credential dialog lifecycle", async () => {
    const props = {
      status: "offline" as const,
      theme: "dark" as const,
      fontSize: 13,
      sendCommand: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      onClose: vi.fn(),
    };
    const view = render(
      <ProviderAuthDialog provider={provider} {...props} />,
    );

    expect(screen.getByRole("dialog", { name: "Connect Codex" }))
      .toBeInTheDocument();
    await expectSuspended();

    view.rerender(<ProviderAuthDialog provider={null} {...props} />);
    await expectRestored();
  });

  it("suspends before the lazy provider credential dialog mounts", async () => {
    const providerAuth = {
      provider,
      status: "offline" as const,
      theme: "dark" as const,
      fontSize: 13,
      sendCommand: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      onClose: vi.fn(),
    };
    const appUpdate = {
      status: null,
      checking: false,
      visible: false,
      check: vi.fn(async () => undefined),
      dismiss: vi.fn(),
      openRelease: vi.fn(async () => undefined),
    };
    const providerQuotaNotices = {
      notices: [],
      dismiss: vi.fn(),
    };
    const view = render(
      <AppStatusOverlays
        providerAuth={providerAuth}
        appUpdate={appUpdate}
        providerQuotaNotices={providerQuotaNotices}
        error={null}
        onDismissError={vi.fn()}
        databaseRecoveryNotice={null}
        onDismissDatabaseRecoveryNotice={vi.fn()}
        onImportRecovery={vi.fn(async () => undefined)}
        onCopyRecoveryReport={vi.fn(async () => undefined)}
      />,
    );

    expect(nativePreviewSuspended()).toBe(true);

    view.rerender(
      <AppStatusOverlays
        providerAuth={{ ...providerAuth, provider: null }}
        appUpdate={appUpdate}
        providerQuotaNotices={providerQuotaNotices}
        error={null}
        onDismissError={vi.fn()}
        databaseRecoveryNotice={null}
        onDismissDatabaseRecoveryNotice={vi.fn()}
        onImportRecovery={vi.fn(async () => undefined)}
        onCopyRecoveryReport={vi.fn(async () => undefined)}
      />,
    );
    await expectRestored();

    view.rerender(
      <AppStatusOverlays
        providerAuth={{ ...providerAuth, provider: null }}
        appUpdate={appUpdate}
        providerQuotaNotices={providerQuotaNotices}
        error={null}
        onDismissError={vi.fn()}
        databaseRecoveryNotice={{
          id: "runtime-1-database-recovery",
          outcome: "created-empty",
          trigger: "primary-corrupt",
          preservedCorruptPrimary: true,
          invalidBackupsSkipped: 1,
          unsupportedBackupsSkipped: 0,
        }}
        onDismissDatabaseRecoveryNotice={vi.fn()}
        onImportRecovery={vi.fn(async () => undefined)}
        onCopyRecoveryReport={vi.fn(async () => undefined)}
      />,
    );
    expect(nativePreviewSuspended()).toBe(true);
    view.rerender(
      <AppStatusOverlays
        providerAuth={{ ...providerAuth, provider: null }}
        appUpdate={appUpdate}
        providerQuotaNotices={providerQuotaNotices}
        error={null}
        onDismissError={vi.fn()}
        databaseRecoveryNotice={null}
        onDismissDatabaseRecoveryNotice={vi.fn()}
        onImportRecovery={vi.fn(async () => undefined)}
        onCopyRecoveryReport={vi.fn(async () => undefined)}
      />,
    );
    await expectRestored();
  });

  it("owns the activity center lifecycle", async () => {
    const props = {
      now: Date.now(),
      runs: [],
      projects: [],
      conversations: [],
      onClose: vi.fn(),
      onOpenThread: vi.fn(),
      onOpenLocation: vi.fn(),
      onOpenTerminal: vi.fn(),
      onOpenPreview: vi.fn(),
      onStop: vi.fn(),
      onRerun: vi.fn(),
      onMarkSeen: vi.fn(),
      onAcknowledge: vi.fn(),
      onDismiss: vi.fn(),
    };
    const view = render(<ActivityCenter open {...props} />);

    expect(screen.getByRole("dialog", { name: "Runs" }))
      .toBeInTheDocument();
    await expectSuspended();

    view.rerender(<ActivityCenter open={false} {...props} />);
    await expectRestored();
  });

  it("owns the command palette lifecycle", async () => {
    const props = {
      projects: [],
      conversations: [],
      newThreadShortcut: "⌘N",
      onClose: vi.fn(),
      onSelectProject: vi.fn(),
      onSelectConversation: vi.fn(),
      onNewThread: vi.fn(),
      onAddProject: vi.fn(),
      onOpenSettings: vi.fn(),
    };
    const view = render(<CommandPalette open {...props} />);

    expect(screen.getByRole("dialog", { name: "Search Inertia" }))
      .toBeInTheDocument();
    await expectSuspended();

    view.rerender(<CommandPalette open={false} {...props} />);
    await expectRestored();
  });

  it("suspends for the mounted environment summary", async () => {
    const view = render(<EnvironmentSummary summary={environmentSummary} />);

    expect(screen.getByRole("dialog", { name: "Environment summary" }))
      .toBeInTheDocument();
    await expectSuspended();

    view.unmount();
    await expectRestored();
  });

  it("suspends for the mounted route-change confirmation", async () => {
    const view = render(
      <RouteChangeConfirmation
        pendingRoute={{
          selection: nativeModelSelection({
            providerId: "codex",
            modelId: "gpt-5.6",
          }),
          label: "GPT-5.6",
          reason: "The active session cannot switch models.",
          sourceConversationId: "conversation-1",
          sourceProjectId: "project-1",
          sourceSelectionKey: "source-selection",
          sourceContinuationKey: "source-continuation",
          sourceLatestTurnId: "turn-1",
          sourceLatestTurnKey: "latest-turn",
          destinationRevision: 1,
        }}
        creating={false}
        cancelRef={createRef<HTMLButtonElement>()}
        canCreate
        onDismiss={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByRole("alertdialog", {
      name: "Open a new chat for GPT-5.6?",
    })).toBeInTheDocument();
    await expectSuspended();

    view.unmount();
    await expectRestored();
  });
});

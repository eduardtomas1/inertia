import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "../../src/renderer/src/components/Sidebar";
import type {
  AppSnapshot,
  ConversationShell,
  Project,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

const project: Project = {
  id: "project-studio",
  name: "Studio",
  path: "/workspace/acme-monorepo/apps/studio",
  normalizedPath: "/workspace/acme-monorepo/apps/studio",
  repositoryIdentity: "git:/workspace/acme-monorepo/.git",
  repositoryRoot: "/workspace/acme-monorepo",
  repositoryRelativePath: "apps/studio",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "working",
  createdAt: new Date(2026, 7, 1, 9).toISOString(),
  updatedAt: new Date(2026, 7, 11, 9).toISOString(),
};

function conversation(
  id: string,
  title: string,
  updatedAt: Date,
  overrides: Partial<ConversationShell> = {},
): ConversationShell {
  const providerId = overrides.providerId ?? "codex";
  return {
    id,
    projectId: project.id,
    title,
    providerId,
    modelSelection: nativeModelSelection({ providerId }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: updatedAt.toISOString(),
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: updatedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
    ...overrides,
  };
}

function snapshot(conversations: ConversationShell[]): AppSnapshot {
  return {
    projects: [project],
    conversations,
    runs: [],
    providers: [],
    settings: {
      ...defaultSettings,
      sidebarMode: "activity",
      providerIdentityLabels: {
        codex: "OpenAI",
        claude: "Anthropic",
      },
    },
    activeProjectId: project.id,
    activeConversationId: conversations[0]?.id ?? null,
  };
}

function renderSidebar(
  conversations: ConversationShell[],
  onSelectConversation = vi.fn(),
) {
  return {
    onSelectConversation,
    ...render(
      <Sidebar
        snapshot={snapshot(conversations)}
        connectionStatus="online"
        view="workspace"
        open
        busy={false}
        onClose={vi.fn()}
        onViewChange={vi.fn()}
        onImportProject={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectConversation={onSelectConversation}
        splitConversationId={null}
        onOpenConversationInSplit={vi.fn()}
        onCloseConversationSplit={vi.fn()}
        onCreateConversation={vi.fn()}
        onOpenMultiSpawn={vi.fn()}
        onRenameConversation={vi.fn()}
        onPinConversation={vi.fn()}
        onSnoozeConversation={vi.fn()}
        onArchiveConversation={vi.fn()}
        onSettleConversation={vi.fn()}
        onRestoreConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        onAcknowledgeRun={vi.fn()}
        onDismissRun={vi.fn()}
        onOpenProject={vi.fn()}
        onRenameProject={vi.fn()}
        onSetProjectGrouping={vi.fn()}
        onSetProjectGitRepositoryLimit={vi.fn()}
        onSidebarModeChange={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("compact Work sidebar", () => {
  it("shows chronological rows with provider, project, repository, and branch metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const recent = conversation(
      "recent",
      "Polish compact Work rows",
      new Date(2026, 7, 11, 9),
      { branch: "codex/compact-work-tab" },
    );
    const yesterday = conversation(
      "yesterday",
      "Review provider metadata",
      new Date(2026, 7, 10, 17),
      {
        providerId: "claude",
        modelSelection: nativeModelSelection({ providerId: "claude" }),
        branch: "main",
      },
    );
    const earlier = conversation(
      "earlier",
      "Earlier investigation",
      new Date(2026, 7, 6, 9),
      { branch: "fix/earlier" },
    );
    const done = conversation(
      "done",
      "Settled cleanup",
      new Date(2026, 7, 5, 9),
      { settledAt: new Date(2026, 7, 5, 10).toISOString() },
    );
    const view = renderSidebar([recent, yesterday, earlier, done]);

    expect(screen.queryByRole("group", { name: "Filter conversations" }))
      .not.toBeInTheDocument();
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Recent 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yesterday 1" })).toBeInTheDocument();

    const recentRow = screen.getByRole("button", {
      name: /Polish compact Work rows, OpenAI, Studio, Repository acme-monorepo\/apps\/studio, Branch codex\/compact-work-tab, Idle/u,
    });
    expect(recentRow).toHaveAttribute("aria-current", "page");
    expect(recentRow).toHaveTextContent("OpenAI");
    expect(recentRow).toHaveTextContent("Studio");
    expect(recentRow).toHaveTextContent("acme-monorepo/apps/studio");
    expect(recentRow).toHaveTextContent("codex/compact-work-tab");
    expect(recentRow.querySelector('[data-provider-id="codex"]')).not.toBeNull();

    const yesterdayRow = screen.getByRole("button", {
      name: /Review provider metadata, Anthropic, Studio, Repository acme-monorepo\/apps\/studio, Branch main, Idle/u,
    });
    expect(yesterdayRow.querySelector('[data-provider-id="claude"]')).not.toBeNull();

    const earlierToggle = screen.getByRole("button", { name: "Earlier 1" });
    expect(earlierToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Earlier investigation")).not.toBeInTheDocument();
    fireEvent.click(earlierToggle);
    expect(screen.getByText("Earlier investigation")).toBeInTheDocument();

    recentRow.focus();
    fireEvent.keyDown(recentRow, { key: "ArrowDown" });
    expect(yesterdayRow).toHaveFocus();

    fireEvent.click(recentRow);
    expect(view.onSelectConversation).toHaveBeenCalledWith(recent);
  });

  it("uses the lone search field across title and visible metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    renderSidebar([
      conversation("codex", "Compact rows", new Date(2026, 7, 11, 9), {
        branch: "codex/compact-work-tab",
      }),
      conversation("claude", "Review metadata", new Date(2026, 7, 10, 17), {
        providerId: "claude",
        modelSelection: nativeModelSelection({ providerId: "claude" }),
        branch: "main",
      }),
    ]);

    const search = screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    });
    fireEvent.change(search, { target: { value: "main" } });

    const work = screen.getByRole("list", { name: "Work" });
    expect(within(work).queryByText("Compact rows")).not.toBeInTheDocument();
    expect(within(work).getByText("Review metadata")).toBeInTheDocument();
  });
});

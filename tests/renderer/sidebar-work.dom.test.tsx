import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  const onSnoozeConversation = vi.fn();
  return {
    onSelectConversation,
    onSnoozeConversation,
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
        onSnoozeConversation={onSnoozeConversation}
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
      {
        branch: "codex/compact-work-tab",
        pinnedAt: new Date(2026, 7, 11, 10).toISOString(),
      },
    );
    const yesterday = conversation(
      "yesterday",
      "Review provider metadata",
      new Date(2026, 7, 10, 17),
      {
        providerId: "claude",
        modelSelection: nativeModelSelection({ providerId: "claude" }),
        branch: "main",
        status: "completed",
        completedAt: new Date(2026, 7, 10, 18).toISOString(),
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
      name: "Polish compact Work rows, OpenAI, Studio, Repository acme-monorepo/apps/studio, Branch codex/compact-work-tab, Idle, Pinned",
    });
    expect(recentRow).toHaveAttribute("aria-current", "page");
    expect(recentRow).toHaveTextContent("OpenAI");
    expect(recentRow).toHaveTextContent("Studio");
    expect(recentRow).toHaveTextContent("acme-monorepo/apps/studio");
    expect(recentRow).toHaveTextContent("codex/compact-work-tab");
    expect(recentRow.querySelector(
      '[data-provider-id="codex"][data-provider-brand="openai"][data-provider-icon-kind="official"]',
    )).not.toBeNull();

    const yesterdayRow = screen.getByRole("button", {
      name: "Review provider metadata, Anthropic, Studio, Repository acme-monorepo/apps/studio, Branch main, Completed, New completion",
    });
    expect(yesterdayRow).toHaveTextContent("New");
    expect(yesterdayRow.querySelector(
      '[data-provider-id="claude"][data-provider-brand="anthropic"][data-provider-icon-kind="official"]',
    )).not.toBeNull();

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

  it("uses the lone search field across title and visible metadata and expands matches", () => {
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
      conversation("earlier", "Audit legacy focus", new Date(2026, 7, 6, 9), {
        branch: "fix/focus",
      }),
      conversation("done", "Ship completed cleanup", new Date(2026, 7, 5, 9), {
        settledAt: new Date(2026, 7, 5, 10).toISOString(),
      }),
    ]);

    const search = screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    });
    const work = screen.getByRole("list", { name: "Work" });
    for (const query of ["main", "Anthropic", "Review metadata"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(within(work).queryByText("Compact rows")).not.toBeInTheDocument();
      expect(within(work).getByText("Review metadata")).toBeInTheDocument();
    }

    for (const query of [
      "Studio",
      "acme-monorepo",
      "apps/studio",
      "acme-monorepo/apps/studio",
    ]) {
      fireEvent.change(search, { target: { value: query } });
      expect(within(work).getByText("Compact rows")).toBeInTheDocument();
      expect(within(work).getByText("Review metadata")).toBeInTheDocument();
    }

    fireEvent.change(search, { target: { value: "legacy focus" } });
    expect(within(work).getByText("Audit legacy focus")).toBeInTheDocument();
    expect(within(work).queryByRole("button", { name: "Earlier 1" }))
      .not.toBeInTheDocument();
    expect(within(work).getByRole("heading", { name: "Earlier 1" }))
      .toBeInTheDocument();

    fireEvent.change(search, { target: { value: "completed cleanup" } });
    expect(within(work).getByText("Ship completed cleanup")).toBeInTheDocument();
    expect(within(work).queryByRole("button", { name: "Done 1" }))
      .not.toBeInTheDocument();
    expect(within(work).getByRole("heading", { name: "Done 1" }))
      .toBeInTheDocument();

    fireEvent.change(search, { target: { value: "no-such-work" } });
    expect(within(work).getByText("No matching work")).toBeInTheDocument();
    expect(within(work).queryByRole("heading")).not.toBeInTheDocument();
  });

  it("paginates Done without mounting older rows until requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const entries = Array.from({ length: 11 }, (_, index) => conversation(
      `done-${index}`,
      `Completed task ${index}`,
      new Date(2026, 7, 10 - index, 9),
      { settledAt: new Date(2026, 7, 10 - index, 10).toISOString() },
    ));
    const view = renderSidebar(entries);

    fireEvent.click(screen.getByRole("button", { name: "Done 11" }));
    const done = view.container.querySelector(".work-thread-section.is-done");
    expect(done).not.toBeNull();
    expect(done?.querySelectorAll(".activity-thread")).toHaveLength(10);

    fireEvent.click(within(done as HTMLElement).getByRole("button", {
      name: "Show more 1 older",
    }));
    expect(done?.querySelectorAll(".activity-thread")).toHaveLength(11);
  });

  it("keeps snoozed work reachable so it can be unsnoozed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const snoozed = conversation(
      "snoozed",
      "Restore this task",
      new Date(2026, 7, 11, 9),
      { snoozedUntil: new Date(2026, 7, 12, 12).toISOString() },
    );
    const view = renderSidebar([snoozed]);

    const snoozedToggle = screen.getByRole("button", { name: "Snoozed 1" });
    expect(snoozedToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Restore this task")).not.toBeInTheDocument();
    fireEvent.click(snoozedToggle);

    expect(screen.getByRole("button", {
      name: "Restore this task, OpenAI, Studio, Repository acme-monorepo/apps/studio, Idle, Snoozed",
    })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "Thread actions for Restore this task",
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
    expect(view.onSnoozeConversation).toHaveBeenCalledWith(snoozed, null);
  });

  it("refreshes local-day groups at midnight without a snapshot update", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 23, 59, 59, 900);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("today", "Finish before midnight", new Date(2026, 7, 11, 12)),
    ]);

    expect(screen.getByRole("heading", { name: "Recent 1" }))
      .toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.queryByRole("heading", { name: "Recent 1" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yesterday 1" }))
      .toBeInTheDocument();
  });

  it("keeps empty and missing-project states explicit", () => {
    const emptyView = renderSidebar([]);
    expect(screen.getByText("No work yet")).toBeInTheDocument();
    emptyView.unmount();

    const missingProject = conversation(
      "missing-project",
      "Recover detached work",
      new Date(2026, 7, 11, 9),
      { projectId: "missing" },
    );
    renderSidebar([missingProject]);
    const row = screen.getByRole("button", {
      name: "Recover detached work, OpenAI, Unknown project, Idle",
    });
    expect(row).toHaveTextContent("Unknown project");

    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "Unknown project" } });
    expect(row).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Studio" } });
    expect(screen.getByText("No matching work")).toBeInTheDocument();
  });

  it("uses a distinct non-color icon for every Work status", () => {
    const statusCases = [
      ["working", "running", null, "lucide-circle-dot"],
      ["approval", "needs-input", "approval", "lucide-shield-alert"],
      ["input", "needs-input", "input", "lucide-message-circle-question-mark"],
      ["failed", "failed", null, "lucide-circle-x"],
      ["completed", "completed", null, "lucide-circle-check"],
      ["idle", "idle", null, "lucide-minus"],
    ] as const;
    renderSidebar(statusCases.map(([id, status, attentionKind]) => conversation(
      id,
      `${id} task`,
      new Date(2026, 7, 11, 9),
      { status, attentionKind },
    )));

    for (const [id, , , iconClass] of statusCases) {
      const cue = document.querySelector(`[data-work-status="${id}"]`);
      expect(cue).not.toBeNull();
      expect(cue?.querySelector(`.${iconClass}`)).not.toBeNull();
    }
  });
});

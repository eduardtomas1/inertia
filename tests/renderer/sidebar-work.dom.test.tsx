import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "../../src/renderer/src/components/Sidebar";
import type {
  AppSnapshot,
  ConversationShell,
  Project,
  WorkspaceRun,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

const SIDEBAR_WORK_SECTIONS_STORAGE_KEY = "inertia:sidebar:work-sections:v1";

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

function snapshot(
  conversations: ConversationShell[],
  runs: WorkspaceRun[] = [],
  projects: Project[] = [project],
): AppSnapshot {
  return {
    projects,
    conversations,
    runs,
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

function dismissedRun(conversation: ConversationShell): WorkspaceRun {
  return {
    id: `run-${conversation.id}`,
    kind: "agent",
    projectId: conversation.projectId,
    conversationId: conversation.id,
    actionId: null,
    label: conversation.title,
    detail: null,
    status: "failed",
    attentionState: "dismissed",
    canStop: false,
    port: null,
    startedAt: conversation.updatedAt,
    finishedAt: new Date(Date.parse(conversation.updatedAt) + 60_000).toISOString(),
  };
}

function renderSidebar(
  conversations: ConversationShell[],
  onSelectConversation = vi.fn(),
  runs: WorkspaceRun[] = [],
  options: {
    projects?: Project[];
    sidebarMode?: AppSnapshot["settings"]["sidebarMode"];
    splitConversationId?: string | null;
  } = {},
) {
  const onSnoozeConversation = vi.fn();
  const sidebarProps = {
    connectionStatus: "online" as const,
    view: "workspace" as const,
    open: true,
    busy: false,
    layoutWidth: 276,
    onClose: vi.fn(),
    onViewChange: vi.fn(),
    onImportProject: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectConversation,
    splitConversationId: options.splitConversationId ?? null,
    onOpenConversationInSplit: vi.fn(),
    onCloseConversationSplit: vi.fn(),
    onCreateConversation: vi.fn(),
    onOpenMultiSpawn: vi.fn(),
    onRenameConversation: vi.fn(),
    onPinConversation: vi.fn(),
    onSnoozeConversation,
    onArchiveConversation: vi.fn(),
    onSettleConversation: vi.fn(),
    onRestoreConversation: vi.fn(),
    onDeleteConversation: vi.fn(),
    onAcknowledgeRun: vi.fn(),
    onDismissRun: vi.fn(),
    onOpenProject: vi.fn(),
    onRenameProject: vi.fn(),
    onSetProjectGrouping: vi.fn(),
    onSetProjectGitRepositoryLimit: vi.fn(),
    onSidebarModeChange: vi.fn(),
    onRemoveProject: vi.fn(),
  };
  const initialSnapshot = snapshot(conversations, runs, options.projects);
  const view = render(
    <Sidebar
      snapshot={{
        ...initialSnapshot,
        settings: {
          ...initialSnapshot.settings,
          sidebarMode: options.sidebarMode ?? initialSnapshot.settings.sidebarMode,
        },
      }}
      {...sidebarProps}
    />,
  );
  return {
    onSelectConversation,
    onSnoozeConversation,
    rerenderSnapshot(nextSnapshot: AppSnapshot) {
      view.rerender(<Sidebar snapshot={nextSnapshot} {...sidebarProps} />);
    },
    ...view,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(SIDEBAR_WORK_SECTIONS_STORAGE_KEY);
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

  it("keeps Work row action focus inside its menu and dismisses it predictably", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const menuConversation = conversation(
      "menu-focus",
      "Keyboard menu work",
      new Date(2026, 7, 11, 9),
    );
    const view = renderSidebar([menuConversation]);

    const trigger = screen.getByRole("button", {
      name: "Thread actions for Keyboard menu work",
    });
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    });
    const rename = within(menu).getByRole("menuitem", { name: "Rename" });
    const pin = within(menu).getByRole("menuitem", { name: "Pin" });
    const remove = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(rename).toHaveFocus();
    expect(rename).toHaveAttribute("tabindex", "-1");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    view.rerenderSnapshot(snapshot([{ ...menuConversation }]));
    expect(screen.getByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    })).toBeInTheDocument();
    expect(rename).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(rename, { key: "ArrowDown" });
    expect(pin).toHaveFocus();
    fireEvent.keyDown(pin, { key: "End" });
    expect(remove).toHaveFocus();
    fireEvent.keyDown(remove, { key: "Home" });
    expect(rename).toHaveFocus();

    fireEvent.keyDown(rename, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(within(screen.getByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    })).getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    fireEvent.pointerDown(screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    }));
    expect(screen.queryByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    })).not.toBeInTheDocument();
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
    const work = view.container.querySelector(".activity-thread-stream");
    expect(work).not.toBeNull();
    expect(work?.querySelectorAll(".activity-thread")).toHaveLength(10);

    const showMore = within(work as HTMLElement).getByRole("button", {
      name: "Show more 1 older",
    });
    showMore.focus();
    fireEvent.click(showMore);
    expect(work?.querySelectorAll(".activity-thread")).toHaveLength(11);
    expect(screen.getByRole("button", { name: /^Completed task 10,/ })).toHaveFocus();
  });

  it("persists expanded secondary sections across sidebar remounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const earlier = conversation(
      "persisted-earlier",
      "Keep earlier work open",
      new Date(2026, 7, 6, 9),
    );
    const firstView = renderSidebar([earlier]);

    fireEvent.click(screen.getByRole("button", { name: "Earlier 1" }));
    expect(screen.getByText("Keep earlier work open")).toBeInTheDocument();
    firstView.unmount();

    renderSidebar([earlier]);
    expect(screen.getByRole("button", { name: "Earlier 1" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Keep earlier work open")).toBeInTheDocument();
  });

  it("ignores corrupt and unknown persisted section identifiers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const earlier = conversation(
      "safe-persistence",
      "Recover safe section state",
      new Date(2026, 7, 6, 9),
    );
    window.localStorage.setItem(SIDEBAR_WORK_SECTIONS_STORAGE_KEY, "not-json");
    const corruptView = renderSidebar([earlier]);
    expect(screen.getByRole("button", { name: "Earlier 1" }))
      .toHaveAttribute("aria-expanded", "false");
    corruptView.unmount();

    window.localStorage.setItem(
      SIDEBAR_WORK_SECTIONS_STORAGE_KEY,
      "recent,unknown,earlier",
    );
    renderSidebar([earlier]);
    expect(screen.getByRole("button", { name: "Earlier 1" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(window.localStorage.getItem(SIDEBAR_WORK_SECTIONS_STORAGE_KEY))
      .toBe("earlier");
  });

  it("virtualizes large Work indexes while retaining list position metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `virtual-${index}`,
      `Virtual work ${index}`,
      new Date(2026, 7, 11, 11, 59 - index),
    ));
    const view = renderSidebar(entries);

    const stream = view.container.querySelector<HTMLElement>(
      ".activity-thread-stream",
    );
    expect(stream).toHaveAttribute("data-work-index-virtualized", "true");
    const mountedRows = stream?.querySelectorAll(".activity-thread") ?? [];
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(entries.length);
    expect(mountedRows[0]).toHaveAttribute("aria-posinset");
    expect(mountedRows[0]).toHaveAttribute("aria-setsize", "80");
    expect(screen.getByRole("button", { name: /^Virtual work 0,/ }))
      .toHaveAttribute("aria-current", "page");
  });

  it("refreshes a virtualized Work window when its viewport grows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    let notifyResize = (): void => undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }

      observe(): void {}
      disconnect(): void {}
    });
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `resize-${index}`,
      `Resizable work ${index}`,
      new Date(2026, 7, 11, 11, 59 - index),
    ));
    const view = renderSidebar(entries);
    const navigation = view.container.querySelector<HTMLElement>(".project-list");
    const stream = view.container.querySelector<HTMLElement>(
      ".activity-thread-stream",
    );
    expect(navigation).not.toBeNull();
    expect(stream).not.toBeNull();
    const initialRows = stream?.querySelectorAll(".activity-thread").length ?? 0;

    Object.defineProperty(navigation, "clientHeight", {
      configurable: true,
      value: 2_400,
    });
    act(() => notifyResize());

    const resizedRows = stream?.querySelectorAll(".activity-thread").length ?? 0;
    expect(resizedRows).toBeGreaterThan(initialRows);
  });

  it("measures a large Work index when switching from Projects", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe = observe;
      disconnect = disconnect;
    });
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `mode-viewport-${index}`,
      `Mode viewport work ${index}`,
      new Date(2026, 7, 11, 11, 59 - index),
    ));
    const view = renderSidebar(entries, vi.fn(), [], { sidebarMode: "classic" });
    const navigation = view.container.querySelector<HTMLElement>(".project-list");
    expect(navigation).not.toBeNull();
    expect(observe).not.toHaveBeenCalled();
    Object.defineProperty(navigation, "clientHeight", {
      configurable: true,
      value: 2_400,
    });

    view.rerenderSnapshot(snapshot(entries));

    const stream = view.container.querySelector<HTMLElement>(
      ".activity-thread-stream",
    );
    expect(stream).toHaveAttribute("data-work-index-virtualized", "true");
    expect(stream?.querySelectorAll(".activity-thread").length).toBeGreaterThan(40);
    expect(observe).toHaveBeenCalledWith(navigation);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("keeps classic row actions outside the virtual Work window usable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `classic-actions-${index}`,
      `Classic actions ${index}`,
      new Date(2026, 7, 11, 11, 59 - index),
    ));
    renderSidebar(entries, vi.fn(), [], { sidebarMode: "classic" });

    fireEvent.click(screen.getByRole("button", {
      name: "Thread actions for Classic actions 79",
    }));
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    expect(rename).toBeInTheDocument();
    fireEvent.click(rename);

    expect(screen.getByRole("textbox", { name: "Rename Classic actions 79" }))
      .toHaveFocus();
  });

  it("keeps Home and End keyboard navigation working across virtual windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `keyboard-${index}`,
      `Keyboard work ${index}`,
      new Date(2026, 7, 11, 11, 59 - index),
    ));
    renderSidebar(entries);

    const first = screen.getByRole("button", { name: /^Keyboard work 0,/ });
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const last = screen.getByRole("button", { name: /^Keyboard work 79,/ });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: "Home" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("button", { name: /^Keyboard work 0,/ }))
      .toHaveFocus();
  });

  it("keeps project and split-workspace identity explicit in compact rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const docsProject: Project = {
      ...project,
      id: "project-docs",
      name: "Docs",
      path: "/workspace/acme-monorepo/apps/docs",
      normalizedPath: "/workspace/acme-monorepo/apps/docs",
      repositoryRelativePath: "apps/docs",
      color: "#288064",
    };
    const studioThread = conversation(
      "studio-thread",
      "Polish Studio",
      new Date(2026, 7, 11, 11),
    );
    const docsThread = conversation(
      "docs-thread",
      "Polish Docs",
      new Date(2026, 7, 11, 10),
      { projectId: docsProject.id },
    );
    const view = renderSidebar(
      [studioThread, docsThread],
      vi.fn(),
      [],
      { projects: [project, docsProject], splitConversationId: docsThread.id },
    );

    expect(screen.getByRole("button", {
      name: "Polish Studio, OpenAI, Studio, Repository acme-monorepo/apps/studio, Idle",
    })).toBeInTheDocument();
    const docsRow = screen.getByRole("button", {
      name: "Polish Docs, OpenAI, Docs, Repository acme-monorepo/apps/docs, Idle, Open in split view",
    });
    expect(docsRow).toHaveTextContent("Docs");
    expect(docsRow.closest(".activity-thread")).toHaveClass("is-split");
    expect(within(docsRow).getByLabelText("Open in split view"))
      .toBeInTheDocument();
    expect(view.container.querySelectorAll(".activity-thread")).toHaveLength(2);
  });

  it("does not reopen a row menu after its Work section is collapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    renderSidebar([
      conversation("earlier", "Earlier menu work", new Date(2026, 7, 6, 9)),
    ]);

    const earlierToggle = screen.getByRole("button", { name: "Earlier 1" });
    fireEvent.click(earlierToggle);
    fireEvent.click(screen.getByRole("button", {
      name: "Thread actions for Earlier menu work",
    }));
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();

    fireEvent.click(earlierToggle);
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    fireEvent.click(earlierToggle);
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("clears a row menu when automatic regrouping hides its owner", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("expiring", "Hidden after snooze", new Date(2026, 7, 6, 9), {
        snoozedUntil: new Date(start.getTime() + 100).toISOString(),
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
    fireEvent.click(screen.getByRole("button", {
      name: "Thread actions for Hidden after snooze",
    }));
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Earlier 1" }));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("does not retain a Work row menu across sidebar mode changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const work = conversation(
      "mode-change",
      "Switch sidebar modes",
      new Date(2026, 7, 11, 9),
    );
    const view = renderSidebar([work]);

    fireEvent.click(screen.getByRole("button", {
      name: "Thread actions for Switch sidebar modes",
    }));
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();

    const workSnapshot = snapshot([work]);
    view.rerenderSnapshot({
      ...workSnapshot,
      settings: { ...workSnapshot.settings, sidebarMode: "classic" },
    });
    view.rerenderSnapshot(workSnapshot);

    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("clears Work-only metadata searches when switching to Projects", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const work = conversation(
      "metadata-mode-change",
      "Search metadata before switching",
      new Date(2026, 7, 11, 9),
      { branch: "codex/work-only-branch" },
    );
    const view = renderSidebar([work]);

    fireEvent.change(screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    }), { target: { value: "work-only-branch" } });
    expect(screen.getByRole("button", { name: /^Search metadata before switching,/ }))
      .toBeInTheDocument();

    const workSnapshot = snapshot([work]);
    view.rerenderSnapshot({
      ...workSnapshot,
      settings: { ...workSnapshot.settings, sidebarMode: "classic" },
    });

    expect(screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    })).toHaveValue("");
    expect(screen.queryByText("No matching projects")).not.toBeInTheDocument();
    expect(screen.getByText("Search metadata before switching")).toBeInTheDocument();
  });

  it("ends a row rename when automatic regrouping hides its owner", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("existing", "Existing recent work", new Date(2026, 7, 11, 10)),
      conversation("expiring", "Rename before expiry", new Date(2026, 7, 6, 9), {
        snoozedUntil: new Date(start.getTime() + 100).toISOString(),
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
    fireEvent.click(screen.getByRole("button", {
      name: "Thread actions for Rename before expiry",
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Rename Rename before expiry" }))
      .toHaveFocus();

    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.queryByRole("textbox", { name: "Rename Rename before expiry" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Earlier 1" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Earlier 1" }));
    expect(screen.queryByRole("textbox", { name: "Rename Rename before expiry" }))
      .not.toBeInTheDocument();
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
    const view = renderSidebar([snoozed], vi.fn(), [dismissedRun(snoozed)]);

    const snoozedToggle = screen.getByRole("button", { name: "Snoozed 1" });
    expect(snoozedToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Restore this task")).not.toBeInTheDocument();
    fireEvent.click(snoozedToggle);

    expect(screen.getByRole("button", {
      name: "Restore this task, OpenAI, Studio, Repository acme-monorepo/apps/studio, Failed, Snoozed",
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
    screen.getByRole("button", { name: /^Finish before midnight,/ }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.queryByRole("heading", { name: "Recent 1" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yesterday 1" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Finish before midnight,/ }))
      .toHaveFocus();
  });

  it("moves focus to the collapsed section that receives regrouped rows", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 23, 59, 59, 900);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("yesterday-first", "First yesterday task", new Date(2026, 7, 10, 10)),
      conversation("yesterday-second", "Second yesterday task", new Date(2026, 7, 10, 9)),
      conversation("done", "Completed task", new Date(2026, 7, 9, 9), {
        settledAt: new Date(2026, 7, 9, 10).toISOString(),
      }),
    ]);

    screen.getByRole("button", { name: /^Second yesterday task,/ }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(screen.getByRole("button", { name: "Earlier 2" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Done 1" })).not.toHaveFocus();
  });

  it("does not reclaim focus after the user points outside Work", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 23, 59, 59, 900);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("today", "Leave Work before midnight", new Date(2026, 7, 11, 12)),
    ]);

    const row = screen.getByRole("button", { name: /^Leave Work before midnight,/ });
    row.focus();
    fireEvent.pointerDown(document.body);
    row.blur();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(screen.getByRole("button", { name: /^Leave Work before midnight,/ }))
      .not.toHaveFocus();
    expect(screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    })).not.toHaveFocus();
  });

  it("does not reclaim focus after the user points at blank sidebar space", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 23, 59, 59, 900);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("today", "Leave Work inside the sidebar", new Date(2026, 7, 11, 12)),
    ]);

    const row = screen.getByRole("button", { name: /^Leave Work inside the sidebar,/ });
    row.focus();
    fireEvent.pointerDown(screen.getByLabelText("Project navigation"));
    row.blur();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(screen.getByRole("button", { name: /^Leave Work inside the sidebar,/ }))
      .not.toHaveFocus();
    expect(screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    })).not.toHaveFocus();
  });

  it("moves focus from a disappearing Snoozed disclosure to the regrouped row", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("existing", "Existing recent work", new Date(2026, 7, 11, 10)),
      conversation("expiring", "Snooze expires now", new Date(2026, 7, 11, 9), {
        snoozedUntil: new Date(start.getTime() + 100).toISOString(),
      }),
    ]);

    screen.getByRole("button", { name: "Snoozed 1" }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(screen.queryByRole("button", { name: "Snoozed 1" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Snooze expires now,/ }))
      .toHaveFocus();
  });

  it("moves a disappearing disclosure to its collapsed destination section", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("expiring", "Old snooze expires", new Date(2026, 7, 6, 9), {
        snoozedUntil: new Date(start.getTime() + 100).toISOString(),
      }),
      conversation("done", "Completed task", new Date(2026, 7, 5, 9), {
        settledAt: new Date(2026, 7, 5, 10).toISOString(),
      }),
    ]);

    screen.getByRole("button", { name: "Snoozed 1" }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(screen.getByRole("button", { name: "Earlier 1" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Done 1" })).not.toHaveFocus();
  });

  it("tracks the remaining owner of a disclosure across staggered regrouping", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("first-expiring", "First snooze expires", new Date(2026, 7, 11, 9), {
        snoozedUntil: new Date(start.getTime() + 100).toISOString(),
      }),
      conversation("last-expiring", "Last snooze expires", new Date(2026, 7, 6, 9), {
        snoozedUntil: new Date(start.getTime() + 200).toISOString(),
      }),
      conversation("done", "Completed task", new Date(2026, 7, 5, 9), {
        settledAt: new Date(2026, 7, 5, 10).toISOString(),
      }),
    ]);

    screen.getByRole("button", { name: "Snoozed 2" }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.getByRole("button", { name: "Snoozed 1" })).toHaveFocus();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("button", { name: "Earlier 1" })).toHaveFocus();
    expect(screen.getByRole("button", { name: /^First snooze expires,/ }))
      .not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Done 1" })).not.toHaveFocus();
  });

  it("refreshes a surviving disclosure's fallback position before it disappears", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    const dismissed = conversation(
      "dismissed-last",
      "Dismissed snooze expires last",
      new Date(2026, 7, 6, 9),
      { snoozedUntil: new Date(start.getTime() + 200).toISOString() },
    );
    renderSidebar([
      conversation("first-expiring", "First snooze expires", new Date(2026, 7, 11, 9), {
        snoozedUntil: new Date(start.getTime() + 100).toISOString(),
      }),
      dismissed,
      conversation("done", "Completed task", new Date(2026, 7, 5, 9), {
        settledAt: new Date(2026, 7, 5, 10).toISOString(),
      }),
    ], vi.fn(), [dismissedRun(dismissed)]);

    screen.getByRole("button", { name: "Snoozed 2" }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.getByRole("button", { name: "Snoozed 1" })).toHaveFocus();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("button", { name: "Done 1" })).toHaveFocus();
    expect(screen.getByRole("button", {
      name: "Thread actions for First snooze expires",
    })).not.toHaveFocus();
  });

  it("retains row action menu focus while its Work owner regroups", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("existing", "Existing recent work", new Date(2026, 7, 11, 10)),
      conversation("expiring", "Menu snooze expires", new Date(2026, 7, 11, 9), {
        snoozedUntil: new Date(start.getTime() + 100).toISOString(),
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
    const trigger = screen.getByRole("button", {
      name: "Thread actions for Menu snooze expires",
    });
    fireEvent.click(trigger);
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    rename.focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(rename).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("moves focus to search when an expired dismissed snooze leaves Work", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    const snoozed = conversation(
      "dismissed-expiring",
      "Dismissed snooze expires",
      new Date(2026, 7, 11, 9),
      { snoozedUntil: new Date(start.getTime() + 100).toISOString() },
    );
    renderSidebar([snoozed], vi.fn(), [dismissedRun(snoozed)]);

    fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
    screen.getByRole("button", { name: /^Dismissed snooze expires,/ }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(screen.queryByRole("button", { name: /^Dismissed snooze expires,/ }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    })).toHaveFocus();
  });

  it("moves focus to the nearest remaining control when dismissed Work disappears", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 12);
    vi.setSystemTime(start);
    const snoozed = conversation(
      "dismissed-expiring",
      "Dismissed snooze expires",
      new Date(2026, 7, 11, 9),
      { snoozedUntil: new Date(start.getTime() + 100).toISOString() },
    );
    renderSidebar([
      conversation("existing", "Existing recent work", new Date(2026, 7, 11, 10)),
      snoozed,
    ], vi.fn(), [dismissedRun(snoozed)]);

    fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
    screen.getByRole("button", { name: /^Dismissed snooze expires,/ }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });

    expect(screen.getByRole("button", {
      name: "Thread actions for Existing recent work",
    })).toHaveFocus();
  });

  it("keeps empty and missing-project states explicit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
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

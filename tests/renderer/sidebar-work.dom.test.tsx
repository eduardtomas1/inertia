import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadThreadActions } from "../../src/renderer/src/components/sidebar/threadActionLoader";

import { Sidebar } from "../../src/renderer/src/components/Sidebar";
import type { SidebarProps } from "../../src/renderer/src/components/sidebar/SidebarProps";
import { useProjectScope } from "../../src/renderer/src/hooks/useProjectScope";
import { currentChatDrag } from "../../src/renderer/src/utils/chatDrag";
import type {
  AppSnapshot,
  ConversationShell,
  Project,
  WorkspaceRun,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { INTERFACE_LOCALE } from "../../src/renderer/src/lib/locale";
import { WATCHED_ID, WATCHER_ID, link } from "./watcher-fixtures";
import type { WatcherLinkView } from "../../src/shared/watcher";
import { resetWatcherDockStore, watcherDockStorageKey } from "../../src/renderer/src/hooks/useWatcherDock";

const SIDEBAR_WORK_SECTIONS_STORAGE_KEY = "inertia:sidebar:work-sections:v1";
beforeAll(async () => { await loadThreadActions(); });

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
    modelSelection: providerNativeModelSelection({ providerId }),
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

function ScopedSidebar({
  collapsed = false,
  ...props
}: Omit<SidebarProps, "projectScopeId" | "onProjectScopeChange"> & { collapsed?: boolean }) {
  const [projectScopeId, setProjectScopeId] = useProjectScope(props.snapshot);
  return collapsed ? null : <Sidebar {...props} projectScopeId={projectScopeId} onProjectScopeChange={setProjectScopeId} />;
}

function renderSidebar(
  conversations: ConversationShell[],
  onSelectConversation = vi.fn(),
  runs: WorkspaceRun[] = [],
  options: {
    projects?: Project[];
    splitConversationId?: string | null;
    detachedConversationIds?: ReadonlySet<string>;
    dailyWorkOpen?: boolean;
    view?: "workspace" | "settings" | "usage" | "tasks" | "home";
  } = {},
) {
  const onSnoozeConversation = vi.fn();
  const onOpenDailyWork = vi.fn();
  const onClose = vi.fn();
  const onViewChange = vi.fn();
  const sidebarProps = {
    connectionStatus: "online" as const,
    view: options.view ?? "workspace" as const,
    open: true,
    busy: false,
    layoutWidth: 276,
    onClose,
    onViewChange,
    onOpenHome: vi.fn(),
    onImportProject: vi.fn(),
    onSelectConversation,
    splitConversationIds: new Set(options.splitConversationId ? [options.splitConversationId] : []),
    detachedConversationIds: options.detachedConversationIds,
    onOpenConversationInSplit: vi.fn(),
    onCloseConversationSplit: vi.fn(),
    onCreateConversation: vi.fn(),
    onChooseNewChatProject: vi.fn(),
    onOpenMultiSpawn: vi.fn(),
    onOpenDailyWork,
    dailyWorkOpen: options.dailyWorkOpen ?? false,
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
    onRemoveProject: vi.fn(),
  };
  const initialSnapshot = snapshot(conversations, runs, options.projects);
  const view = render(
    <ScopedSidebar
      snapshot={initialSnapshot}
      {...sidebarProps}
    />,
  );
  return {
    onCreateConversation: sidebarProps.onCreateConversation,
    onRenameConversation: sidebarProps.onRenameConversation,
    onRenameProject: sidebarProps.onRenameProject,
    onChooseNewChatProject: sidebarProps.onChooseNewChatProject,
    onSelectConversation,
    onSnoozeConversation,
    onOpenDailyWork,
    onClose,
    onViewChange,
    rerenderSnapshot(nextSnapshot: AppSnapshot, collapsed = false) {
      view.rerender(<ScopedSidebar snapshot={nextSnapshot} collapsed={collapsed} {...sidebarProps} />);
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
  it("shows project-free chats separately only while matching chats exist", () => {
    const scratch: Project = { ...project, id: "scratch", name: "No project", workspaceKind: "scratch" };
    const ordinary = conversation("ordinary", "Build the app", new Date());
    const free = conversation("free", "Weekend plans", new Date(), { projectId: scratch.id });
    const view = renderSidebar([ordinary], undefined, [], { projects: [project, scratch] });
    expect(screen.queryByRole("heading", { name: /No project/ })).not.toBeInTheDocument();
    view.rerenderSnapshot(snapshot([ordinary, free], [], [project, scratch]));
    expect(screen.getByRole("heading", { name: "No project 1" })).toBeVisible();
    const freeRow = screen.getByRole("button", { name: /^Weekend plans,/ });
    expect(freeRow.closest("[data-work-section]")).toHaveAttribute("data-work-section", "no-project");
    expect(freeRow.querySelector(".activity-thread-projectline")).toHaveTextContent(/^Chat folder$/u);
    expect(freeRow).toHaveAccessibleName(/, No project,/u);
    expect(screen.getByRole("button", { name: /^Build the app,/ }).querySelector(".activity-thread-projectline"))
      .toHaveTextContent("acme-monorepo/apps/studio");
    expect(screen.getByRole("button", { name: /^Build the app,/ }).closest("[data-work-section]"))
      .toHaveAttribute("data-work-section", "recent");
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    expect(screen.queryByRole("option", { name: /No project/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Studio/ }));
    expect(screen.getByRole("heading", { name: "No project 1" })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Build the app" } });
    expect(screen.queryByRole("heading", { name: /No project/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    view.rerenderSnapshot(snapshot([ordinary, { ...free, archivedAt: new Date().toISOString() }], [], [project, scratch]));
    expect(screen.queryByRole("heading", { name: /No project/ })).not.toBeInTheDocument();
  });

  it("navigates into a separate project-free section beyond the virtualized viewport", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 7, 11, 12);
    vi.setSystemTime(now);
    const scratch: Project = { ...project, id: "scratch", name: "No project", workspaceKind: "scratch" };
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `project-${index}`, `Project task ${index}`, now,
    ));
    const free = conversation("free", "Weekend plans", now, { projectId: scratch.id });
    renderSidebar([...entries, free], undefined, [], { projects: [project, scratch] });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Project task 0,/ }), { key: "End" });
    act(() => { vi.advanceTimersByTime(100); });
    const target = screen.getByRole("button", { name: /^Weekend plans,/ });
    expect(target).toHaveFocus();
    expect(target.closest("[data-work-section]"))
      .toHaveAttribute("data-work-section", "no-project");
    expect(target.closest("[role=listitem]"))
      .toHaveAttribute("aria-posinset", "81");
  });

  it("keeps settled project-free chats out of project Done and paginates them independently", () => {
    const now = new Date();
    const scratch: Project = { ...project, id: "scratch", name: "No project", workspaceKind: "scratch" };
    const ordinary = conversation("ordinary", "Project task", now, { settledAt: now.toISOString() });
    const free = Array.from({ length: 11 }, (_, index) => conversation(`free-${index}`, `Plan ${index}`, now, {
      projectId: scratch.id, settledAt: now.toISOString(),
    }));
    renderSidebar([ordinary, ...free], undefined, [], { projects: [project, scratch] });
    expect(screen.getByRole("heading", { name: "No project 11" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Done 1" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Done 11, No project" }));
    expect(document.querySelectorAll('[data-work-section="no-project-done"]')).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /^Project task,/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more 1 older" }));
    expect(document.querySelectorAll('[data-work-section="no-project-done"]')).toHaveLength(11);
  });

  it("says there are no projects when only the folder for chats without a project exists", () => {
    const scratch: Project = { ...project, id: "scratch", name: "No project", workspaceKind: "scratch" };
    renderSidebar([], undefined, [], { projects: [scratch] });
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  it("pages project Done and project-free Done separately", () => {
    const now = new Date();
    const scratch: Project = { ...project, id: "scratch", name: "No project", workspaceKind: "scratch" };
    const ordinary = Array.from({ length: 11 }, (_, index) => conversation(`ordinary-${index}`, `Task ${index}`, now, {
      settledAt: now.toISOString(),
    }));
    const free = Array.from({ length: 12 }, (_, index) => conversation(`free-${index}`, `Plan ${index}`, now, {
      projectId: scratch.id, settledAt: now.toISOString(),
    }));
    renderSidebar([...ordinary, ...free], undefined, [], { projects: [project, scratch] });
    fireEvent.click(screen.getByRole("button", { name: "Done 11" }));
    fireEvent.click(screen.getByRole("button", { name: "Done 12, No project" }));
    expect(document.querySelectorAll('[data-work-section="done"]')).toHaveLength(10);
    expect(document.querySelectorAll('[data-work-section="no-project-done"]')).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show more 1 older" }));
    expect(document.querySelectorAll('[data-work-section="done"]')).toHaveLength(11);
    expect(document.querySelectorAll('[data-work-section="no-project-done"]')).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Show more 2 older" })).toBeVisible();
  });

  it("keeps snoozed project-free chats separate and restores keyboard focus when they wake", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 7, 11, 12);
    vi.setSystemTime(now);
    const scratch: Project = { ...project, id: "scratch", name: "No project", workspaceKind: "scratch" };
    const free = conversation("free", "Weekend plans", now, {
      projectId: scratch.id, snoozedUntil: new Date(now.getTime() + 60_000).toISOString(),
    });
    const view = renderSidebar([free], undefined, [], { projects: [project, scratch] });
    expect(screen.getByRole("heading", { name: "No project 1" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Weekend plans,/ })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Snoozed 1, No project" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /^Weekend plans,/ }).closest("[data-work-section]"))
      .toHaveAttribute("data-work-section", "no-project-snoozed");
    toggle.focus();
    view.rerenderSnapshot(snapshot([{ ...free, snoozedUntil: null }], [], [project, scratch]));
    expect(screen.queryByRole("button", { name: "Snoozed 1, No project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Weekend plans,/ })).toHaveFocus();
  });

  it("opens Daily work from the footer above Usage and Settings", () => {
    const view = renderSidebar([]);
    const footerButtons = within(view.container.querySelector(".sidebar-footer")!)
      .getAllByRole("button");

    expect(footerButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Daily work",
      "Usage",
      "Settings",
      "Help",
    ]);
    const dailyWork = screen.getByRole("button", { name: "Daily work" });
    expect(dailyWork.querySelector(".daily-work-mark")).toHaveAttribute("aria-hidden", "true");
    expect(dailyWork).toHaveAttribute("aria-haspopup", "dialog");
    expect(dailyWork).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(dailyWork);
    expect(view.onOpenDailyWork).toHaveBeenCalledTimes(1);
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.unmount();

    renderSidebar([], vi.fn(), [], { dailyWorkOpen: true });
    expect(screen.getByRole("button", { name: "Daily work" })).toHaveAttribute("aria-expanded", "true");
  });

  it("opens Tasks from its own labelled row between New chat and Search", () => {
    const view = renderSidebar([]);
    const primaryRow = view.container.querySelector<HTMLElement>(".sidebar-primary-row")!;
    expect(within(primaryRow).queryByRole("button", { name: "Tasks" })).toBeNull();
    const tasks = screen.getByRole("button", { name: "Tasks" });
    expect(tasks).toHaveClass("sidebar-primary-action");
    expect(tasks).not.toHaveAttribute("aria-label");
    expect(tasks.querySelector("span")).toHaveTextContent(/^Tasks$/u);
    expect(tasks.querySelector(".lucide-list-todo")).toHaveAttribute("aria-hidden", "true");
    expect(tasks.previousElementSibling).toBe(primaryRow);
    expect(tasks.nextElementSibling).toHaveClass("sidebar-search-wrap");
    const order = [...view.container.querySelectorAll<HTMLElement>("button, input")]
      .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim());
    const start = order.indexOf("New chat");
    expect(order.slice(start, start + 4)).toEqual(["New chat", "Launch two chats", "Tasks", "Search projects and conversations"]);
    expect(tasks).not.toHaveAttribute("aria-current");
    expect(tasks).not.toHaveClass("is-active");
    fireEvent.click(tasks);
    expect(view.onViewChange).toHaveBeenCalledWith("tasks");
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.unmount();

    renderSidebar([], vi.fn(), [], { view: "tasks" });
    const active = screen.getByRole("button", { name: "Tasks" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active).toHaveClass("is-active");
  });

  it("keeps the repository label in the original path case for Windows projects", () => {
    const windowsProject: Project = {
      ...project,
      id: "project-web",
      name: "Web",
      path: "C:\\Src\\MyMonorepo\\packages\\Web",
      normalizedPath: "c:/src/mymonorepo/packages/web",
      repositoryIdentity: "git:c:/src/mymonorepo/.git",
      repositoryRoot: "c:/src/mymonorepo",
      repositoryRelativePath: "packages/web",
    };
    const row = conversation("web", "Ship the web app", new Date(), { projectId: windowsProject.id });
    renderSidebar([row], undefined, [], { projects: [windowsProject] });
    expect(screen.getByRole("button", { name: /^Ship the web app,/ }).querySelector(".activity-thread-projectline"))
      .toHaveTextContent("MyMonorepo/packages/Web");
  });

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
        modelSelection: providerNativeModelSelection({ providerId: "claude" }),
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
    expect(screen.queryByRole("heading", { name: "Recent 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Yesterday 1" })).not.toBeInTheDocument();

    const recentRow = screen.getByRole("button", {
      name: "Polish compact Work rows, OpenAI, Studio, Repository acme-monorepo/apps/studio, Branch codex/compact-work-tab, Idle, Pinned",
    });
    expect(recentRow).toHaveAttribute("aria-current", "page");
    expect(recentRow).toHaveAccessibleName(expect.stringContaining("OpenAI"));
    expect(recentRow).toHaveTextContent("Studio");
    expect(recentRow).toHaveAccessibleName(expect.stringContaining("acme-monorepo/apps/studio"));
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
    expect(view.onViewChange).toHaveBeenCalledBefore(view.onSelectConversation);
  });

  it("keeps chats from several projects in one time order, each row naming its project", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const docsProject: Project = { ...project, id: "project-docs", name: "Docs", path: "/workspace/docs" };
    const studioNewest = conversation("studio-newest", "Studio newest", new Date(2026, 7, 11, 11));
    const docsMiddle = conversation("docs-middle", "Docs middle", new Date(2026, 7, 11, 10), { projectId: docsProject.id });
    const studioOlder = conversation("studio-older", "Studio older", new Date(2026, 7, 11, 9));
    const docsYesterday = conversation("docs-yesterday", "Docs yesterday", new Date(2026, 7, 10, 9), { projectId: docsProject.id });
    const view = renderSidebar([studioNewest, docsMiddle, studioOlder, docsYesterday], vi.fn(), [], {
      projects: [project, docsProject],
    });
    const stream = view.container.querySelector(".activity-thread-stream")!;
    expect([...stream.querySelectorAll(".activity-thread-title")].map((element) => element.textContent))
      .toEqual(["Studio newest", "Docs middle", "Studio older", "Docs yesterday"]);
    expect(stream.querySelectorAll("h3, .work-project-group")).toHaveLength(0);
    expect([...stream.querySelectorAll(".activity-thread-project-meta")].map((element) => element.textContent))
      .toEqual(["Studio", "Docs", "Studio", "Docs"]);
    const first = screen.getByRole("button", { name: /^Studio newest,/u });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /^Docs middle,/u })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /^Studio older,/u })).toHaveFocus();
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
      name: /^Keyboard menu work,/u,
    });
    expect(screen.queryByRole("button", { name: "Thread actions for Keyboard menu work" })).not.toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });

    const menu = screen.getByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    });
    const pin = within(menu).getByRole("menuitem", { name: "Pin thread" });
    const settle = within(menu).getByRole("menuitem", { name: "Settle thread" });
    const remove = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(pin).toHaveFocus();
    expect(pin).toHaveAttribute("tabindex", "-1");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    view.rerenderSnapshot(snapshot([{ ...menuConversation }]));
    expect(screen.getByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    })).toBeInTheDocument();
    expect(pin).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(pin, { key: "ArrowDown" });
    expect(settle).toHaveFocus();
    fireEvent.keyDown(settle, { key: "End" });
    expect(remove).toHaveFocus();
    fireEvent.keyDown(remove, { key: "Home" });
    expect(pin).toHaveFocus();

    fireEvent.keyDown(pin, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.contextMenu(trigger);
    expect(within(screen.getByRole("menu", {
      name: "Thread actions for Keyboard menu work",
    })).getByRole("menuitem", { name: "Pin thread" })).toHaveFocus();
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
        modelSelection: providerNativeModelSelection({ providerId: "claude" }),
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

  it("initializes a large Work index for legacy Projects preferences", () => {
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
    const view = renderSidebar(entries, vi.fn());
    const navigation = view.container.querySelector<HTMLElement>(".project-list");
    expect(navigation).not.toBeNull();
    expect(observe).toHaveBeenCalledWith(navigation);
    Object.defineProperty(navigation, "clientHeight", {
      configurable: true,
      value: 2_400,
    });

    fireEvent.scroll(navigation!);
    view.rerenderSnapshot(snapshot(entries));

    const stream = view.container.querySelector<HTMLElement>(
      ".activity-thread-stream",
    );
    expect(stream).toHaveAttribute("data-work-index-virtualized", "true");
    expect(stream?.querySelectorAll(".activity-thread").length).toBeGreaterThan(25);
    expect(observe).toHaveBeenCalledWith(navigation);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("keeps distant row actions reachable through keyboard navigation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `classic-actions-${index}`,
      `Classic actions ${index}`,
      new Date(2026, 7, 11, 11, 59 - index),
    ));
    renderSidebar(entries, vi.fn());

    fireEvent.keyDown(screen.getByRole("button", { name: /^Classic actions 0,/ }), { key: "End" });
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.contextMenu(screen.getByRole("button", {
      name: /^Classic actions 79,/u,
    }));
    const rename = screen.getByRole("menuitem", { name: "Rename thread" });
    expect(rename).toBeInTheDocument();
    fireEvent.click(rename);

    expect(screen.getByRole("textbox", { name: "Rename Classic actions 79" }))
      .toHaveFocus();
  });

  it.each(["pointer", "keyboard"] as const)("keeps a %s-focused row mounted while the Work index scrolls and updates", (method) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const entries = Array.from({ length: 80 }, (_, index) => conversation(
      `retained-${index}`,
      `Retained work ${index}`,
      new Date(2026, 7, 11, 11, 50 - index),
    ));
    const view = renderSidebar(entries);
    const navigation = view.container.querySelector<HTMLElement>(".project-list")!;
    if (method === "pointer") {
      screen.getByRole("button", { name: /^Retained work 5,/u }).focus();
    } else {
      const first = screen.getByRole("button", { name: /^Retained work 0,/u });
      first.focus();
      for (let step = 0; step < 5; step += 1) {
        fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
        act(() => { vi.advanceTimersByTime(20); });
      }
    }
    const focused = screen.getByRole("button", { name: /^Retained work 5,/u });
    expect(focused).toHaveFocus();

    navigation.scrollTop = 3_000;
    fireEvent.scroll(navigation);
    expect(screen.queryByRole("button", { name: /^Retained work 70,/u })).not.toBeNull();
    expect(focused).toHaveFocus();
    view.rerenderSnapshot({
      ...snapshot([conversation("retained-new", "Retained new work", new Date(2026, 7, 11, 11, 55)), ...entries]),
      activeConversationId: entries[0]!.id,
    });
    act(() => { vi.advanceTimersByTime(100); });

    expect(screen.getByRole("button", { name: /^Retained work 5,/u })).toHaveFocus();
    expect(navigation.scrollTop).toBe(3_000);
  });

  it("explains why Remove project is unavailable while the project has running work", () => {
    const startedAt = new Date(2026, 7, 11, 11, 57);
    const running = conversation("remove-running", "Running task", startedAt, { status: "running" });
    renderSidebar([running], vi.fn(), [{
      id: "run-remove-running",
      kind: "agent",
      projectId: running.projectId,
      conversationId: running.id,
      actionId: null,
      label: running.title,
      detail: null,
      status: "running",
      attentionState: "acknowledged",
      canStop: true,
      port: null,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
    }]);
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", { name: "Project actions for Studio" }));
    const remove = screen.getByRole("menuitem", { name: "Remove project" });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).toHaveAccessibleDescription("Stop this project's running work before removing it.");
  });

  it("dismisses project actions on outside pointer and restores filter focus on Escape", () => {
    vi.useFakeTimers();
    renderSidebar([]);
    const trigger = screen.getByRole("button", { name: "Filter work by project" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Project actions for Studio" }));
    const menu = screen.getByRole("menu", { name: "Project actions for Studio" });
    const newChat = within(menu).getByRole("menuitem", { name: "New chat in Studio" });
    expect(newChat).toHaveFocus();
    fireEvent.keyDown(newChat, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Open folder" })).toHaveFocus();
    fireEvent.keyDown(newChat, { key: "End" });
    expect(within(menu).getByRole("menuitem", { name: "Remove project" })).toHaveFocus();
    fireEvent.keyDown(newChat, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Project actions for Studio" }));
    fireEvent.pointerDown(screen.getByRole("searchbox"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("cancels a mobile project rename without closing navigation", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(max-width: 760px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const view = renderSidebar([], vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", {
      name: "Project actions for Studio",
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const rename = screen.getByRole("textbox", { name: "Rename project" });
    fireEvent.keyDown(rename, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Rename project" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", {
      name: "Search projects and conversations",
    })).toBeInTheDocument();
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it("keeps focus in the project rename field after dismissing its menu", async () => {
    renderSidebar([], vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", {
      name: "Project actions for Studio",
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const renameInput = screen.getByRole("textbox", { name: "Rename project" });

    expect(renameInput).toHaveFocus();
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    expect(renameInput).toHaveFocus();
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

  it("lets rows be dragged toward split view unless the chat has its own window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const active = conversation("active-thread", "Active work", new Date(2026, 7, 11, 11));
    const companion = conversation("companion-thread", "Companion work", new Date(2026, 7, 11, 10));
    const windowed = conversation("windowed-thread", "Windowed work", new Date(2026, 7, 11, 9));
    const drag = (name: RegExp) => {
      fireEvent.pointerDown(screen.getByRole("button", { name }), {
        button: 0,
        buttons: 1,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientX: 60, clientY: 10 });
      const started = currentChatDrag();
      fireEvent.pointerUp(document, { pointerId: 1, buttons: 0 });
      act(() => {
        vi.advanceTimersByTime(1);
      });
      return started;
    };
    const view = renderSidebar([active, companion, windowed], vi.fn(), [], {
      detachedConversationIds: new Set([windowed.id]),
    });

    expect(drag(/^Companion work,/)).toMatchObject({
      conversationId: companion.id,
      title: "Companion work",
    });
    expect(drag(/^Windowed work,/)).toBeNull();
    view.unmount();

    renderSidebar([active, companion], vi.fn(), [], { view: "home" });
    expect(drag(/^Companion work,/)).toBeNull();
  });

  it("does not reopen a row menu after its Work section is collapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    renderSidebar([
      conversation("earlier", "Earlier menu work", new Date(2026, 7, 6, 9)),
    ]);

    const earlierToggle = screen.getByRole("button", { name: "Earlier 1" });
    fireEvent.click(earlierToggle);
    fireEvent.contextMenu(screen.getByRole("button", {
      name: /^Earlier menu work,/u,
    }));
    expect(screen.getByRole("menuitem", { name: "Rename thread" })).toBeInTheDocument();

    fireEvent.click(earlierToggle);
    expect(screen.queryByRole("menuitem", { name: "Rename thread" })).not.toBeInTheDocument();
    fireEvent.click(earlierToggle);
    expect(screen.queryByRole("menuitem", { name: "Rename thread" })).not.toBeInTheDocument();
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
    fireEvent.contextMenu(screen.getByRole("button", {
      name: /^Hidden after snooze,/u,
    }));
    expect(screen.getByRole("menuitem", { name: "Rename thread" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.queryByRole("menuitem", { name: "Rename thread" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Earlier 1" }));
    expect(screen.queryByRole("menuitem", { name: "Rename thread" })).not.toBeInTheDocument();
  });

  it("keeps Work and its search available when a saved legacy mode is loaded", () => {
    const work = conversation("legacy", "Keep my task", new Date());
    renderSidebar([work], vi.fn());
    expect(screen.queryByRole("button", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.queryByText("Work", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Work" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Keep my task" } });
    expect(screen.getByRole("button", { name: /^Keep my task,/ })).toBeInTheDocument();
  });

  it("filters Work by project while retaining the task search", () => {
    const second = { ...project, id: "project-two", name: "Runtime", path: "/work/runtime" };
    const first = conversation("website", "Fix website", new Date());
    const other = conversation("runtime", "Fix runtime", new Date(), { projectId: second.id });
    const view = renderSidebar([first, other]);
    view.rerenderSnapshot(snapshot([first, other], [], [project, second]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Fix" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("option", { name: /Runtime/u }));
    expect(screen.getByRole("button", { name: /^Fix runtime,/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Fix website,/ })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("Fix");
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
    fireEvent.contextMenu(screen.getByRole("button", {
      name: /^Rename before expiry,/u,
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread" }));
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

  it("keeps a generated title that lands while an untouched row rename is open", () => {
    const updatedAt = new Date();
    const view = renderSidebar([conversation("titled", "Fix login bug", updatedAt)]);
    const startRename = (): HTMLInputElement => {
      fireEvent.contextMenu(screen.getByRole("button", { name: /^(Fix login bug|Login bug fix),/u }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread" }));
      return screen.getByRole("textbox", { name: /^Rename / });
    };

    const untouched = startRename();
    view.rerenderSnapshot(snapshot([conversation("titled", "Login bug fix", updatedAt)]));
    expect(untouched).toHaveValue("Fix login bug");
    fireEvent.submit(untouched.closest("form")!);
    expect(view.onRenameConversation).not.toHaveBeenCalled();

    const typed = startRename();
    fireEvent.change(typed, { target: { value: "  Repair sign-in  " } });
    fireEvent.submit(typed.closest("form")!);
    expect(view.onRenameConversation).toHaveBeenCalledOnce();
    expect(view.onRenameConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "titled" }),
      "Repair sign-in",
    );
  });

  it("returns focus to the row after a rename is saved or cancelled", async () => {
    const view = renderSidebar([conversation("refocus", "Rename and return", new Date())]);
    const row = () => screen.getByRole("button", { name: /^(Rename and return|Renamed work),/u });
    const startRename = (): HTMLInputElement => {
      fireEvent.contextMenu(row());
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread" }));
      return screen.getByRole("textbox", { name: /^Rename / });
    };

    const cancelled = startRename();
    fireEvent.change(cancelled, { target: { value: "Discard this" } });
    fireEvent.keyDown(cancelled, { key: "Escape" });
    await waitFor(() => expect(row()).toHaveFocus());
    expect(view.onRenameConversation).not.toHaveBeenCalled();

    const saved = startRename();
    fireEvent.change(saved, { target: { value: "Renamed work" } });
    fireEvent.submit(saved.closest("form")!);
    await waitFor(() => expect(row()).toHaveFocus());
    expect(view.onRenameConversation).toHaveBeenCalledWith(expect.objectContaining({ id: "refocus" }), "Renamed work");
  });

  it("keeps a typed row name when focus leaves the rename field or the window", () => {
    const view = renderSidebar([conversation("blurred", "Blur rename", new Date())]);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Blur rename,/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread" }));
    const input = screen.getByRole("textbox", { name: "Rename Blur rename" });
    fireEvent.change(input, { target: { value: "Typed before switching apps" } });

    const windowFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(input);
    windowFocus.mockRestore();
    expect(screen.getByRole("textbox", { name: "Rename Blur rename" })).toHaveValue("Typed before switching apps");
    expect(view.onRenameConversation).not.toHaveBeenCalled();

    screen.getByRole("searchbox", { name: "Search projects and conversations" }).focus();
    fireEvent.blur(input);
    expect(screen.queryByRole("textbox", { name: "Rename Blur rename" })).not.toBeInTheDocument();
    expect(view.onRenameConversation).toHaveBeenCalledWith(expect.objectContaining({ id: "blurred" }), "Typed before switching apps");
  });

  it("returns focus to the project filter after a project rename is saved or cancelled", () => {
    const view = renderSidebar([], vi.fn());
    const filter = screen.getByRole("button", { name: "Filter work by project" });
    const startRename = (): HTMLInputElement => {
      fireEvent.click(filter);
      fireEvent.click(screen.getByRole("button", { name: "Project actions for Studio" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      return screen.getByRole("textbox", { name: "Rename project" });
    };

    fireEvent.keyDown(startRename(), { key: "Escape" });
    expect(filter).toHaveFocus();
    const saved = startRename();
    fireEvent.change(saved, { target: { value: "Studio renamed" } });
    fireEvent.submit(saved.closest("form")!);
    expect(filter).toHaveFocus();
    expect(view.onRenameProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-studio" }), "Studio renamed");
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
    fireEvent.contextMenu(screen.getByRole("button", {
      name: /^Restore this task,/u,
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Snooze" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
    expect(view.onSnoozeConversation).toHaveBeenCalledWith(snoozed, null);
  });

  it("focuses the first snooze choice when the inline Snooze action opens the menu", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const idle = conversation("inline-snooze", "Snooze from the row", new Date(2026, 7, 11, 9));
    const view = renderSidebar([idle]);

    fireEvent.click(screen.getByRole("button", { name: "Snooze Snooze from the row" }));
    const choices = within(screen.getByRole("menu", { name: "Snooze" })).getAllByRole("menuitem");
    expect(choices[0]).toHaveFocus();
    fireEvent.click(document.activeElement!);
    expect(view.onSnoozeConversation).toHaveBeenCalledWith(idle, expect.any(String));
  });

  it("moves focus to Done after a row's inline Settle action regroups the thread", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const settling = conversation("inline-settle", "Settle from the row", new Date(2026, 7, 11, 9));
    const other = conversation("inline-other", "Other work", new Date(2026, 7, 11, 10));
    const view = renderSidebar([other, settling]);

    const settle = screen.getByRole("button", { name: "Settle Settle from the row" });
    settle.focus();
    fireEvent.click(settle);
    view.rerenderSnapshot(snapshot([other, { ...settling, settledAt: new Date(2026, 7, 11, 12).toISOString() }]));

    expect(screen.getByRole("button", { name: "Done 1" })).toHaveFocus();
  });

  it("refreshes local-day groups at midnight without a snapshot update", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 7, 11, 23, 59, 59, 900);
    vi.setSystemTime(start);
    renderSidebar([
      conversation("today", "Finish before midnight", new Date(2026, 7, 11, 12)),
    ]);

    expect(screen.getByRole("button", { name: /^Finish before midnight,/ }).closest(".activity-thread"))
      .toHaveAttribute("data-work-section", "recent");
    screen.getByRole("button", { name: /^Finish before midnight,/ }).focus();
    act(() => {
      vi.advanceTimersByTime(101);
    });
    expect(screen.queryByRole("heading", { name: "Recent 1" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Finish before midnight,/ }).closest(".activity-thread"))
      .toHaveAttribute("data-work-section", "yesterday");
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
      name: /^First snooze expires,/u,
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
      name: /^Menu snooze expires,/u,
    });
    fireEvent.contextMenu(trigger);
    const rename = screen.getByRole("menuitem", { name: "Rename thread" });
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
      name: /^Existing recent work,/u,
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
      ["working", "running", null, "agent-pixel-loader"],
      ["approval", "needs-input", "approval", "lucide-shield-alert"],
      ["input", "needs-input", "input", "lucide-message-circle-question-mark"],
      ["failed", "failed", null, "lucide-circle-x"],
      ["completed", "completed", null, "lucide-circle-check"],
    ] as const;
    renderSidebar([...statusCases, ["idle", "idle", null, null] as const].map(([id, status, attentionKind]) => conversation(
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
    const idleTime = screen.getByText("idle task").closest(".activity-thread")?.querySelector(".activity-thread-trailing time");
    expect(idleTime).not.toBeNull();
    expect(idleTime?.querySelector("svg")).toBeNull();
  });

  it("labels a chat stopped by a usage limit as Limited with its own icon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const failed = conversation("usage-limited", "Limited task", new Date(2026, 7, 11, 9), { status: "failed" });
    const latestTurn = { id: "limited-turn", status: "failed", usageLimited: true } as unknown as NonNullable<ConversationShell["latestTurn"]>;
    renderSidebar([{ ...failed, latestTurn }]);
    const cue = document.querySelector('[data-work-status="limited"]');
    expect(cue?.querySelector(".lucide-clock")).not.toBeNull();
    expect(cue?.closest(".activity-thread-status-label")).toHaveTextContent("Limited");
    expect(screen.getByRole("button", { name: /Limited task.*Limited$/u })).toBeVisible();
  });

  it("shows the orbiting pixel glyph and how long a running thread has been working", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const startedAt = new Date(2026, 7, 11, 11, 57);
    const running = conversation("elapsed-working", "Elapsed task", startedAt, { status: "running" });
    renderSidebar([running], vi.fn(), [{
      id: "run-elapsed-working",
      kind: "agent",
      projectId: running.projectId,
      conversationId: running.id,
      actionId: null,
      label: running.title,
      detail: null,
      status: "running",
      attentionState: "acknowledged",
      canStop: true,
      port: null,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
    }]);

    const cue = document.querySelector('[data-work-status="working"]');
    expect(cue?.querySelector('.agent-pixel-loader[data-rhythm="orbit"][data-animated="true"]'))
      .not.toBeNull();
    expect(cue?.querySelectorAll(".agent-pixel-loader > span")).toHaveLength(9);
    const label = cue?.closest(".activity-thread-status-label");
    expect(label).toHaveAttribute("data-work-elapsed");
    expect(label).toHaveTextContent(/Working\s*·\s*3m/u);
    expect(cue?.closest("button")).toHaveAccessibleDescription(
      `Working since ${startedAt.toLocaleString(INTERFACE_LOCALE)}. Right-click or press Shift+F10 for thread actions.`,
    );
  });

  function scopeTo(name: string): HTMLElement {
    const scope = screen.getByRole("button", { name: "Filter work by project" });
    fireEvent.click(scope);
    fireEvent.click(screen.getByRole("option", { name }));
    expect(scope).toHaveTextContent(name);
    return scope;
  }

  function otherProject(id: string, name: string): Project {
    return {
      ...project,
      id,
      name,
      path: `/workspace/${id}`,
      normalizedPath: `/workspace/${id}`,
      repositoryIdentity: null,
      repositoryRoot: null,
      repositoryRelativePath: ".",
    };
  }

  it("scopes Work to a newly created project once it becomes active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const studioThread = conversation("studio-thread", "Polish studio", new Date(2026, 7, 11, 9));
    const launchpad = otherProject("project-launchpad", "Launchpad");
    const view = renderSidebar([studioThread]);
    const scope = scopeTo("Studio");

    view.rerenderSnapshot({
      ...snapshot([studioThread], [], [project, launchpad]),
      activeProjectId: launchpad.id,
      activeConversationId: null,
    });

    expect(scope).toHaveTextContent("Launchpad");
    expect(screen.queryByText("Polish studio")).not.toBeInTheDocument();
    expect(screen.getByText("No work yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^New chat$/u }), { shiftKey: true });
    expect(view.onCreateConversation).toHaveBeenCalledExactlyOnceWith(launchpad);
  });

  it("keeps the chosen scope when no newly created project becomes active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const studioThread = conversation("studio-thread", "Polish studio", new Date(2026, 7, 11, 9));
    const runtime = otherProject("project-runtime", "Runtime");
    const launchpad = otherProject("project-launchpad", "Launchpad");
    const view = renderSidebar([studioThread], vi.fn(), [], { projects: [project, runtime] });
    expect(screen.getByRole("button", { name: "Filter work by project" })).toHaveTextContent("All projects");
    const scope = scopeTo("Studio");

    view.rerenderSnapshot(snapshot([studioThread], [], [project, runtime]));
    expect(scope).toHaveTextContent("Studio");

    view.rerenderSnapshot({ ...snapshot([studioThread], [], [project, runtime]), activeProjectId: runtime.id });
    expect(scope).toHaveTextContent("Studio");

    view.rerenderSnapshot({ ...snapshot([studioThread], [], [project, runtime, launchpad]), activeProjectId: runtime.id });
    expect(scope).toHaveTextContent("Studio");
    expect(screen.getByText("Polish studio")).toBeInTheDocument();

    scopeTo("All projects");
    view.rerenderSnapshot({ ...snapshot([studioThread], [], [project, runtime, launchpad]), activeProjectId: launchpad.id });
    expect(scope).toHaveTextContent("All projects");
  });

  it("keeps the scope while collapsed and selects a project created before reopening", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12));
    const studioThread = conversation("studio-thread", "Polish studio", new Date(2026, 7, 11, 9));
    const launchpad = otherProject("project-launchpad", "Launchpad");
    const view = renderSidebar([studioThread]);
    scopeTo("Studio");

    view.rerenderSnapshot(snapshot([studioThread]), true);
    expect(screen.queryByRole("button", { name: "Filter work by project" })).not.toBeInTheDocument();
    view.rerenderSnapshot(snapshot([studioThread]));
    expect(screen.getByRole("button", { name: "Filter work by project" })).toHaveTextContent("Studio");

    const created = {
      ...snapshot([studioThread], [], [project, launchpad]),
      activeProjectId: launchpad.id,
      activeConversationId: null,
    };
    view.rerenderSnapshot(snapshot([studioThread]), true);
    view.rerenderSnapshot(created, true);
    view.rerenderSnapshot(created);

    expect(screen.getByRole("button", { name: "Filter work by project" })).toHaveTextContent("Launchpad");
    expect(screen.queryByText("Polish studio")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^New chat$/u }), { shiftKey: true });
    expect(view.onCreateConversation).toHaveBeenCalledExactlyOnceWith(launchpad);
  });

  it("starts a new chat directly when there is only one project", () => {
    const view = renderSidebar([]);
    const newChat = screen.getByRole("button", { name: /^New chat$/u });
    expect(newChat).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(newChat);
    expect(view.onCreateConversation).toHaveBeenCalledExactlyOnceWith(project);
    expect(view.onChooseNewChatProject).not.toHaveBeenCalled();
  });

  it("asks for the project when several exist unless Shift is held", () => {
    const launchpad = otherProject("project-launchpad", "Launchpad");
    const view = renderSidebar([], vi.fn(), [], { projects: [project, launchpad] });
    const newChat = screen.getByRole("button", { name: /^New chat$/u });
    expect(newChat).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(newChat);
    expect(view.onChooseNewChatProject).toHaveBeenCalledTimes(1);
    expect(view.onCreateConversation).not.toHaveBeenCalled();
    fireEvent.click(newChat, { shiftKey: true });
    expect(view.onCreateConversation).toHaveBeenCalledExactlyOnceWith(project);
    expect(view.onChooseNewChatProject).toHaveBeenCalledTimes(1);
  });

  it("nests an attached watcher under its chat and includes it in arrow-key order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12, 30));
    const watched = conversation(WATCHED_ID, "Refactor parser", new Date(2026, 7, 11, 11));
    const watcher = conversation(WATCHER_ID, "Watcher · Reviewer · Refactor parser", new Date(2026, 7, 11, 12));
    const docs = conversation("docs", "Docs", new Date(2026, 7, 11, 10));
    const onSelectConversation = vi.fn();
    const view = renderSidebar([watched, watcher, docs], onSelectConversation);
    view.rerenderSnapshot({ ...snapshot([watched, watcher, docs]), watchers: [link({ projectId: project.id })] });
    const stream = view.container.querySelector(".activity-thread-stream")!;
    expect([...stream.querySelectorAll(".activity-thread-title")].map((element) => element.textContent))
      .toEqual(["Refactor parser", "Docs"]);
    const nested = screen.getByRole("button", { name: "Watcher · Reviewer, watching Refactor parser, Idle" });
    const nestedRow = nested.closest(".activity-thread")!;
    expect(nestedRow).toHaveClass("is-watcher");
    const rows = [...stream.querySelectorAll(".activity-thread")];
    expect(rows.indexOf(nestedRow)).toBe(1);
    const parent = screen.getByRole("button", { name: /^Refactor parser,/u });
    parent.focus();
    fireEvent.keyDown(parent, { key: "ArrowDown" });
    expect(nested).toHaveFocus();
    fireEvent.keyDown(nested, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /^Docs,/u })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(nested).toHaveFocus();
    fireEvent.click(nested);
    expect(onSelectConversation).toHaveBeenCalledWith(expect.objectContaining({ id: WATCHER_ID }));

    view.rerenderSnapshot({ ...snapshot([watched, watcher, docs]), watchers: [link({
      projectId: project.id,
      status: "detached",
      detachedReason: "user",
      watchedConversationId: null,
    })] });
    expect([...stream.querySelectorAll(".activity-thread-title")].map((element) => element.textContent))
      .toEqual(["Watcher · Reviewer · Refactor parser", "Refactor parser", "Docs"]);
    expect(stream.querySelector(".activity-thread.is-watcher")).toBeNull();
  });

  it("gives a nested watcher the same thread actions as other rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12, 30));
    const watched = conversation(WATCHED_ID, "Refactor parser", new Date(2026, 7, 11, 11));
    const watcher = conversation(WATCHER_ID, "Watcher · Reviewer · Refactor parser", new Date(2026, 7, 11, 12));
    const view = renderSidebar([watched, watcher]);
    view.rerenderSnapshot({ ...snapshot([watched, watcher]), watchers: [link({ projectId: project.id })] });
    const nested = screen.getByRole("button", { name: /^Watcher · Reviewer, watching Refactor parser/u });
    expect(nested).toHaveAttribute("aria-haspopup", "menu");
    expect(nested).toHaveAccessibleDescription("Right-click or press Shift+F10 for thread actions.");
    fireEvent.keyDown(nested, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Thread actions for Watcher · Reviewer · Refactor parser" });
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(nested).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: /Thread actions for Watcher/u })).not.toBeInTheDocument();
    fireEvent.contextMenu(nested);
    expect(screen.getByRole("menu", { name: "Thread actions for Watcher · Reviewer · Refactor parser" })).toBeInTheDocument();
  });

  it("shows a nested watcher's unseen findings as plain text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12, 30));
    resetWatcherDockStore();
    window.localStorage.removeItem(watcherDockStorageKey(WATCHED_ID));
    const watched = conversation(WATCHED_ID, "Refactor parser", new Date(2026, 7, 11, 11));
    const watcher = conversation(WATCHER_ID, "Watcher · Reviewer · Refactor parser", new Date(2026, 7, 11, 12));
    const view = renderSidebar([watched, watcher]);
    view.rerenderSnapshot({ ...snapshot([watched, watcher]), watchers: [link({
      projectId: project.id,
      latestFindingAt: new Date(2026, 7, 11, 12).toISOString(),
      counters: { ...link().counters, findingsTotal: 2 } as WatcherLinkView["counters"],
    })] });
    const row = screen.getByRole("button", { name: /^Watcher · Reviewer, watching Refactor parser, 2 new,/u });
    expect(row.querySelector(".watcher-work-row-new")).toHaveTextContent(/^2 new$/u);
    resetWatcherDockStore();
  });

  it("returns focus to a nested watcher row after renaming it from the keyboard", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12, 30));
    const watched = conversation(WATCHED_ID, "Refactor parser", new Date(2026, 7, 11, 11));
    const watcher = conversation(WATCHER_ID, "Watcher · Reviewer · Refactor parser", new Date(2026, 7, 11, 12));
    const docs = conversation("docs", "Docs", new Date(2026, 7, 11, 10));
    const view = renderSidebar([watched, watcher, docs], vi.fn());
    view.rerenderSnapshot({ ...snapshot([watched, watcher, docs]), watchers: [link({ projectId: project.id })] });
    const nested = screen.getByRole("button", { name: /^Watcher · Reviewer, watching Refactor parser/u });
    nested.focus();
    fireEvent.keyDown(nested, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread" }));
    const input = screen.getByRole("textbox", { name: /^Rename Watcher/u });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.getByRole("button", { name: /^Watcher · Reviewer, watching Refactor parser/u })).toHaveFocus();
  });

  it("keeps focus on a watcher whose row moves from under its chat to the top level", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 7, 11, 12, 30);
    vi.setSystemTime(now);
    const watched = conversation(WATCHED_ID, "Refactor parser", new Date(2026, 7, 11, 11));
    const watcher = conversation(WATCHER_ID, "Watcher · Reviewer · Refactor parser", now, { status: "running" });
    const docs = conversation("docs", "Docs", new Date(2026, 7, 11, 10));
    const runs: WorkspaceRun[] = [{
      id: "run-watcher",
      kind: "agent",
      projectId: project.id,
      conversationId: WATCHER_ID,
      actionId: null,
      label: watcher.title,
      detail: null,
      status: "running",
      attentionState: "acknowledged",
      canStop: true,
      port: null,
      startedAt: now.toISOString(),
      finishedAt: null,
    }];
    const view = renderSidebar([watched, watcher, docs], vi.fn(), runs);
    view.rerenderSnapshot({ ...snapshot([watched, watcher, docs], runs), watchers: [link({ projectId: project.id, status: "waking" })] });
    const nested = screen.getByRole("button", { name: /^Watcher · Reviewer, watching Refactor parser/u });
    nested.focus();
    const settled = { ...watched, settledAt: new Date(2026, 7, 11, 12).toISOString() };
    view.rerenderSnapshot({ ...snapshot([settled, watcher, docs], runs), watchers: [link({ projectId: project.id, status: "waking" })] });
    const topLevel = screen.getByRole("button", { name: /^Watcher · Reviewer · Refactor parser, Watcher · Reviewer, watching Refactor parser,/u });
    expect(topLevel).toHaveFocus();
  });

  it("keeps the watcher marker when the watched chat is archived", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12, 30));
    const watched = conversation(WATCHED_ID, "Refactor parser", new Date(2026, 7, 11, 11), {
      archivedAt: new Date(2026, 7, 11, 12).toISOString(),
    });
    const watcher = conversation(WATCHER_ID, "Watcher · Reviewer · Refactor parser", new Date(2026, 7, 11, 12));
    const view = renderSidebar([watched, watcher]);
    view.rerenderSnapshot({ ...snapshot([watched, watcher]), watchers: [link({
      projectId: project.id,
      status: "paused",
      pauseReason: "watched-archived",
    })] });
    const row = screen.getByRole("button", { name: /^Watcher · Reviewer · Refactor parser, Watcher · Reviewer, watching Refactor parser,/u });
    expect(row.querySelector(".thread-watcher-mark")).toHaveTextContent("Watcher");
  });

  it("lists a watcher running its final check while its chat sits in a collapsed Done section", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 7, 11, 12, 30);
    vi.setSystemTime(now);
    const watched = conversation(WATCHED_ID, "Refactor parser", new Date(2026, 7, 11, 11), {
      settledAt: new Date(2026, 7, 11, 12).toISOString(),
    });
    const watcher = conversation(WATCHER_ID, "Watcher · Reviewer · Refactor parser", now, { status: "running" });
    const runs: WorkspaceRun[] = [{
      id: "run-watcher",
      kind: "agent",
      projectId: project.id,
      conversationId: WATCHER_ID,
      actionId: null,
      label: watcher.title,
      detail: null,
      status: "running",
      attentionState: "acknowledged",
      canStop: true,
      port: null,
      startedAt: now.toISOString(),
      finishedAt: null,
    }];
    const view = renderSidebar([watched, watcher], vi.fn(), runs);
    view.rerenderSnapshot({ ...snapshot([watched, watcher], runs), watchers: [link({ projectId: project.id, status: "waking" })] });
    expect(screen.getByRole("button", { name: /^Done/u })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Refactor parser,/u })).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /^Watcher · Reviewer · Refactor parser, Watcher · Reviewer, watching Refactor parser,/u });
    expect(row.querySelector(".thread-watcher-mark")).not.toBeNull();
  });
});

import { fireEvent, render, render as renderPalette, screen, within } from "@testing-library/react";
import { readSourceText } from "../helpers/source-text";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette, type CommandPaletteView } from "../../src/renderer/src/components/CommandPalette";
import type { Conversation, Project } from "../../src/shared/contracts";
import type { PaletteWorkspaceCommand } from "../../src/renderer/src/utils/paletteWorkspaceCommands";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const project: Project = {
  id: "project-1",
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: null,
  repositoryRoot: "/workspace/inertia",
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "ready",
  createdAt: "2026-07-28T08:00:00.000Z",
  updatedAt: "2026-07-28T08:00:00.000Z",
};

const conversation: Conversation = {
  id: "conversation-1",
  projectId: project.id,
  title: "Feedback loop",
  providerId: "codex",
  modelSelection: providerNativeModelSelection({ providerId: "codex" }),
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
  lastViewedAt: "2026-07-28T08:00:00.000Z",
  createdAt: "2026-07-28T08:00:00.000Z",
  updatedAt: "2026-07-28T08:00:00.000Z",
};

const noOp = (): void => undefined;

function palette(
  open: boolean,
  onClose = noOp,
  newThreadShortcut = "⌘N",
): React.JSX.Element {
  return (
    <CommandPalette
      open={open}
      projects={[project]}
      conversations={[conversation]}
      newThreadShortcut={newThreadShortcut}
      onClose={onClose}
      onSelectProject={noOp}
      onSelectConversation={noOp}
      onNewThread={noOp}
      onNewThreadIn={noOp}
      currentProjectId={null}
      onAddProject={noOp}
      onOpenSettings={noOp}
    />
  );
}

function ResetHarness({ onOpenSettings }: {
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open palette</button>
      <CommandPalette
        open={open}
        projects={[project]}
        conversations={[conversation]}
        newThreadShortcut="⌘N"
        onClose={() => setOpen(false)}
        onSelectProject={noOp}
        onSelectConversation={noOp}
        onNewThread={noOp}
        onNewThreadIn={noOp}
        currentProjectId={null}
        onAddProject={noOp}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}

function FocusHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open palette</button>
      <button type="button">Background action</button>
      <CommandPalette
        open={open}
        projects={[project]}
        conversations={[conversation]}
        newThreadShortcut="⌘N"
        onClose={() => setOpen(false)}
        onSelectProject={noOp}
        onSelectConversation={noOp}
        onNewThread={noOp}
        onNewThreadIn={noOp}
        currentProjectId={null}
        onAddProject={noOp}
        onOpenSettings={noOp}
      />
    </>
  );
}

const studio: Project = { ...project, id: "project-studio", name: "Studio", path: "/workspace/studio" };

function ProjectChoiceHarness({ initialView, onClose }: {
  initialView: CommandPaletteView;
  onClose: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open palette</button>
      {open && (
        <CommandPalette
          open
          initialView={initialView}
          currentProjectId={project.id}
          projects={[project, studio]}
          conversations={[conversation]}
          newThreadShortcut="⌘N"
          onClose={() => { onClose(); setOpen(false); }}
          onSelectProject={noOp}
          onSelectConversation={noOp}
          onNewThread={noOp}
          onNewThreadIn={noOp}
          onAddProject={noOp}
          onOpenSettings={noOp}
        />
      )}
    </>
  );
}

type PaletteUser = ReturnType<typeof userEvent.setup>;

const projectChoiceControls: [string, (user: PaletteUser) => Promise<HTMLElement>][] = [
  ["search input", async () => screen.getByRole("combobox", { name: "Search projects for the new chat" })],
  ["Close button", async (user) => {
    await user.tab();
    return screen.getByRole("button", { name: "Close search" });
  }],
  ["project option", async (user) => {
    await user.tab({ shift: true });
    return screen.getByRole("option", { name: /Studio/u });
  }],
];

describe("CommandPalette behavior", () => {
  it.each(projectChoiceControls)("closes the New chat project choice with Escape from the %s", async (_name, reach) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProjectChoiceHarness initialView="new-chat" onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "New chat in project" })).toBeInTheDocument();

    const control = await reach(user);
    expect(control).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each(projectChoiceControls)("steps back from the project choice to search with Escape from the %s", async (_name, reach) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProjectChoiceHarness initialView="search" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "new chat in");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "New chat in project" })).toBeInTheDocument();

    const control = await reach(user);
    expect(control).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Search Inertia" })).toBeInTheDocument();
    const search = screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the active platform shortcut for a remapped new-chat action", () => {
    render(palette(true, noOp, "Ctrl+Y"));

    expect(screen.getByRole("option", { name: /New chat/u }))
      .toHaveTextContent("Ctrl+Y");
  });

  it("takes focus synchronously when it opens over a focused widget", () => {
    const view = render(
      <>
        <textarea aria-label="Terminal input" />
        {palette(false)}
      </>,
    );
    const terminal = screen.getByRole("textbox", { name: "Terminal input" });
    terminal.focus();
    expect(terminal).toHaveFocus();

    view.rerender(
      <>
        <textarea aria-label="Terminal input" />
        {palette(true)}
      </>,
    );

    expect(screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    })).toHaveFocus();
  });

  it("resets selection when filtering and ignores mouse entry until the pointer moves", async () => {
    const user = userEvent.setup();
    render(palette(true));
    const search = screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    });
    const settings = screen.getByRole("option", { name: /Open settings/u });

    fireEvent.pointerMove(settings);
    expect(settings).toHaveAttribute("aria-selected", "true");

    await user.type(search, "e");

    const firstResult = screen.getAllByRole("option")[0]!;
    expect(firstResult).not.toBe(settings);
    expect(firstResult).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveAttribute("aria-selected", "false");

    fireEvent.mouseEnter(settings);
    expect(settings).toHaveAttribute("aria-selected", "false");
    fireEvent.pointerMove(settings);
    expect(settings).toHaveAttribute("aria-selected", "true");
  });

  it("clears query and selection after Escape and after running an action", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<ResetHarness onOpenSettings={onOpenSettings} />);
    let search = screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    });

    await user.type(search, "settings");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search Inertia" }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    search = screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    });
    expect(search).toHaveValue("");
    expect(screen.getAllByRole("option")[0])
      .toHaveAttribute("aria-selected", "true");

    await user.type(search, "settings");
    await user.keyboard("{Enter}");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Search Inertia" }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    expect(screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    })).toHaveValue("");
  });

  it("traps Tab within the modal and restores the opening control", async () => {
    const user = userEvent.setup();
    render(<FocusHarness />);
    const trigger = screen.getByRole("button", { name: "Open palette" });

    await user.click(trigger);
    const search = screen.getByRole("combobox", {
      name: "Search commands, projects, chats, and messages",
    });
    const lastOption = screen.getAllByRole("option").at(-1)!;
    expect(search).toHaveFocus();

    await user.tab({ shift: true });
    expect(lastOption).toHaveFocus();
    await user.tab();
    expect(search).toHaveFocus();
    expect(screen.getByRole("button", { name: "Background action" }))
      .not.toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search Inertia" }))
      .not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens on the new chat project choice with the current project first", async () => {
    const user = userEvent.setup();
    const studio = { ...project, id: "project-studio", name: "Studio", path: "/workspace/studio" };
    const launchpad = { ...project, id: "project-launchpad", name: "Launchpad", path: "/workspace/launchpad" };
    const onNewThreadIn = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <CommandPalette open initialView="new-chat" currentProjectId={launchpad.id} projects={[project, studio, launchpad]}
        conversations={[conversation]} newThreadShortcut="⌘N" onClose={onClose} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={onNewThreadIn} onAddProject={noOp} onOpenSettings={noOp} />,
    );
    expect(screen.getByRole("dialog", { name: "New chat in project" })).toBeInTheDocument();
    const search = screen.getByRole("combobox", { name: "Search projects for the new chat" });
    expect(search).toHaveFocus();
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.querySelector("strong")?.textContent)).toEqual(["Launchpad", "Inertia", "Studio"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveTextContent("Current");

    await user.type(search, "stu");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(onNewThreadIn).toHaveBeenCalledExactlyOnceWith(studio);
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(
      <CommandPalette open initialView="new-chat" currentProjectId={null} projects={[project, studio]}
        conversations={[]} newThreadShortcut="⌘N" onClose={onClose} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={onNewThreadIn} onAddProject={noOp} onOpenSettings={noOp} />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onNewThreadIn).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "Close search" }).focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps Enter scoped to the current project while offering No project", async () => {
    const user = userEvent.setup();
    const onNewThreadIn = vi.fn();
    const onNewThreadWithoutProject = vi.fn();
    const scratch: Project = { ...project, id: "scratch", name: "No project", workspaceKind: "scratch" };
    const view = render(
      <CommandPalette open initialView="new-chat" currentProjectId={project.id} projects={[scratch, project]}
        conversations={[]} newThreadShortcut="⌘N" onClose={noOp} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={onNewThreadIn}
        onNewThreadWithoutProject={onNewThreadWithoutProject} onAddProject={noOp} onOpenSettings={noOp} />,
    );
    expect(screen.getAllByRole("option").map((option) => option.querySelector("strong")?.textContent)).toEqual(["Inertia", "No project"]);
    await user.keyboard("{Enter}");
    expect(onNewThreadIn).toHaveBeenCalledExactlyOnceWith(project);
    expect(onNewThreadWithoutProject).not.toHaveBeenCalled();
    view.rerender(
      <CommandPalette open initialView="new-chat" currentProjectId={scratch.id} projects={[scratch, project]}
        conversations={[]} newThreadShortcut="⌘N" onClose={noOp} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={onNewThreadIn}
        onNewThreadWithoutProject={onNewThreadWithoutProject} onAddProject={noOp} onOpenSettings={noOp} />,
    );
    expect(screen.getAllByRole("option").map((option) => option.querySelector("strong")?.textContent)).toEqual(["No project", "Inertia"]);
    await user.keyboard("{Enter}");
    expect(onNewThreadWithoutProject).toHaveBeenCalledOnce();
    expect(onNewThreadIn).toHaveBeenCalledTimes(1);
  });

  it("keeps New chat as the default action and lists Start without a project with the new chat actions", async () => {
    const user = userEvent.setup();
    const onNewThread = vi.fn();
    const onNewThreadWithoutProject = vi.fn();
    const studio = { ...project, id: "project-studio", name: "Studio", path: "/workspace/studio" };
    render(
      <CommandPalette open currentProjectId={project.id} projects={[project, studio]}
        conversations={[]} newThreadShortcut="⌘N" onClose={noOp} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={onNewThread} onNewThreadIn={noOp}
        onNewThreadWithoutProject={onNewThreadWithoutProject} onAddProject={noOp} onOpenSettings={noOp} />,
    );
    expect(screen.getAllByRole("option").slice(0, 4).map((option) => option.querySelector("strong")?.textContent))
      .toEqual(["New chat", "New chat in…", "Start without a project", "Add project"]);
    await user.keyboard("{Enter}");
    expect(onNewThread).toHaveBeenCalledOnce();
    expect(onNewThreadWithoutProject).not.toHaveBeenCalled();
  });

  it("opens Tasks from an action after Add project", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenTasks = vi.fn();
    render(
      <CommandPalette open currentProjectId={project.id} projects={[project]}
        conversations={[]} newThreadShortcut="⌘N" onClose={onClose} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={noOp}
        onAddProject={noOp} onOpenSettings={noOp} onOpenTasks={onOpenTasks} />,
    );
    const labels = screen.getAllByRole("option").map((option) => option.querySelector("strong")?.textContent);
    expect(labels.indexOf("Open tasks")).toBe(labels.indexOf("Add project") + 1);
    const action = screen.getByRole("option", { name: /Open tasks/u });
    expect(action.querySelector(".lucide-list-todo")).not.toBeNull();
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "tasks");
    await user.keyboard("{Enter}");
    expect(onOpenTasks).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("adds a task from an action after Open tasks", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenTasks = vi.fn();
    const onAddTask = vi.fn();
    render(
      <CommandPalette open currentProjectId={project.id} projects={[project]}
        conversations={[]} newThreadShortcut="⌘N" onClose={onClose} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={noOp}
        onAddProject={noOp} onOpenSettings={noOp} onOpenTasks={onOpenTasks} onAddTask={onAddTask} />,
    );
    const labels = screen.getAllByRole("option").map((option) => option.querySelector("strong")?.textContent);
    expect(labels.indexOf("Add a task")).toBe(labels.indexOf("Open tasks") + 1);
    expect(screen.getByRole("option", { name: /Add a task/u }).querySelector(".lucide-plus")).not.toBeNull();
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "add a task");
    await user.keyboard("{Enter}");
    expect(onAddTask).toHaveBeenCalledOnce();
    expect(onOpenTasks).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lists actions by name only, ends without a hint band and says no matches in one line", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette open currentProjectId={project.id} projects={[project]}
        conversations={[]} newThreadShortcut="⌘N" onClose={noOp} onSelectProject={noOp}
        onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={noOp}
        onAddProject={noOp} onOpenSettings={noOp} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Search Inertia" });
    const newChat = screen.getAllByRole("option")[0]!;
    expect(newChat.querySelector("small")).toBeNull();
    expect(dialog.querySelector("footer")).toBeNull();
    await user.keyboard("zzqqxx");
    const empty = await screen.findByText("No matches");
    expect(empty.tagName).toBe("P");
    expect(dialog.querySelector(".palette-empty svg")).toBeNull();
    const css = readSourceText("src/renderer/src/styles.css");
    expect(css).toMatch(/\n\.palette-group button\.is-active \{ background: var\(--fill-strong\); \}/u);
    expect(css).not.toMatch(/\.palette-footer \{|\.palette-actions \{/u);
  });

  it("reaches the new chat project choice from search and steps back to it", async () => {
    const user = userEvent.setup();
    const studio = { ...project, id: "project-studio", name: "Studio", path: "/workspace/studio" };
    const onClose = vi.fn();
    render(
      <CommandPalette open currentProjectId={project.id} projects={[project, studio]} conversations={[conversation]}
        newThreadShortcut="⌘N" onClose={onClose} onSelectProject={noOp} onSelectConversation={noOp}
        onNewThread={noOp} onNewThreadIn={noOp} onAddProject={noOp} onOpenSettings={noOp} />,
    );
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "new chat in");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "New chat in project" })).toBeInTheDocument();
    const search = screen.getByRole("combobox", { name: "Search projects for the new chat" });
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");
    expect(screen.getByRole("dialog", { name: "New chat in project" }).querySelector("footer")).toBeNull();

    screen.getByRole("button", { name: "Close search" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Search Inertia" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "new chat in");
    await user.keyboard("{Enter}{Backspace}");
    expect(screen.getByRole("dialog", { name: "Search Inertia" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("CommandPalette commands for the current chat", () => {
  const workspaceReason = "Available after the first message creates this chat's workspace.";

  function workspaceCommands(overrides: Partial<Record<string, () => void>> = {}): PaletteWorkspaceCommand[] {
    return [
      { id: "surface:changes", group: "Surfaces", label: "Open Changes", keywords: "surface diff", icon: { kind: "surface", surface: "changes" }, disabledReason: workspaceReason, run: overrides.changes ?? noOp },
      { id: "surface:plan", group: "Surfaces", label: "Open Plan", keywords: "surface steps", icon: { kind: "surface", surface: "plan" }, run: overrides.plan ?? noOp },
      { id: "git:fetch", group: "Git", label: "Fetch", detail: "Refresh remote branches and incoming commits. Keep local changes.", keywords: "git remote", icon: { kind: "git", action: "fetch" }, run: overrides.fetch ?? noOp },
      { id: "git:branch", group: "Git", label: "Switch branch…", keywords: "git checkout", icon: { kind: "git", action: "branch" }, run: overrides.branch ?? noOp },
      { id: "window:toggle-terminal", group: "Window", label: "Toggle terminal dock", keywords: "terminal", icon: { kind: "window", action: "terminal-dock" }, shortcut: "⌘J", run: overrides.terminal ?? noOp },
      { id: "window:new-window", group: "Window", label: "Open chat in a new window", keywords: "detach window", icon: { kind: "window", action: "new-window" }, disabledReason: "Close a chat window before opening another.", run: overrides.newWindow ?? noOp },
    ];
  }

  function render(commands: PaletteWorkspaceCommand[], onClose = noOp): ReturnType<typeof renderPalette> {
    return renderPalette(
      <CommandPalette open currentProjectId={project.id} projects={[project]} conversations={[conversation]}
        newThreadShortcut="⌘N" onClose={onClose} onSelectProject={noOp} onSelectConversation={noOp}
        onNewThread={noOp} onNewThreadIn={noOp} onAddProject={noOp} onOpenSettings={noOp}
        workspaceCommands={commands} />,
    );
  }

  const search = () => screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });

  it("keeps the opening list unchanged and finds chat commands by name or keyword", async () => {
    const user = userEvent.setup();
    render(workspaceCommands());
    expect(screen.queryByRole("group", { name: "Surfaces" })).toBeNull();
    expect(screen.getByRole("group", { name: "Threads" })).toBeInTheDocument();

    await user.type(search(), "open");
    const groups = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(groups.indexOf("Actions")).toBeLessThan(groups.indexOf("Surfaces"));
    expect(within(screen.getByRole("group", { name: "Surfaces" })).getAllByRole("option").map((option) => option.querySelector("strong")?.textContent))
      .toEqual(["Open Changes", "Open Plan"]);

    await user.clear(search());
    await user.type(search(), "checkout");
    expect(within(screen.getByRole("group", { name: "Git" })).getByRole("option", { name: /Switch branch…/u })).toBeInTheDocument();

    await user.clear(search());
    await user.type(search(), "terminal");
    expect(within(screen.getByRole("group", { name: "Window" })).getByRole("option", { name: /Toggle terminal dock/u }))
      .toHaveTextContent("⌘J");
  });

  it("lists an unavailable command with its reason and does not run it", async () => {
    const user = userEvent.setup();
    const changes = vi.fn();
    const onClose = vi.fn();
    render(workspaceCommands({ changes }), onClose);
    await user.type(search(), "open changes");
    const option = screen.getByRole("option", { name: /Open Changes/u });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveTextContent(workspaceReason);
    expect(option).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    await user.click(option);
    expect(changes).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(search()).toHaveFocus();
  });

  it("runs an available command from the keyboard and closes", async () => {
    const user = userEvent.setup();
    const plan = vi.fn();
    const fetch = vi.fn();
    const onClose = vi.fn();
    render(workspaceCommands({ plan, fetch }), onClose);
    await user.type(search(), "fetch");
    const fetchOption = screen.getByRole("option", { name: /Fetch/u });
    expect(fetchOption).toHaveTextContent("Refresh remote branches and incoming commits. Keep local changes.");
    expect(fetchOption).toHaveAttribute("id", "palette-chat-git:fetch");
    expect(search()).toHaveAttribute("aria-activedescendant", "palette-chat-git:fetch");
    await user.keyboard("{Enter}");
    expect(fetch).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(plan).not.toHaveBeenCalled();
  });

  it("moves through chat commands with the arrow keys, including unavailable ones", async () => {
    const user = userEvent.setup();
    const plan = vi.fn();
    render(workspaceCommands({ plan }));
    await user.type(search(), "surface");
    const options = within(screen.getByRole("group", { name: "Surfaces" })).getAllByRole("option");
    expect(screen.getAllByRole("option")[0]).toBe(options[0]);
    expect(options.map((option) => option.querySelector("strong")?.textContent)).toEqual(["Open Changes", "Open Plan"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(search()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(plan).toHaveBeenCalledOnce();
  });
});

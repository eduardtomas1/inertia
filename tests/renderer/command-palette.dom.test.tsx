import { fireEvent, render, screen } from "@testing-library/react";
import { readSourceText } from "../helpers/source-text";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette, type CommandPaletteView } from "../../src/renderer/src/components/CommandPalette";
import { commandPaletteConversation } from "../../src/renderer/src/appView";
import type { Conversation, Initiative, Project } from "../../src/shared/contracts";
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

describe("CommandPalette initiatives", () => {
  const checkout: Initiative = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Checkout redesign",
    color: "teal",
    status: "active",
    brief: "",
    briefRevision: 0, briefUpdatedAt: null, notesRevision: 0, proposedNoteCount: 0,
    revision: 1,
    createdAt: "2026-07-28T08:00:00.000Z",
    updatedAt: "2026-07-28T08:00:00.000Z",
  };
  const docs: Initiative = { ...checkout, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Docs refresh" };
  const shelved: Initiative = { ...checkout, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Shelved idea", status: "archived" };

  function renderPalette(overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
    const props = {
      onClose: vi.fn(),
      onOpenInitiative: vi.fn(),
      onNewInitiative: vi.fn(),
      onMoveConversationToInitiative: vi.fn(),
      onNewInitiativeForConversation: vi.fn(),
    };
    render(
      <CommandPalette open currentProjectId={project.id} projects={[project]}
        conversations={[{ ...conversation, initiativeId: checkout.id }]} newThreadShortcut="⌘N"
        onSelectProject={noOp} onSelectConversation={noOp} onNewThread={noOp} onNewThreadIn={noOp}
        onAddProject={noOp} onOpenSettings={noOp} initiatives={[checkout, docs, shelved]}
        activeConversation={{ ...conversation, initiativeId: checkout.id }} {...props} {...overrides} />,
    );
    return props;
  }

  it("lists initiatives by name in their own group and opens the chosen one", async () => {
    const user = userEvent.setup();
    const props = renderPalette();
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "shelved");
    const group = screen.getByRole("group", { name: "Initiatives" });
    const option = screen.getByRole("option", { name: /Shelved idea/u });
    expect(group).toContainElement(option);
    expect(option).toHaveTextContent("Archived · 0 chats");
    await user.keyboard("{Enter}");
    expect(props.onOpenInitiative).toHaveBeenCalledExactlyOnceWith(shelved.id);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("starts a new initiative from an action", async () => {
    const user = userEvent.setup();
    const props = renderPalette();
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "new initiative");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("New initiative…");
    await user.keyboard("{Enter}");
    expect(props.onNewInitiative).toHaveBeenCalledOnce();
  });

  it("moves the active chat to another active initiative, out of one, or into a new one", async () => {
    const user = userEvent.setup();
    const props = renderPalette();
    const search = screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
    await user.type(search, "move chat");
    expect(screen.getByRole("option", { name: /Move chat to initiative…/u })).toHaveTextContent("Feedback loop");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Move chat to initiative" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search initiatives for this chat" })).toHaveFocus();
    expect(screen.getAllByRole("option").map((option) => option.querySelector("strong")?.textContent))
      .toEqual(["Docs refresh", "New initiative…", "Remove from initiative"]);
    await user.keyboard("{Enter}");
    expect(props.onMoveConversationToInitiative).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: conversation.id }),
      docs.id,
    );
  });

  it("removes the active chat from its initiative and steps back to search", async () => {
    const user = userEvent.setup();
    const props = renderPalette();
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "move chat");
    await user.keyboard("{Enter}");
    await user.keyboard("{Backspace}");
    expect(screen.getByRole("dialog", { name: "Search Inertia" })).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "move chat");
    await user.keyboard("{Enter}");
    await user.type(screen.getByRole("combobox", { name: "Search initiatives for this chat" }), "remove");
    await user.keyboard("{Enter}");
    expect(props.onMoveConversationToInitiative).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: conversation.id }),
      null,
    );
  });

  it("offers no move action without an active chat", () => {
    renderPalette({ activeConversation: null });
    expect(screen.queryByRole("option", { name: /Move chat to initiative/u })).not.toBeInTheDocument();
  });

  it("moves only the visible server chat, never one behind another view, a draft or an archived chat", async () => {
    const user = userEvent.setup();
    expect(commandPaletteConversation("workspace", true, conversation)).toBe(conversation);
    for (const view of ["tasks", "initiatives", "settings", "usage", "home"] as const) {
      expect(commandPaletteConversation(view, true, conversation)).toBeNull();
    }
    // A new-chat draft is on screen but does not exist on the runtime yet.
    expect(commandPaletteConversation("workspace", false, conversation)).toBeNull();
    expect(commandPaletteConversation("workspace", true, { ...conversation, archivedAt: "2026-07-29T08:00:00.000Z" }))
      .toBeNull();
    expect(commandPaletteConversation("workspace", true, null)).toBeNull();

    renderPalette({ activeConversation: commandPaletteConversation("tasks", true, conversation) });
    await user.type(screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }), "move chat");
    expect(screen.queryByRole("option", { name: /Move chat to initiative/u })).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette, type CommandPaletteView } from "../../src/renderer/src/components/CommandPalette";
import type { Conversation, Project } from "../../src/shared/contracts";
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
    expect(screen.getByText("Back")).toBeInTheDocument();

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

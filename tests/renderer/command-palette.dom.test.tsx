import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import type { Conversation, Project } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

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
  modelSelection: nativeModelSelection({ providerId: "codex" }),
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

function palette(open: boolean, onClose = noOp): React.JSX.Element {
  return (
    <CommandPalette
      open={open}
      projects={[project]}
      conversations={[conversation]}
      onClose={onClose}
      onSelectProject={noOp}
      onSelectConversation={noOp}
      onNewThread={noOp}
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
        onClose={() => setOpen(false)}
        onSelectProject={noOp}
        onSelectConversation={noOp}
        onNewThread={noOp}
        onAddProject={noOp}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}

describe("CommandPalette behavior", () => {
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
      name: "Search commands, projects, and threads",
    })).toHaveFocus();
  });

  it("resets keyboard selection when filtering after pointer selection", async () => {
    const user = userEvent.setup();
    render(palette(true));
    const search = screen.getByRole("combobox", {
      name: "Search commands, projects, and threads",
    });
    const settings = screen.getByRole("option", { name: /Open settings/u });

    fireEvent.pointerMove(settings);
    expect(settings).toHaveAttribute("aria-selected", "true");

    await user.type(search, "settings");

    expect(screen.getByRole("option", { name: /Open settings/u }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("clears query and selection after Escape and after running an action", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<ResetHarness onOpenSettings={onOpenSettings} />);
    let search = screen.getByRole("combobox", {
      name: "Search commands, projects, and threads",
    });

    await user.type(search, "settings");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search Inertia" }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    search = screen.getByRole("combobox", {
      name: "Search commands, projects, and threads",
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
      name: "Search commands, projects, and threads",
    })).toHaveValue("");
  });
});

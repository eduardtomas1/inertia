import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import { SETTINGS_ROWS } from "../../src/renderer/src/components/settingsRows";
import type { Project } from "../../src/shared/contracts";

function project(id: string, name: string, workspaceKind?: Project["workspaceKind"]): Project {
  return {
    id,
    name,
    path: `/workspace/${name.toLowerCase()}`,
    normalizedPath: `/workspace/${name.toLowerCase()}`,
    repositoryIdentity: null,
    repositoryRoot: `/workspace/${name.toLowerCase()}`,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 128,
    color: "#5661d8",
    status: "ready",
    createdAt: "2026-07-28T08:00:00.000Z",
    updatedAt: "2026-07-28T08:00:00.000Z",
    ...(workspaceKind ? { workspaceKind } : {}),
  };
}

const studio = project("11111111-1111-4111-8111-111111111111", "Studio");
const website = project("22222222-2222-4222-8222-222222222222", "Website");
const scratch = project("33333333-3333-4333-8333-333333333333", "Scratch", "scratch");

function renderPalette({ projects = [studio, website], currentProjectId = null as string | null } = {}) {
  const onOpenSettings = vi.fn();
  const onClose = vi.fn();
  render(
    <CommandPalette
      open
      projects={projects}
      conversations={[]}
      newThreadShortcut="⌘N"
      onClose={onClose}
      onSelectProject={vi.fn()}
      onSelectConversation={vi.fn()}
      onNewThread={vi.fn()}
      onNewThreadIn={vi.fn()}
      currentProjectId={currentProjectId}
      onAddProject={vi.fn()}
      onOpenSettings={onOpenSettings}
    />,
  );
  const search = screen.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
  return { onOpenSettings, onClose, search };
}

function settingsOptions(): HTMLElement[] {
  const group = screen.queryByRole("group", { name: "Settings" });
  return group ? within(group).getAllByRole("option") : [];
}

describe("Command palette settings entries", () => {
  it("lists a setting by its title with the section as context and opens Settings at its row", () => {
    const { onOpenSettings, onClose, search } = renderPalette();
    fireEvent.change(search, { target: { value: "mode" } });
    const [theme] = settingsOptions();
    expect(theme).toHaveTextContent("ModeAppearance");
    expect(theme!.querySelector("mark")).toHaveTextContent("Mode");
    expect(screen.getAllByRole("option")[0]).toBe(theme);

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith({ section: "appearance", anchor: "appearance-mode" });
  });

  it("finds settings by their keywords and opens the chosen one with a click", () => {
    const { onOpenSettings, search } = renderPalette();
    fireEvent.change(search, { target: { value: "where my data is" } });
    expect(settingsOptions().map((option) => option.textContent)).toEqual(["Local storageData"]);
    fireEvent.change(search, { target: { value: "where is my data" } });
    expect(settingsOptions().map((option) => option.textContent)).toEqual(["Local storageData"]);

    fireEvent.change(search, { target: { value: "keyboard shortcuts" } });
    expect(settingsOptions().map((option) => option.textContent)).toContain("Search everythingKeyboard");
    fireEvent.change(search, { target: { value: "sounds" } });
    fireEvent.click(settingsOptions().find((option) => option.textContent === "Sound when a task endsNotifications")!);
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith({ section: "notifications", anchor: "completion-sound-enabled" });
  });

  it("never shows settings for an empty query and cuts a broad query to the palette's limit", () => {
    const { search } = renderPalette();
    expect(screen.queryByRole("group", { name: "Settings" })).not.toBeInTheDocument();
    expect(SETTINGS_ROWS.filter(({ keywords }) => keywords.includes("general")).length).toBeGreaterThan(18);
    fireEvent.change(search, { target: { value: "general" } });
    expect(settingsOptions()).toHaveLength(18);
    fireEvent.change(search, { target: { value: "  " } });
    expect(screen.queryByRole("group", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("keeps the Open settings action, which opens Settings without a target, and lists it once", () => {
    const { onOpenSettings, search } = renderPalette();
    fireEvent.change(search, { target: { value: "open settings" } });
    expect(screen.getAllByRole("option", { name: /Open settings/u })).toHaveLength(1);
    expect(settingsOptions().map((option) => option.textContent)).not.toContain("Open settingsKeyboard");
    fireEvent.click(within(screen.getByRole("group", { name: "Actions" })).getByRole("option", { name: /Open settings/u }));
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith();
  });

  it("opens project settings rows for the current project, falling back to the first regular project", () => {
    const current = renderPalette({ currentProjectId: website.id });
    fireEvent.change(current.search, { target: { value: "pin to top" } });
    fireEvent.keyDown(current.search, { key: "Enter" });
    expect(current.onOpenSettings).toHaveBeenCalledExactlyOnceWith({ section: "projects", anchor: "project-pin", projectId: website.id });
  });

  it("treats a hidden scratch workspace as no current project", () => {
    const { onOpenSettings, search } = renderPalette({ projects: [scratch, studio, website], currentProjectId: scratch.id });
    fireEvent.change(search, { target: { value: "pin to top" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith({ section: "projects", anchor: "project-pin", projectId: studio.id });
  });

  it("leaves out project rows when there is no regular project, but keeps the all-projects rows", () => {
    const { search } = renderPalette({ projects: [scratch], currentProjectId: scratch.id });
    fireEvent.change(search, { target: { value: "pin to top" } });
    expect(settingsOptions()).toEqual([]);
    fireEvent.change(search, { target: { value: "compact sidebar" } });
    expect(settingsOptions().map((option) => option.textContent)).toEqual(["Compact sidebarProjects"]);
  });
});

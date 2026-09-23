import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectIcon, ProjectName } from "../../src/renderer/src/components/ProjectIcon";
import { ProjectScopePicker } from "../../src/renderer/src/components/sidebar/ProjectScopePicker";
import { Sidebar } from "../../src/renderer/src/components/Sidebar";
import type { SidebarProps } from "../../src/renderer/src/components/sidebar/SidebarProps";
import { loadThreadActions } from "../../src/renderer/src/components/sidebar/threadActionLoader";
import { loadProjectCustomizePanel } from "../../src/renderer/src/components/projectCustomizeLoader";
import { loadProjectColorContrast } from "../../src/renderer/src/lib/projectColorTints";
import type { AppSnapshot, ConversationShell, Project } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { PROJECT_COLOR_PALETTE } from "../../src/shared/project-colors";
import { defaultProjectPreferences, type ProjectAppearancePatch, type ProjectPreferences } from "../../src/shared/project-preferences";

beforeAll(async () => { await Promise.all([loadThreadActions(), loadProjectCustomizePanel(), loadProjectColorContrast()]); });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

function project(id: string, name: string, preferences: Partial<ProjectPreferences> = {}): Project {
  return { id, name, path: `/work/${id}`, normalizedPath: `/work/${id}`, repositoryIdentity: null, repositoryRoot: null,
    repositoryRelativePath: ".", groupingMode: null, gitRepositoryLimit: 16, color: "#6f76d9", status: "ready",
    createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
    preferences: { ...defaultProjectPreferences(), ...preferences } };
}

function chat(id: string, projectId: string, title: string): ConversationShell {
  const at = new Date().toISOString();
  return { id, projectId, title, providerId: "codex", modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null, model: "", reasoningEffort: "", interactionMode: "build", accessMode: "supervised", status: "idle",
    attentionKind: null, branch: null, worktreePath: null, providerSessionId: null, archivedAt: null, settledAt: null, completedAt: null,
    lastViewedAt: at, pinnedAt: null, snoozedUntil: null, createdAt: at, updatedAt: at, latestTurn: null, pendingApproval: false, pendingInput: false };
}

function snapshot(projects: Project[], conversations: ConversationShell[]): AppSnapshot {
  return { projects, conversations, runs: [], providers: [], settings: { ...defaultSettings, sidebarMode: "activity" },
    activeProjectId: projects[0]!.id, activeConversationId: null };
}

const noop = vi.fn();
function sidebarProps(state: AppSnapshot, scope: string | null, onProjectScopeChange: (id: string | null) => void, onUpdateProjectAppearance = vi.fn()): SidebarProps {
  return { snapshot: state, connectionStatus: "online", view: "workspace", open: true, busy: false, layoutWidth: 276, onClose: noop, onViewChange: noop,
    onOpenHome: noop, onImportProject: noop, projectScopeId: scope, onProjectScopeChange, onSelectConversation: noop, splitConversationIds: new Set(),
    onOpenConversationInSplit: noop, onCloseConversationSplit: noop, onCreateConversation: noop, onOpenMultiSpawn: noop, onOpenDailyWork: noop,
    dailyWorkOpen: false, onRenameConversation: noop, onPinConversation: noop, onSnoozeConversation: noop, onArchiveConversation: noop,
    onSettleConversation: noop, onRestoreConversation: noop, onDeleteConversation: noop, onAcknowledgeRun: noop, onDismissRun: noop, onOpenProject: noop,
    onRenameProject: noop, onSetProjectGrouping: noop, onSetProjectGitRepositoryLimit: noop, onRemoveProject: noop, onUpdateProjectAppearance };
}

function projectLine(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title},`, "u") }).querySelector<HTMLElement>(".activity-thread-projectline")!;
}

describe("project colour marks", () => {
  it("lets chats inherit their project's colour and emphasis in the Work sidebar, updating live", () => {
    const studio = project("studio", "Studio", { color: { kind: "palette", name: "blue" }, colorEmphasis: "icon-and-name" });
    const other = project("other", "Other");
    const conversations = [chat("a", "studio", "Studio review"), chat("b", "studio", "Studio polish"), chat("c", "other", "Other task")];
    const view = render(<Sidebar {...sidebarProps(snapshot([studio, other], conversations), null, noop)} />);
    for (const title of ["Studio review", "Studio polish"]) {
      const line = projectLine(title);
      const name = line.querySelector<HTMLElement>(".activity-thread-project-meta")!;
      expect(name).toHaveClass("project-name-tinted");
      expect(name.style.getPropertyValue("--project-tint-dark")).toBe(PROJECT_COLOR_PALETTE.blue.dark);
      expect(name.style.getPropertyValue("--project-tint-light")).toBe(PROJECT_COLOR_PALETTE.blue.light);
      expect(line.querySelector("svg")).toHaveAttribute("data-project-tinted", "true");
    }
    const untinted = projectLine("Other task");
    expect(untinted.querySelector(".project-name-tinted")).toBeNull();
    expect(untinted.querySelector("svg")).not.toHaveAttribute("data-project-tinted");
    expect(untinted.querySelector<SVGElement>("svg")?.getAttribute("style")).toBeNull();
    const iconOnly = { ...studio, preferences: { ...studio.preferences!, colorEmphasis: "icon" as const } };
    view.rerender(<Sidebar {...sidebarProps(snapshot([iconOnly, other], conversations), null, noop)} />);
    expect(projectLine("Studio review").querySelector(".project-name-tinted")).toBeNull();
    expect(projectLine("Studio review").querySelector("svg")).toHaveAttribute("data-project-tinted", "true");
    const cleared = { ...studio, preferences: { ...studio.preferences!, color: null } };
    view.rerender(<Sidebar {...sidebarProps(snapshot([cleared, other], conversations), null, noop)} />);
    expect(projectLine("Studio polish").querySelector("[data-project-tinted]")).toBeNull();
  });

  it("renders the filter trigger and menu coherently, with pinned projects first", () => {
    const projects = [project("one", "Website"), project("two", "Runtime", { pinned: true, color: { kind: "palette", name: "green" }, colorEmphasis: "icon-and-name" })];
    function Picker() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return <ProjectScopePicker projects={projects} selectedId={selectedId} onSelect={setSelectedId} onAdd={vi.fn()} disabled={false} />;
    }
    render(<Picker />);
    const trigger = screen.getByRole("button", { name: "Filter work by project" });
    expect(trigger.querySelector(".lucide-folders")).not.toBeNull();
    expect(trigger).toHaveAccessibleDescription("Showing all projects");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual(["All projects", "Runtime, pinned", "Website"]);
    expect(screen.getByRole("option", { name: "All projects" }).querySelector(".lucide-folders")).not.toBeNull();
    expect(screen.getByRole("option", { name: "Runtime, pinned" }).querySelector(".project-name-tinted")).toHaveTextContent("Runtime");
    fireEvent.click(screen.getByRole("option", { name: "Runtime, pinned" }));
    expect(trigger.querySelector(".lucide-folders")).toBeNull();
    expect(trigger.querySelector("svg[data-project-tinted]")).not.toBeNull();
    expect(trigger.querySelector(".project-name-tinted")).toHaveTextContent("Runtime");
    expect(trigger).toHaveAccessibleDescription("Showing Runtime");
  });

  it("rings an imported image icon instead of tinting it, and leaves default icons neutral", () => {
    const { container } = render(<>
      <ProjectIcon project={project("img", "Image", { icon: { kind: "image", data: PNG }, color: { kind: "palette", name: "red" } })} />
      <ProjectIcon project={project("plain", "Plain")} />
      <ProjectName project={project("img", "Image", { color: { kind: "custom", value: "#101010" }, colorEmphasis: "icon-and-name" })}>Image</ProjectName>
    </>);
    const image = container.querySelector("img")!;
    expect(image).toHaveClass("project-custom-icon", "has-project-tint");
    expect(image.style.getPropertyValue("--project-tint-dark")).toBe(PROJECT_COLOR_PALETTE.red.dark);
    expect(container.querySelector<SVGElement>("svg")?.getAttribute("style")).toBeNull();
    expect(container.querySelector("svg")).not.toHaveAttribute("data-project-tinted");
    const name = screen.getByText("Image");
    expect(name.style.getPropertyValue("--project-tint-light")).toBe("#101010");
    expect(name.style.getPropertyValue("--project-tint-dark")).not.toBe("#101010");
  });
});

describe("customising a project from the filter menu", () => {
  function renderPicker(onCustomize: (project: Project, patch: ProjectAppearancePatch) => Promise<void>) {
    let projects = [project("one", "Website"), project("two", "Runtime")];
    const onOpenSettings = vi.fn();
    const view = render(<ProjectScopePicker projects={projects} selectedId={null} onSelect={vi.fn()} onAdd={vi.fn()} disabled={false}
      onCustomize={onCustomize} onOpenSettings={onOpenSettings} />);
    const publish = (id: string, patch: ProjectAppearancePatch) => {
      projects = projects.map((candidate) => candidate.id === id ? { ...candidate, preferences: { ...candidate.preferences!, ...patch } } : candidate);
      view.rerender(<ProjectScopePicker projects={projects} selectedId={null} onSelect={vi.fn()} onAdd={vi.fn()} disabled={false}
        onCustomize={onCustomize} onOpenSettings={onOpenSettings} />);
    };
    return { ...view, publish, onOpenSettings };
  }

  it("picks colour, emphasis, icon and pinning with the keyboard, then returns focus", async () => {
    const onCustomize = vi.fn(async () => undefined);
    const view = renderPicker(onCustomize);
    const trigger = screen.getByRole("button", { name: "Filter work by project" });
    fireEvent.click(trigger);
    const customise = screen.getByRole("button", { name: "Customise Website" });
    fireEvent.click(customise);
    const dialog = screen.getByRole("dialog", { name: "Customise Website" });
    const colours = within(dialog).getByRole("radiogroup", { name: "Project colour" });
    expect(within(colours).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label")))
      .toEqual(["Default", "Red", "Orange", "Amber", "Green", "Teal", "Blue", "Violet", "Pink"]);
    const standard = within(colours).getByRole("radio", { name: "Default" });
    expect(standard).toHaveFocus();
    expect(standard).toHaveAttribute("aria-checked", "true");
    expect(within(colours).getAllByRole("radio").filter((radio) => radio.tabIndex === 0)).toEqual([standard]);
    fireEvent.keyDown(standard, { key: "ArrowRight" });
    expect(within(colours).getByRole("radio", { name: "Red" })).toHaveFocus();
    expect(within(colours).getByRole("radio", { name: "Red" })).toHaveAttribute("aria-checked", "true");
    expect(onCustomize).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one" }), { color: { kind: "palette", name: "red" } });
    fireEvent.keyDown(within(colours).getByRole("radio", { name: "Red" }), { key: "End" });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one" }), { color: { kind: "palette", name: "pink" } });
    fireEvent.keyDown(within(colours).getByRole("radio", { name: "Pink" }), { key: "ArrowRight" });
    expect(within(colours).getByRole("radio", { name: "Default" })).toHaveFocus();
    expect(onCustomize).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one" }), { color: null });
    fireEvent.keyDown(within(colours).getByRole("radio", { name: "Default" }), { key: "ArrowLeft" });
    view.publish("one", { color: { kind: "palette", name: "pink" } });
    expect(dialog.querySelector(".project-customize-title .project-icon-symbol")).toHaveAttribute("data-project-tinted", "true");
    const emphasis = within(dialog).getByRole("radiogroup", { name: "Colour shows on" });
    fireEvent.keyDown(within(emphasis).getByRole("radio", { name: "Icon only" }), { key: "ArrowRight" });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { colorEmphasis: "icon-and-name" });
    expect(dialog.querySelector(".project-customize-title .project-name-tinted")).toHaveTextContent("Website");
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Project icon" })).getByRole("radio", { name: "database icon" }));
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { icon: { kind: "symbol", name: "database" } });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Pin to top of project lists" }));
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { pinned: true });
    fireEvent.keyDown(within(dialog).getByRole("switch", { name: "Pin to top of project lists" }), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Customise Website" })).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Choose project filter" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Customise Website" }), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reverts an optimistic change when the save fails and keeps the error actionable", async () => {
    const onCustomize = vi.fn(async () => { throw new Error("The runtime is offline."); });
    renderPicker(onCustomize);
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", { name: "Customise Runtime" }));
    const dialog = screen.getByRole("dialog", { name: "Customise Runtime" });
    await act(async () => { fireEvent.click(within(dialog).getByRole("radio", { name: "Teal" })); });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The runtime is offline.");
    expect(within(dialog).getByRole("radio", { name: "Default" })).toHaveAttribute("aria-checked", "true");
  });

  it("accepts a typed custom colour, rejects malformed input, and opens full settings", () => {
    const onCustomize = vi.fn(async () => undefined);
    const view = renderPicker(onCustomize);
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", { name: "Customise Website" }));
    const hex = screen.getByRole("textbox", { name: "Custom colour hex value" });
    fireEvent.change(hex, { target: { value: "blue-ish" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(hex).toHaveAccessibleDescription(/hex colour/u);
    expect(onCustomize).not.toHaveBeenCalled();
    fireEvent.change(hex, { target: { value: "#3A86FF" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one" }), { color: { kind: "custom", value: "#3a86ff" } });
    expect(screen.getByRole("radio", { name: "Custom #3a86ff" })).toHaveAttribute("aria-checked", "true");
    const input = screen.getByLabelText("Pick a custom colour") as HTMLInputElement;
    expect(input.value).toBe("#3a86ff");
    fireEvent.change(input, { target: { value: "#00aa55" } });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { color: { kind: "custom", value: "#00aa55" } });
    fireEvent.click(screen.getByRole("button", { name: "All project settings" }));
    expect(view.onOpenSettings).toHaveBeenCalledWith(expect.objectContaining({ id: "one" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns to the project list with focus in search when the project disappears mid-customisation", () => {
    const onCustomize = vi.fn(async () => undefined);
    const projects = [project("one", "Website"), project("two", "Runtime")];
    const view = render(<ProjectScopePicker projects={projects} selectedId={null} onSelect={vi.fn()} onAdd={vi.fn()} disabled={false} onCustomize={onCustomize} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", { name: "Customise Runtime" }));
    expect(screen.getByRole("dialog", { name: "Customise Runtime" })).toBeInTheDocument();
    view.rerender(<ProjectScopePicker projects={[projects[0]!]} selectedId={null} onSelect={vi.fn()} onAdd={vi.fn()} disabled={false} onCustomize={onCustomize} />);
    expect(screen.getByRole("dialog", { name: "Choose project filter" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search projects" })).toHaveFocus();
    expect(screen.queryByRole("option", { name: "Runtime" })).not.toBeInTheDocument();
  });

  it("keeps a custom colour and an imported image selectable after arrowing away from them", () => {
    const onCustomize = vi.fn(async () => undefined);
    const view = renderPicker(onCustomize);
    view.publish("one", { color: { kind: "custom", value: "#3a86ff" }, icon: { kind: "image", data: PNG } });
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", { name: "Customise Website" }));
    const colours = screen.getByRole("radiogroup", { name: "Project colour" });
    const custom = within(colours).getByRole("radio", { name: "Custom #3a86ff" });
    expect(custom).toHaveFocus();
    fireEvent.keyDown(custom, { key: "ArrowRight" });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { color: null });
    view.publish("one", { color: null });
    expect(within(colours).getByRole("radio", { name: "Custom #3a86ff" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("textbox", { name: "Custom colour hex value" })).toHaveValue("#3a86ff");
    fireEvent.blur(screen.getByRole("textbox", { name: "Custom colour hex value" }));
    expect(onCustomize).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(within(colours).getByRole("radio", { name: "Default" }), { key: "ArrowLeft" });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { color: { kind: "custom", value: "#3a86ff" } });
    const icons = screen.getByRole("radiogroup", { name: "Project icon" });
    fireEvent.keyDown(within(icons).getByRole("radio", { name: "Imported image" }), { key: "ArrowRight" });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { icon: { kind: "symbol", name: "folder" } });
    view.publish("one", { icon: { kind: "symbol", name: "folder" } });
    fireEvent.keyDown(within(icons).getByRole("radio", { name: "folder icon" }), { key: "ArrowLeft" });
    expect(onCustomize).toHaveBeenLastCalledWith(expect.anything(), { icon: { kind: "image", data: PNG } });
  });

  it("keeps a newer optimistic colour when an older save fails", async () => {
    const settle: Array<(error?: Error) => void> = [];
    const onCustomize = vi.fn(() => new Promise<void>((resolve, reject) => { settle.push((error) => error ? reject(error) : resolve()); }));
    renderPicker(onCustomize);
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", { name: "Customise Website" }));
    const colours = screen.getByRole("radiogroup", { name: "Project colour" });
    fireEvent.click(within(colours).getByRole("radio", { name: "Red" }));
    fireEvent.click(within(colours).getByRole("radio", { name: "Blue" }));
    await act(async () => { settle[0]!(new Error("Stale write rejected.")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Stale write rejected.");
    expect(within(colours).getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
    await act(async () => { settle[1]!(); });
  });

  it("leaves customisation safely when the runtime goes offline mid-edit", () => {
    const onCustomize = vi.fn(async () => undefined);
    const projects = [project("one", "Website")];
    const view = render(<ProjectScopePicker projects={projects} selectedId={null} onSelect={vi.fn()} onAdd={vi.fn()} disabled={false} onCustomize={onCustomize} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", { name: "Customise Website" }));
    view.rerender(<ProjectScopePicker projects={projects} selectedId={null} onSelect={vi.fn()} onAdd={vi.fn()} disabled={false} />);
    expect(screen.getByRole("dialog", { name: "Choose project filter" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search projects" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Customise Website" })).not.toBeInTheDocument();
    view.rerender(<ProjectScopePicker projects={projects} selectedId={null} onSelect={vi.fn()} onAdd={vi.fn()} disabled={false} onCustomize={onCustomize} />);
    expect(screen.queryByRole("dialog", { name: "Customise Website" })).not.toBeInTheDocument();
  });
});

// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPicker } from "../../src/renderer/src/components/composer/ProjectPicker";
import type { Project } from "../../src/shared/contracts";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/workspace/${id}`,
    normalizedPath: `/workspace/${id}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 128,
    color: "#5661d8",
    status: "ready",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

const projects = [
  project("alpha", "Alpha"),
  project("beta", "Beta"),
  project("gamma", "Gamma"),
];

afterEach(() => vi.restoreAllMocks());

describe("ProjectPicker", () => {
  it("offers No project once and selects it without changing the saved project list", () => {
    const { search, onChange } = mount();
    fireEvent.change(search, { target: { value: "no project" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows the managed container as a selected No project choice without its filesystem path", () => {
    const managed: Project = { ...projects[0]!, id: "scratch", name: "No project", workspaceKind: "scratch", path: "/private/data/scratch" };
    const { onChange } = mount(managed, [...projects, managed]);
    expect(screen.getAllByRole("option", { name: "No project" })).toHaveLength(1);
    expect(screen.getByRole("option", { name: "No project" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "No project" })).toHaveAccessibleDescription("Start in a separate local folder");
    expect(screen.queryByText(managed.path)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "No project" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  function mount(selectedProject = projects[0]!, choices = projects) {
    const onChange = vi.fn();
    const props = { projects: choices, selectedProject, disabled: false, onChange };
    const view = render(<ProjectPicker picker={props} />);
    const trigger = screen.getByRole("button", { name: "Project" });
    trigger.focus();
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search projects" });
    return { ...view, props, trigger, search, onChange };
  }

  it("focuses search, selects with the keyboard, and restores trigger focus", () => {
    const { trigger, search, onChange } = mount();
    expect(search).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Alpha" }).id);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Beta" }).id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(projects[1]);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("searches names and paths, clears an empty result, and selects the first match", () => {
    const { search, onChange } = mount(projects[2]!);
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No matching projects")).toBeVisible();
    expect(search).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: "/workspace/beta" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(projects[1]);
  });

  it("scrolls boundary-key selection into view in long lists", () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const many = Array.from({ length: 20 }, (_, index) => project(`p${index}`, `Project ${index}`));
    const { search } = mount(many[0]!, many);
    fireEvent.keyDown(search, { key: "End" });
    expect(scroll.mock.instances.at(-1)).toBe(screen.getByRole("option", { name: "Project 19" }));
    fireEvent.keyDown(search, { key: "Home" });
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "No project" }).id);
  });

  it("preserves text editing and does not select while an IME composition is committing", () => {
    const { search, onChange } = mount();
    fireEvent.change(search, { target: { value: "a" } });
    const active = search.getAttribute("aria-activedescendant");
    expect(fireEvent.keyDown(search, { key: "End" })).toBe(true);
    expect(search).toHaveAttribute("aria-activedescendant", active);
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    fireEvent.keyDown(search, { key: "Escape", isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("preserves option identity through reorder and falls back when it disappears", () => {
    const { search, rerender, props, onChange } = mount();
    fireEvent.keyDown(search, { key: "End" });
    rerender(<ProjectPicker picker={{ ...props, projects: [projects[2]!, projects[1]!, projects[0]!] }} />);
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Gamma" }).id);
    rerender(<ProjectPicker picker={{ ...props, projects: [projects[1]!, projects[0]!] }} />);
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Alpha" }).id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dismisses with Escape or the same trigger without changing projects", () => {
    const { search, trigger, onChange } = mount();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes without changing ownership when switching becomes disabled", () => {
    const { trigger, rerender, props, onChange } = mount();
    rerender(<ProjectPicker picker={{ ...props, disabled: true }} />);
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

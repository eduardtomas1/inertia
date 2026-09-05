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
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Project 0" }).id);
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

  it("dismisses with Escape or the backdrop without changing projects", () => {
    const { search, trigger, onChange } = mount();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
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

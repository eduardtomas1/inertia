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
  it("exposes active option state and selects projects from the keyboard", () => {
    const onChange = vi.fn();
    render(<ProjectPicker picker={{
      projects,
      selectedProject: projects[0]!,
      disabled: false,
      onChange,
    }} />);
    const picker = screen.getByRole("combobox", { name: "Project" });
    expect(picker).toHaveTextContent("Alpha");
    expect(picker).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(picker).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Alpha" }).id,
    );

    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Beta" }).id,
    );
    fireEvent.keyDown(picker, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(projects[1]);
    expect(picker).toHaveAttribute("aria-expanded", "false");
  });

  it("supports boundary keys and typeahead while retaining trigger focus", () => {
    const onChange = vi.fn();
    render(<ProjectPicker picker={{
      projects,
      selectedProject: projects[0]!,
      disabled: false,
      onChange,
    }} />);
    const picker = screen.getByRole("combobox", { name: "Project" });
    picker.focus();

    fireEvent.keyDown(picker, { key: "End" });
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Gamma" }).id,
    );
    fireEvent.keyDown(picker, { key: "Home" });
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Alpha" }).id,
    );
    fireEvent.keyDown(picker, { key: "g" });
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Gamma" }).id,
    );
    expect(picker).toHaveFocus();

    fireEvent.keyDown(picker, { key: " " });
    expect(onChange).toHaveBeenCalledWith(projects[2]);
  });

  it("scrolls a keyboard-active option into view in long project lists", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const manyProjects = Array.from({ length: 12 }, (_, index) => (
      project(`project-${index}`, `Project ${index}`)
    ));
    render(<ProjectPicker picker={{
      projects: manyProjects,
      selectedProject: manyProjects[0]!,
      disabled: false,
      onChange: vi.fn(),
    }} />);
    const picker = screen.getByRole("combobox", { name: "Project" });

    fireEvent.keyDown(picker, { key: "End" });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances.at(-1))
      .toBe(screen.getByRole("option", { name: "Project 11" }));
  });

  it("keeps active-option identity valid when projects reorder or disappear", () => {
    const onChange = vi.fn();
    const view = render(<ProjectPicker picker={{
      projects,
      selectedProject: projects[0]!,
      disabled: false,
      onChange,
    }} />);
    const picker = screen.getByRole("combobox", { name: "Project" });
    fireEvent.keyDown(picker, { key: "End" });

    view.rerender(<ProjectPicker picker={{
      projects: [projects[1]!, projects[0]!, projects[2]!],
      selectedProject: projects[0]!,
      disabled: false,
      onChange,
    }} />);
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Gamma" }).id,
    );

    view.rerender(<ProjectPicker picker={{
      projects: [projects[1]!, projects[0]!],
      selectedProject: projects[0]!,
      disabled: false,
      onChange,
    }} />);
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Alpha" }).id,
    );
    fireEvent.keyDown(picker, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cycles matching projects on repeated typeahead letters", () => {
    const google = project("google", "Google");
    const gamma = project("gamma-second", "Gamma");
    render(<ProjectPicker picker={{
      projects: [projects[0]!, google, gamma],
      selectedProject: projects[0]!,
      disabled: false,
      onChange: vi.fn(),
    }} />);
    const picker = screen.getByRole("combobox", { name: "Project" });

    fireEvent.keyDown(picker, { key: "g" });
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Google" }).id,
    );
    fireEvent.keyDown(picker, { key: "g" });
    expect(picker).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Gamma" }).id,
    );
  });

  it("closes and prevents selection when switching becomes disabled", () => {
    const onChange = vi.fn();
    const view = render(<ProjectPicker picker={{
      projects,
      selectedProject: projects[0]!,
      disabled: false,
      onChange,
    }} />);
    const picker = screen.getByRole("combobox", { name: "Project" });
    fireEvent.click(picker);
    expect(picker).toHaveAttribute("aria-expanded", "true");

    view.rerender(<ProjectPicker picker={{
      projects,
      selectedProject: projects[0]!,
      disabled: true,
      onChange,
    }} />);

    expect(picker).toBeDisabled();
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(onChange).not.toHaveBeenCalled();
  });
});

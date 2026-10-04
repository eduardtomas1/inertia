import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectSettings } from "../../src/renderer/src/components/ProjectSettings";
import type { Project } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import type { IssueReportSettingsProps } from "../../src/renderer/src/components/IssueReportSettings";
import { provider } from "./composer-fixtures";

const FULL_ACCESS_WARNING = "Full access lets the agent act without asking. Choose it only for a workspace and task you trust.";
const project: Project = { id: "11111111-1111-4111-8111-111111111111", name: "Studio", path: "/workspace/studio", normalizedPath: "/workspace/studio",
  repositoryIdentity: "git:/workspace/studio/.git", repositoryRoot: "/workspace/studio", repositoryRelativePath: "",
  groupingMode: null, gitRepositoryLimit: 128, color: "#5661d8", status: "ready", createdAt: "2026-09-09T08:00:00.000Z",
  updatedAt: "2026-09-09T08:00:00.000Z", preferences: defaultProjectPreferences() };

function setup(overrides: { project?: Project; settings?: typeof defaultSettings; disabled?: boolean } = {}) {
  const selected = overrides.project ?? project;
  const request = vi.fn<IssueReportSettingsProps["request"]>().mockResolvedValue({ type: "request.ok", requestId: "test" });
  const props = { projects: [selected], conversations: [], providers: [provider], backendDefaults: [], backendProfiles: [],
    settings: overrides.settings ?? defaultSettings, disabled: overrides.disabled ?? false, request, onUpdateSettings: vi.fn(), initialProjectId: selected.id };
  const view = render(<ProjectSettings {...props} />);
  return { ...view, request, props };
}

function row(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!;
}

describe("project default access", () => {
  it("shows the inherited global access and saves a project override", async () => {
    const { container, request } = setup({ settings: { ...defaultSettings, defaultAccessMode: "auto-edit" } });
    const select = screen.getByRole("combobox", { name: "Default access in this project" });
    expect(row(container, "project-default-access")).toContainElement(select);
    expect(select).toHaveValue("");
    expect(within(select).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Default (Auto-accept edits)", "Supervised", "Auto-accept edits", "Full access"]);
    expect(row(container, "project-default-access")).toHaveTextContent(FULL_ACCESS_WARNING);

    fireEvent.change(select, { target: { value: "supervised" } });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.update", payload: {
      projectId: project.id, expectedUpdatedAt: project.updatedAt,
      preferences: { ...defaultProjectPreferences(), defaultAccessMode: "supervised" } } }));
  });

  it("keeps the Full access caution in place while the choice changes and can return to the default", async () => {
    const full = { ...project, preferences: { ...defaultProjectPreferences(), defaultAccessMode: "full" as const } };
    const { container, request, rerender, props } = setup({ project: full });
    const select = screen.getByRole("combobox", { name: "Default access in this project" });
    expect(select).toHaveValue("full");
    expect(row(container, "project-default-access")).toHaveTextContent(FULL_ACCESS_WARNING);
    expect(within(row(container, "project-default-access")).queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.update", payload: {
      projectId: project.id, expectedUpdatedAt: project.updatedAt, preferences: { ...full.preferences, defaultAccessMode: null } } }));
    rerender(<ProjectSettings {...props} projects={[project]} />);
    expect(row(container, "project-default-access")).toHaveTextContent(FULL_ACCESS_WARNING);
  });

  it("is unavailable while the project cannot be edited", () => {
    setup({ disabled: true });
    expect(screen.getByRole("combobox", { name: "Default access in this project" })).toBeDisabled();
  });
});

describe("project repository display limit", () => {
  it("keeps the limit under Advanced with the sidebar's choices and saves it", async () => {
    const { container, request } = setup();
    const select = screen.getByRole("combobox", { name: "Repository display limit" });
    const advanced = select.closest("details")!;
    expect(advanced).not.toHaveAttribute("open");
    expect(within(advanced).getByText("Advanced")).toBeInTheDocument();
    expect(row(container, "project-repository-limit")).toContainElement(select);
    expect(select).toHaveValue("128");
    expect(within(select).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Show up to 16 repositories", "Show up to 32 repositories", "Show up to 128 repositories"]);

    fireEvent.change(select, { target: { value: "16" } });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.update", payload: {
      projectId: project.id, expectedUpdatedAt: project.updatedAt, gitRepositoryLimit: 16 } }));
  });

  it("shows a stored limit outside the two choices as it is", () => {
    setup({ project: { ...project, gitRepositoryLimit: 24 } });
    const select = screen.getByRole("combobox", { name: "Repository display limit" });
    expect(select).toHaveValue("24");
    expect(within(select).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Show up to 16 repositories", "Show up to 24 repositories", "Show up to 32 repositories"]);
  });
});

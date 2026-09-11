import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectSettings } from "../../src/renderer/src/components/ProjectSettings";
import type { Project } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import type { IssueReportSettingsProps } from "../../src/renderer/src/components/IssueReportSettings";
import { provider, conversation } from "./composer-fixtures";

const project: Project = { id: "11111111-1111-4111-8111-111111111111", name: "Studio", path: "/workspace/studio", normalizedPath: "/workspace/studio",
  repositoryIdentity: "git:/workspace/studio/.git", repositoryRoot: "/workspace/studio", repositoryRelativePath: "",
  groupingMode: null, gitRepositoryLimit: 16, color: "#5661d8", status: "ready", createdAt: "2026-09-09T08:00:00.000Z",
  updatedAt: "2026-09-09T08:00:00.000Z", preferences: defaultProjectPreferences() };
function setup(extra: Partial<React.ComponentProps<typeof ProjectSettings>> = {}) {
  const request = vi.fn<IssueReportSettingsProps["request"]>().mockResolvedValue({ type: "request.ok", requestId: "test" });
  const props = { projects: [project, { ...project, id: "second", name: "Second project" }], conversations: [], providers: [provider],
    backendDefaults: [], backendProfiles: [], settings: defaultSettings, disabled: false, request, onUpdateSettings: vi.fn(), initialProjectId: project.id, ...extra };
  const view = render(<ProjectSettings {...props} />);
  return { ...view, request, props };
}
describe("project settings", () => {
  it("saves against the original project revision, without a machine selector or automatic command execution", async () => {
    const { request } = setup();
    expect(screen.queryByText("All machines")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Renamed studio" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/u }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.update", payload: {
      projectId: project.id, expectedUpdatedAt: project.updatedAt, name: "Renamed studio" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add action" })).toBeEnabled());
    request.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Check" } });
    fireEvent.change(screen.getByLabelText("Executable", { exact: true }), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Arguments (one per line)"), { target: { value: "--version\nliteral & data" } });
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toMatchObject({ type: "project.update", payload: { projectId: project.id,
      preferences: { actions: [{ name: "Check", executable: "node", args: ["--version", "literal & data"] }] } } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save action" })).not.toBeInTheDocument());
  });
  it("allows keyboard project search and discards the previous project's unsaved name", async () => {
    setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Private unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose project" }));
    const search = screen.getByRole("combobox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "Second" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Second project");
    expect(screen.queryByRole("dialog", { name: "Choose project" })).not.toBeInTheDocument();
    await act(async () => {});
  });
  it("blocks edits offline, guards active-work removal, and keeps failed saves actionable", async () => {
    const view = setup({ disabled: true });
    expect(screen.getByRole("textbox", { name: "Project name" })).toBeDisabled();
    view.rerender(<ProjectSettings {...view.props} disabled={false} conversations={[{ ...conversation("busy"), status: "running" }]} />);
    expect(screen.getByRole("button", { name: "Remove project" })).toBeDisabled();
    view.request.mockRejectedValueOnce(new Error("The project changed in another window. Refresh and try again."));
    fireEvent.change(screen.getByRole("combobox", { name: "Agent browser access" }), { target: { value: "false" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another window");
    expect(screen.getByRole("combobox", { name: "Agent browser access" })).toBeEnabled();
  });
});

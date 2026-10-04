import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectSettings } from "../../src/renderer/src/components/ProjectSettings";
import type { Project, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import type { IssueReportSettingsProps } from "../../src/renderer/src/components/IssueReportSettings";
import { provider, conversation, deferred } from "./composer-fixtures";

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
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed studio" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Name" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.update", payload: {
      projectId: project.id, expectedUpdatedAt: project.updatedAt, name: "Renamed studio" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add action" })).not.toHaveAttribute("aria-disabled"));
    request.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    fireEvent.change(within(screen.getByRole("form", { name: "New action" })).getByLabelText("Name", { exact: true }), { target: { value: "Check" } });
    fireEvent.change(screen.getByLabelText("Executable", { exact: true }), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Arguments (one per line)"), { target: { value: "--version\nliteral & data" } });
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toMatchObject({ type: "project.update", payload: { projectId: project.id,
      preferences: { actions: [{ name: "Check", executable: "node", args: ["--version", "literal & data"] }] } } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save action" })).not.toBeInTheDocument());
  });
  it("saves the name on Enter with row-level feedback, never while typing, and keeps an empty name as a local error", async () => {
    const { container, request } = setup();
    const field = screen.getByRole("textbox", { name: "Name" });
    const row = container.querySelector<HTMLElement>('[data-setting-id="project-name"]')!;
    expect(screen.queryByRole("button", { name: /^Save$/u })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: "  " } });
    expect(request).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Enter a project name.");
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: " Studio two " } });
    expect(field).not.toHaveAttribute("aria-invalid");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.update", payload: {
      projectId: project.id, expectedUpdatedAt: project.updatedAt, name: "Studio two" } }));
    expect(await within(row).findByText("Saved")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("shows a failed rename in the name row and keeps the typed name", async () => {
    const { container, request } = setup();
    request.mockRejectedValueOnce(new Error("The project changed in another window. Refresh and try again."));
    const field = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(field, { target: { value: "Renamed studio" } });
    fireEvent.blur(field);
    const row = container.querySelector<HTMLElement>('[data-setting-id="project-name"]')!;
    expect(await within(row).findByRole("alert")).toHaveTextContent("changed in another window");
    expect(field).toHaveValue("Renamed studio");
  });
  it("allows keyboard project search and does not carry a draft name into the next project", async () => {
    setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Private unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose project" }));
    const search = screen.getByRole("combobox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "Second" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Second project");
    expect(screen.queryByRole("dialog", { name: "Choose project" })).not.toBeInTheDocument();
    await act(async () => {});
  });
  it("blocks edits offline, guards active-work removal, and keeps failed saves actionable", async () => {
    const view = setup({ disabled: true });
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    view.rerender(<ProjectSettings {...view.props} disabled={false} conversations={[{ ...conversation("busy"), status: "running" }]} />);
    expect(screen.getByRole("button", { name: "Remove project" })).toHaveAttribute("aria-disabled", "true");
    view.request.mockRejectedValueOnce(new Error("The project changed in another window. Refresh and try again."));
    fireEvent.change(screen.getByRole("combobox", { name: "Agent browser access" }), { target: { value: "false" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another window");
    expect(screen.getByRole("combobox", { name: "Agent browser access" })).toBeEnabled();
  });
  it("saves an optional Claude spend limit on blur, rejects amounts the schema rejects, and clears back to no limit", async () => {
    const view = setup();
    const field = screen.getByRole("textbox", { name: "Claude spend limit per turn (USD)" });
    const row = view.container.querySelector<HTMLElement>('[data-setting-id="project-spend-limit"]')!;
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "No limit");
    expect(field).toHaveAttribute("inputmode", "decimal");
    expect(screen.getByText(/subagents count toward it/u)).toBeInTheDocument();
    for (const value of ["0", "-1", "10000.01", "1.234", "abc"]) {
      fireEvent.change(field, { target: { value } });
      expect(field).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByText(/0\.01 to 10,000/u)).not.toBeInTheDocument();
      fireEvent.blur(field);
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription(/0\.01 to 10,000/u);
      expect(screen.queryByRole("button", { name: "Save spend limit" })).not.toBeInTheDocument();
    }
    expect(view.request).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "2.50" } });
    expect(field).not.toHaveAttribute("aria-invalid");
    fireEvent.blur(field);
    await waitFor(() => expect(view.request).toHaveBeenCalledWith({ type: "project.update", payload: { projectId: project.id,
      expectedUpdatedAt: project.updatedAt, preferences: { ...defaultProjectPreferences(), claudeMaxBudgetUsd: 2.5 } } }));
    expect(await within(row).findByText("Saved")).toBeInTheDocument();
    view.request.mockClear();
    const saved = { ...project, updatedAt: "2026-09-09T08:01:00.000Z", preferences: { ...defaultProjectPreferences(), claudeMaxBudgetUsd: 2.5 } };
    view.rerender(<ProjectSettings {...view.props} projects={[saved, view.props.projects[1]!]} />);
    expect(field).toHaveValue("2.5");
    fireEvent.change(field, { target: { value: "2.50" } });
    fireEvent.blur(field);
    expect(view.request).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "" } });
    expect(field).not.toHaveAttribute("aria-invalid");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(view.request).toHaveBeenCalledWith({ type: "project.update", payload: { projectId: project.id,
      expectedUpdatedAt: saved.updatedAt, preferences: { ...defaultProjectPreferences(), claudeMaxBudgetUsd: null } } }));
  });
  it("waits for an appearance save before sending full preferences against the refreshed revision", async () => {
    const pending = deferred<ServerEvent>();
    const tinted: Project = { ...project, updatedAt: "2026-09-09T08:02:00.000Z",
      preferences: { ...defaultProjectPreferences(), color: { kind: "palette", name: "pink" } } };
    const request = vi.fn<IssueReportSettingsProps["request"]>().mockImplementation(async (command) => {
      if (command.type === "project.update" && command.payload.appearance) return pending.promise;
      if (command.type === "project.update" && command.payload.expectedUpdatedAt !== tinted.updatedAt) {
        throw new Error("This project changed in another view.");
      }
      return { type: "request.ok", requestId: "saved" };
    });
    const view = setup({ request });
    const workspace = screen.getByRole("combobox", { name: "Where new chats run in this project" });
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Pink" }));
      fireEvent.change(workspace, { target: { value: "worktree" } });
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(workspace).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Choose icon" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Add action" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      // Mutation snapshots arrive before request.ok, matching the runtime router.
      view.rerender(<ProjectSettings {...view.props} projects={[tinted]} />);
      pending.resolve({ type: "request.ok", requestId: "appearance-saved" });
    });
    expect(workspace).not.toHaveAttribute("aria-disabled");
    fireEvent.change(workspace, { target: { value: "worktree" } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ type: "project.update", payload: {
      projectId: project.id, expectedUpdatedAt: tinted.updatedAt,
      preferences: { ...tinted.preferences!, workspace: "worktree" },
    } }));
    await waitFor(() => expect(workspace).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("guards appearance changes during a full save and unlocks them after a failure", async () => {
    const pending = deferred<ServerEvent>();
    const request = vi.fn<IssueReportSettingsProps["request"]>()
      .mockResolvedValue({ type: "request.ok", requestId: "saved" })
      .mockReturnValueOnce(pending.promise);
    setup({ request });
    const workspace = screen.getByRole("combobox", { name: "Where new chats run in this project" });
    const colour = screen.getByRole("radio", { name: "Pink" });
    const emphasis = screen.getByRole("radio", { name: "Icon and name" });
    const pinned = screen.getByRole("switch", { name: "Pin to top of project lists" });
    act(() => {
      fireEvent.change(workspace, { target: { value: "worktree" } });
      fireEvent.click(colour);
      fireEvent.click(emphasis);
      fireEvent.click(pinned);
    });
    expect(request).toHaveBeenCalledTimes(1);
    for (const control of [workspace, colour, emphasis, pinned]) expect(control).toHaveAttribute("aria-disabled", "true");
    await act(async () => pending.reject(new Error("The runtime is offline.")));
    expect(screen.getByRole("alert")).toHaveTextContent("The runtime is offline.");
    for (const control of [workspace, colour, emphasis, pinned]) expect(control).not.toHaveAttribute("aria-disabled");
    fireEvent.click(colour);
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ type: "project.update", payload: {
      projectId: project.id, appearance: { color: { kind: "palette", name: "pink" } },
    } }));
    await waitFor(() => expect(colour).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps the clicked swatch focused and ignores further clicks while its save is pending", async () => {
    const pending = deferred<ServerEvent>();
    const request = vi.fn<IssueReportSettingsProps["request"]>()
      .mockResolvedValue({ type: "request.ok", requestId: "saved" })
      .mockReturnValueOnce(pending.promise);
    setup({ request });
    const pink = screen.getByRole("radio", { name: "Pink" });
    const teal = screen.getByRole("radio", { name: "Teal" });
    pink.focus();
    fireEvent.click(pink);
    expect(request).toHaveBeenCalledTimes(1);
    expect(pink).toHaveFocus();
    expect(pink).toHaveAttribute("aria-disabled", "true");
    expect(pink).not.toBeDisabled();
    fireEvent.click(teal);
    fireEvent.keyDown(pink, { key: "End" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(pink).toHaveFocus();
    await act(async () => pending.resolve({ type: "request.ok", requestId: "appearance-saved" }));
    expect(pink).not.toHaveAttribute("aria-disabled");
  });
  it("keeps the pin switch, icon buttons and Remove project focused while a save is pending", async () => {
    const pending = deferred<ServerEvent>();
    const request = vi.fn<IssueReportSettingsProps["request"]>()
      .mockResolvedValue({ type: "request.ok", requestId: "saved" })
      .mockReturnValueOnce(pending.promise);
    setup({ request });
    const pinned = screen.getByRole("switch", { name: "Pin to top of project lists" });
    pinned.focus();
    fireEvent.click(pinned);
    expect(request).toHaveBeenCalledTimes(1);
    expect(pinned).toHaveFocus();
    expect(pinned).toHaveAttribute("aria-disabled", "true");
    for (const name of ["Choose icon", "Choose file", "Add action", "Remove project"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      button.focus();
      fireEvent.click(button);
      expect(button).toHaveFocus();
    }
    expect(screen.queryByRole("group", { name: "Confirm removing the project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Project icons" })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ type: "request.ok", requestId: "pin-saved" }));
    expect(screen.getByRole("button", { name: "Remove project" })).not.toHaveAttribute("aria-disabled");
  });
  it("asks inline before removing a project, with Cancel first and Escape to back out", async () => {
    const { request } = setup();
    const remove = screen.getByRole("button", { name: "Remove project" });
    remove.focus();
    fireEvent.click(remove);
    const confirmation = screen.getByRole("group", { name: "Confirm removing the project" });
    expect(confirmation).toHaveTextContent("Remove “Studio” and its chats from Inertia?");
    expect(confirmation).toHaveTextContent("This cannot be undone. Files on disk will not be deleted.");
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(confirmation, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Confirm removing the project" })).not.toBeInTheDocument();
    expect(remove).toHaveFocus();
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(remove);
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm removing the project" })).getByRole("button", { name: "Remove from Inertia" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.remove", payload: { projectId: project.id } }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument());
  });
  it("removes at once when destructive actions are not confirmed", async () => {
    const { request } = setup({ settings: { ...defaultSettings, confirmDestructiveActions: false } });
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    expect(screen.queryByRole("group", { name: "Confirm removing the project" })).not.toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "project.remove", payload: { projectId: project.id } }));
  });
  it("sets and clears the project's model override and reports a failed save in its row", async () => {
    const { request, container, rerender, props } = setup();
    const model = screen.getByRole("combobox", { name: "Model for this project" });
    const choice = within(model).getAllByRole("option").find((option) => option.getAttribute("value") && !(option as HTMLOptionElement).disabled)!;
    fireEvent.change(model, { target: { value: choice.getAttribute("value") } });
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({
      type: "backend.default.set", payload: expect.objectContaining({ projectId: project.id }),
    })));
    const selection = (request.mock.calls.at(-1)![0] as { payload: { selection: unknown } }).payload.selection;
    rerender(<ProjectSettings {...props} backendDefaults={[{ scope: "project", projectId: project.id, selection } as never]} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model for this project" })).not.toHaveAttribute("aria-disabled"));
    request.mockRejectedValueOnce(new Error("The project changed in another window. Refresh and try again."));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for this project" }), { target: { value: "" } });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "backend.default.clear", payload: { projectId: project.id } }));
    expect(await within(container.querySelector<HTMLElement>('[data-setting-id="project-model"]')!).findByRole("alert"))
      .toHaveTextContent("The project changed in another window. Refresh and try again.");
  });
  it("says why a project with running chats cannot be removed", () => {
    const { container } = setup({ conversations: [{ ...conversation("busy"), projectId: project.id, status: "running" }] });
    expect(container.querySelector('[data-setting-id="project-remove"]')).toHaveTextContent("Stop this project's running chats first.");
  });
  it("sets colour, emphasis and pinning as server-merged appearance patches", async () => {
    const view = setup();
    const colours = screen.getByRole("radiogroup", { name: "Project colour" });
    fireEvent.keyDown(within(colours).getByRole("radio", { name: "Default" }), { key: "End" });
    expect(within(colours).getByRole("radio", { name: "Pink" })).toHaveFocus();
    await waitFor(() => expect(view.request).toHaveBeenCalledWith({ type: "project.update", payload: { projectId: project.id,
      appearance: { color: { kind: "palette", name: "pink" } } } }));
    await waitFor(() => expect(within(colours).getByRole("radio", { name: "Pink" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("radio", { name: "Icon and name" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pin to top of project lists" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("switch", { name: "Pin to top of project lists" }));
    await waitFor(() => expect(view.request).toHaveBeenCalledWith({ type: "project.update", payload: { projectId: project.id, appearance: { pinned: true } } }));
    expect(view.request).toHaveBeenCalledWith({ type: "project.update", payload: { projectId: project.id, appearance: { colorEmphasis: "icon-and-name" } } });
    await waitFor(() => expect(within(colours).getByRole("radio", { name: "Teal" })).not.toHaveAttribute("aria-disabled"));
    view.request.mockRejectedValueOnce(new Error("The runtime is offline."));
    fireEvent.click(within(colours).getByRole("radio", { name: "Teal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The runtime is offline.");
    const tinted = { ...project, updatedAt: "2026-09-09T08:02:00.000Z", preferences: { ...defaultProjectPreferences(), color: { kind: "palette" as const, name: "teal" as const }, colorEmphasis: "icon-and-name" as const } };
    view.rerender(<ProjectSettings {...view.props} projects={[tinted, view.props.projects[1]!]} />);
    expect(within(colours).getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Choose project" }).querySelector(".project-name-tinted")).toHaveTextContent("Studio");
  });
});

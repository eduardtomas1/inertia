import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import type { Project } from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { settingsViewProps } from "./settings-view-fixtures";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/workspace/${name.toLowerCase()}`,
    normalizedPath: `/workspace/${name.toLowerCase()}`,
    repositoryIdentity: null,
    repositoryRoot: `/workspace/${name.toLowerCase()}`,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 16,
    color: "#5661d8",
    status: "ready",
    createdAt: "2026-09-09T08:00:00.000Z",
    updatedAt: "2026-09-09T08:00:00.000Z",
    preferences: defaultProjectPreferences(),
  };
}

const studio = project("11111111-1111-4111-8111-111111111111", "Studio");
const website = project("22222222-2222-4222-8222-222222222222", "Website");

function searchField(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search settings" });
}

function type(value: string): HTMLElement {
  const field = searchField();
  fireEvent.change(field, { target: { value } });
  return field;
}

function results(): HTMLElement {
  return screen.getByRole("listbox", { name: "Matching settings" });
}

async function chooseProject(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Choose project" }));
  fireEvent.click(await screen.findByRole("option", { name }));
  expect(screen.getByRole("button", { name: "Choose project" })).toHaveTextContent(name);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { getPlatform: () => "darwin", getAppHealth: vi.fn(async () => null) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Settings search", () => {
  it("replaces the section list with matches grouped by section and highlights the matching words", () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
    const field = type("wrap");
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-expanded", "true");
    const chats = within(results()).getByRole("group", { name: "Chats" });
    expect(within(chats).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Wrap code by default", "Wrap long diff lines"]);
    expect([...results().querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["Wrap", "Wrap"]);
    expect(screen.getByText("2 settings")).toHaveAttribute("role", "status");
  });

  it("moves through results with the arrow keys and opens the chosen row with Enter", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    const field = type("wrap");
    const [code, diff] = within(results()).getAllByRole("option");
    expect(field).toHaveAttribute("aria-activedescendant", code!.id);
    expect(code).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field).toHaveAttribute("aria-activedescendant", diff!.id);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field).toHaveAttribute("aria-activedescendant", code!.id);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field).toHaveAttribute("aria-activedescendant", diff!.id);

    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Wrap long diff lines" })).toHaveFocus());
    expect(screen.getByRole("heading", { level: 2, name: "Chats" })).toBeInTheDocument();
    expect(field).toHaveValue("");
    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");
  });

  it("opens a row in the current section and one inside a closed disclosure with a click", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    type("density");
    fireEvent.click(within(results()).getByRole("option", { name: "Text density" }));
    await waitFor(() => expect(within(screen.getByRole("radiogroup", { name: "Text density" })).getAllByRole("radio")
      .some((radio) => radio === document.activeElement)).toBe(true));

    type("animate tool");
    fireEvent.click(within(results()).getByRole("option", { name: "Animate tool and step activity" }));
    const row = document.querySelector<HTMLElement>('[data-setting-id="working-indicator-activity"]')!;
    await waitFor(() => expect(row.contains(document.activeElement)).toBe(true));
    expect(row.closest("details")).toHaveProperty("open", true);
  });

  it("clears the query on the first Escape and leaves the second Escape to Settings", () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    const field = type("theme");
    expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
    expect(field).toHaveValue("");
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
    expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(true);
  });

  it("shows one plain line when nothing matches", () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    const field = type("zzzz");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText("No settings match")).toHaveAttribute("role", "status");
    expect(field).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("zzzz");
  });

  it("opens project rows for the first project and names it in the project picker", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "projects" },
      projects: [studio, website],
      onReportCommand: vi.fn(async () => ({ type: "request.ok" as const, requestId: "search" })),
    })} />);
    expect(await screen.findByRole("button", { name: "Choose project" })).toHaveTextContent("All projects");
    const field = type("pin to top");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pin to top of project lists" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Choose project" })).toHaveTextContent("Studio");
  });

  it("keeps the project the settings were opened for", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "projects", projectId: website.id },
      projects: [studio, website],
      onReportCommand: vi.fn(async () => ({ type: "request.ok" as const, requestId: "search" })),
    })} />);
    expect(await screen.findByRole("button", { name: "Choose project" })).toHaveTextContent("Website");
    const field = type("colour shows");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(document.querySelector('[data-setting-id="project-colour-emphasis"]')!.contains(document.activeElement)).toBe(true));
    expect(screen.getByRole("button", { name: "Choose project" })).toHaveTextContent("Website");
  });

  it("keeps the project chosen in the picker when a project row is found", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "projects" },
      projects: [studio, website],
      onReportCommand: vi.fn(async () => ({ type: "request.ok" as const, requestId: "search" })),
    })} />);
    await chooseProject("Website");
    fireEvent.keyDown(type("pin to top"), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pin to top of project lists" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Choose project" })).toHaveTextContent("Website");
  });

  it("opens the all-projects rows after a project was chosen in the picker", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "projects" },
      projects: [studio, website],
      onReportCommand: vi.fn(async () => ({ type: "request.ok" as const, requestId: "search" })),
    })} />);
    await chooseProject("Website");
    fireEvent.keyDown(type("compact sidebar"), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Compact sidebar" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Choose project" })).toHaveTextContent("All projects");
  });

  it("remembers the chosen project when Projects is opened again from the section list", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "projects" },
      projects: [studio, website],
      onReportCommand: vi.fn(async () => ({ type: "request.ok" as const, requestId: "search" })),
    })} />);
    await chooseProject("Website");
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(await screen.findByRole("button", { name: "Choose project" })).toHaveTextContent("Website");
  });

  it("leaves out project rows when there are no projects", () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    type("pin to top");
    expect(screen.getByText("No settings match")).toBeInTheDocument();
    type("compact sidebar");
    expect(within(results()).getByRole("option", { name: "Compact sidebar" })).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../src/shared/contracts";
import { ProjectScopePicker } from "../../src/renderer/src/components/sidebar/ProjectScopePicker";

const projects = [
  { id: "one", name: "Website", path: "/work/website" },
  { id: "two", name: "Runtime", path: "/work/runtime" },
] as Project[];
describe("project scope picker", () => {
  it("reopens after each filter change and toggles closed from the same trigger", () => {
    function Picker() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return <ProjectScopePicker projects={projects} selectedId={selectedId} onSelect={setSelectedId} onAdd={vi.fn()} disabled={false} />;
    }
    render(<Picker />);
    const trigger = screen.getByRole("button", { name: "Filter work by project" });
    for (const name of ["Website", "Runtime", "All projects", "Website"]) {
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(screen.getByRole("option", { name }));
      expect(trigger).toHaveTextContent(name);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("searches by project and path, selects with the keyboard, and restores focus", async () => {
    const onSelect = vi.fn();
    render(
      <ProjectScopePicker
        projects={projects}
        selectedId={null}
        onSelect={onSelect}
        onAdd={vi.fn()}
        disabled={false}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Filter work by project",
    });
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search projects" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "/work/runtime" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("two");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows no matches without resetting the filter and supports All projects", () => {
    const onSelect = vi.fn();
    render(
      <ProjectScopePicker
        projects={projects}
        selectedId="two"
        onSelect={onSelect}
        onAdd={vi.fn()}
        disabled={false}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Filter work by project" }),
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "missing" },
    });
    expect(screen.getByText("No matching projects")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("option", { name: "All projects" }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

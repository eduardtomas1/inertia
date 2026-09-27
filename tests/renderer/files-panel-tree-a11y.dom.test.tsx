import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

describe("FilesPanel tree semantics", () => {
  it("keeps panel status outside the tree and gives the tree only treeitems and groups", async () => {
    render(
      <FilesPanel
        {...FILES_PROJECT}
        git={{ snapshot: null, loading: true, unavailable: false }}
        entries={[{ path: "empty", kind: "directory" }, { path: "README.md", kind: "file" }]}
        preview={null}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn(async ({ directory = "" }) => ({
          directory,
          entries: [],
          truncated: false,
        }))}
      />,
    );
    const tree = screen.getByRole("tree", { name: "Files" });
    expect(within(tree).queryByText("Checking Git changes…")).not.toBeInTheDocument();
    expect(screen.getByText("Checking Git changes…")).toHaveAttribute("role", "status");

    fireEvent.click(within(tree).getByRole("treeitem", { name: "empty" }));
    const status = await within(tree).findByRole("status");
    expect(status).toHaveTextContent("empty is empty.");
    expect(status.parentElement).toHaveAttribute("role", "group");

    for (const child of tree.children) {
      expect(child).toHaveAttribute("role", "none");
    }
  });

  it("shows an empty project outside the tree", () => {
    render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[]}
        preview={null}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree", { name: "Files" });
    expect(within(tree).queryByText("Empty project.")).not.toBeInTheDocument();
    expect(screen.getByText("Empty project.")).toBeInTheDocument();
  });
});

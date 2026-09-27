import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilesPanel, type WorkspaceEntriesPage } from "../../src/renderer/src/components/FilesPanel";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

function ownedTreeRoles(container: Element): string[] {
  return [...container.children].flatMap((child) => {
    if (child.getAttribute("aria-hidden") === "true") return [];
    const role = child.getAttribute("role");
    if (role === "none" || role === "presentation") return ownedTreeRoles(child);
    if (role === "group") return ["group", ...ownedTreeRoles(child)];
    return [role ?? child.tagName.toLowerCase()];
  });
}

function expectOnlyTreeItems(tree: HTMLElement): void {
  expect(ownedTreeRoles(tree).every((role) => role === "treeitem" || role === "group"))
    .toBe(true);
  for (const group of within(tree).queryAllByRole("group")) {
    expect(ownedTreeRoles(group).every((role) => role === "treeitem" || role === "group"))
      .toBe(true);
  }
}

describe("FilesPanel tree semantics", () => {
  it("keeps the panel Git notice outside the tree", () => {
    render(
      <FilesPanel
        {...FILES_PROJECT}
        git={{ snapshot: null, loading: true, unavailable: false }}
        entries={[{ path: "src", kind: "directory" }, { path: "README.md", kind: "file" }]}
        preview={null}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree", { name: "Files" });
    expect(within(tree).queryByText("Checking Git changes…")).not.toBeInTheDocument();
    expect(screen.getByText("Checking Git changes…")).toHaveAttribute("role", "status");
    expectOnlyTreeItems(tree);
  });

  it.each([
    ["loading", "Loading pending…", "status"],
    ["empty", "pending is empty.", "status"],
    ["truncated", "More in pending.", "status"],
    ["failed", "Folder unreadable. Enter retries.", "alert"],
  ] as const)("announces a %s directory without placing status inside the tree", async (state, text, role) => {
    let settle!: () => void;
    const onLoadEntries = vi.fn(({ directory = "" }: { directory?: string }) => new Promise<WorkspaceEntriesPage>((resolve, reject) => {
      settle = () => {
        if (state === "failed") reject(new Error("Folder unreadable."));
        else resolve({
          directory,
          entries: state === "truncated" ? [{ path: `${directory}/a.ts`, kind: "file" }] : [],
          truncated: state === "truncated",
        });
      };
    }));
    render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "pending", kind: "directory" }, { path: "README.md", kind: "file" }]}
        preview={null}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );
    const tree = screen.getByRole("tree", { name: "Files" });
    const directory = within(tree).getByRole("treeitem", { name: "pending" });
    fireEvent.click(directory);
    if (state !== "loading") await act(async () => settle());

    const status = screen.getAllByRole(role).find((element) => element.textContent === text);
    expect(status).toBeDefined();
    expect(tree).not.toContainElement(status!);
    expect(directory).toHaveAccessibleDescription(text);
    if (state === "loading") expect(directory).toHaveAttribute("aria-busy", "true");
    else expect(directory).not.toHaveAttribute("aria-busy");
    expect(within(tree).queryByRole("status")).not.toBeInTheDocument();
    expect(within(tree).queryByRole("alert")).not.toBeInTheDocument();
    expectOnlyTreeItems(tree);
    expect(tree.textContent).toContain(text);
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

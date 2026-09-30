import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileTree, type FileTreeProps } from "../../src/renderer/src/components/FileTree";
import type { WorkspaceTreeRow } from "../../src/renderer/src/utils/workspaceTree";

const directory = (path: string, expanded: boolean): WorkspaceTreeRow => ({
  entry: { path, kind: "directory" },
  depth: 1,
  parentPath: "",
  expanded,
});

describe("FileTree directory status", () => {
  it("keeps an announced directory status in place when rows are inserted above it", () => {
    const props: FileTreeProps = {
      label: "Files",
      busy: false,
      rows: [directory("docs", false), directory("src", true)],
      searchActive: false,
      selectedPath: null,
      rovingPath: "docs",
      gitIndex: { files: new Map(), directories: new Set(), notice: "" },
      directoryPages: new Map(),
      loadingDirectories: new Set(["src"]),
      directoryErrors: new Map(),
      itemRefs: { current: new Map() },
      treeRef: createRef(),
      onActivate: vi.fn(),
      onKeyDown: vi.fn(),
    };
    const view = render(<FileTree {...props} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading src…");

    view.rerender(<FileTree
      {...props}
      rows={[directory("docs", true), directory("docs/guide", false), directory("src", true)]}
      loadingDirectories={new Set(["docs", "src"])}
    />);

    const statuses = screen.getAllByRole("status");
    expect(statuses.map((item) => item.textContent)).toEqual(["Loading docs…", "Loading src…"]);
    expect(statuses[1]).toBe(status);
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-describedby", status.id);
  });
});

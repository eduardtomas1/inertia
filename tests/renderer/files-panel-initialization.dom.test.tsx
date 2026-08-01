import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceEntry } from "../../src/shared/contracts";

const metrics = vi.hoisted(() => ({ sorts: 0 }));

vi.mock("../../src/renderer/src/utils/workspaceTree", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/renderer/src/utils/workspaceTree")
  >();
  return {
    ...actual,
    sortWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
      metrics.sorts += 1;
      return actual.sortWorkspaceEntries(entries);
    },
  };
});

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";

const entries: WorkspaceEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const onLoadEntries = vi.fn(async () => ({
  directory: "",
  entries,
  truncated: false,
}));
const onSelectFile = vi.fn();

describe("FilesPanel root initialization", () => {
  it("sorts once on mount and only refreshes when root input changes", () => {
    metrics.sorts = 0;
    const view = render(
      <FilesPanel
        entries={entries}
        preview={null}
        selectedPath={null}
        onSelectFile={onSelectFile}
        onLoadEntries={onLoadEntries}
      />,
    );

    expect(metrics.sorts).toBe(1);
    view.rerender(
      <FilesPanel
        entries={entries}
        preview={null}
        selectedPath={null}
        previewLoading
        onSelectFile={onSelectFile}
        onLoadEntries={onLoadEntries}
      />,
    );
    expect(metrics.sorts).toBe(1);

    view.rerender(
      <FilesPanel
        entries={[...entries]}
        preview={null}
        selectedPath={null}
        onSelectFile={onSelectFile}
        onLoadEntries={onLoadEntries}
      />,
    );
    expect(metrics.sorts).toBe(2);
  });
});

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

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

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
        {...FILES_PROJECT}
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
        {...FILES_PROJECT}
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
        {...FILES_PROJECT}
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

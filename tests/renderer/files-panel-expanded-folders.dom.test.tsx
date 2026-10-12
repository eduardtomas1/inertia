import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilesPanel, type WorkspaceEntriesPage } from "../../src/renderer/src/components/FilesPanel";

const projectId = "22222222-2222-4222-8222-222222222222";

function panel(conversationId: string, onLoadEntries: (request: { directory?: string }) => Promise<WorkspaceEntriesPage>) {
  return (
    <FilesPanel
      projectRoot="/work/project"
      projectId={projectId}
      conversationId={conversationId}
      entries={[{ path: "src", kind: "directory" }, { path: "README.md", kind: "file" }]}
      preview={null}
      selectedPath={null}
      onSelectFile={vi.fn()}
      onLoadEntries={onLoadEntries}
    />
  );
}

describe("Files panel expanded folders", () => {
  it("keeps expanded folders when the tab is closed and reopened in the same workspace only", async () => {
    const onLoadEntries = vi.fn(async ({ directory = "" }: { directory?: string }) => ({
      directory,
      entries: [{ path: `${directory}/index.ts`, kind: "file" as const }],
      truncated: false,
    }));
    const first = render(panel("conversation-a", onLoadEntries));
    fireEvent.click(within(screen.getByRole("tree", { name: "Files" })).getByRole("treeitem", { name: "src" }));
    await act(async () => undefined);
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeInTheDocument();
    first.unmount();

    onLoadEntries.mockClear();
    const second = render(panel("conversation-a", onLoadEntries));
    await act(async () => undefined);
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeInTheDocument();
    expect(onLoadEntries).toHaveBeenCalledWith({ directory: "src" });
    second.unmount();

    render(panel("conversation-b", onLoadEntries));
    await act(async () => undefined);
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "index.ts" })).toBeNull();
  });
});

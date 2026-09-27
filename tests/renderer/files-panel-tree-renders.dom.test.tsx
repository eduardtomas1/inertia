import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceEntry } from "../../src/shared/contracts";

const badgeRenders = vi.hoisted(() => ({ tree: 0 }));

vi.mock("../../src/renderer/src/components/FileGitBadge", () => ({
  FileGitBadge: ({ directory }: { directory?: boolean }) => {
    if (directory !== undefined) badgeRenders.tree += 1;
    return null;
  },
}));

const { FilesPanel } = await import("../../src/renderer/src/components/FilesPanel");

const entries: WorkspaceEntry[] = Array.from({ length: 40 }, (_, index) => ({
  path: `file-${index}.txt`,
  kind: "file" as const,
}));

describe("FilesPanel tree isolation", () => {
  it("does not re-render tree rows while the source preview scrolls or re-renders", async () => {
    const content = Array.from({ length: 3_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const props = {
      projectRoot: "/work/project",
      projectId: "11111111-1111-4111-8111-111111111111",
      entries,
      preview: {
        path: "file-0.txt",
        content,
        truncated: false,
        language: "text",
        contentDigest: "a".repeat(64),
        modifiedAt: "2026-09-27T12:00:00.000Z",
      },
      selectedPath: "file-0.txt",
      onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(),
    };
    const view = render(<FilesPanel {...props} />);
    const code = screen.getByLabelText("Contents of file-0.txt");
    const rendered = badgeRenders.tree;
    expect(rendered).toBeGreaterThanOrEqual(entries.length);

    for (const scrollTop of [400, 1_200, 4_000]) {
      await act(async () => {
        code.scrollTop = scrollTop;
        fireEvent.scroll(code);
      });
    }
    expect(badgeRenders.tree).toBe(rendered);
    view.rerender(<FilesPanel {...props} />);

    expect(badgeRenders.tree).toBe(rendered);
    expect(screen.getAllByRole("treeitem")).toHaveLength(entries.length);
  });
});

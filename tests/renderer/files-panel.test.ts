import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FilesPanel,
  freshWorkspaceDirectoryPages,
} from "../../src/renderer/src/components/FilesPanel";
import { MAX_WORKSPACE_FILE_EDIT_BYTES } from "../../src/shared/contracts";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

describe("FilesPanel", () => {
  it("drops cached child directories when the root listing is refreshed", () => {
    const pages = freshWorkspaceDirectoryPages([
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file" },
    ], false);

    expect([...pages.keys()]).toEqual([""]);
    expect(pages.get("")?.entries.map(({ path }) => path)).toEqual([
      "src",
      "README.md",
    ]);
  });

  it("renders a lazy accessible tree with roving focus and a clear selection", () => {
    const html = renderToStaticMarkup(createElement(FilesPanel, {
      ...FILES_PROJECT,
      entries: [
        { path: "src", kind: "directory" as const },
        { path: "README.md", kind: "file" as const },
      ],
      preview: {
        path: "README.md",
        content: "# Project",
        truncated: false,
        language: "md",
        contentDigest: "a".repeat(64),
        modifiedAt: "2026-07-29T10:00:00.000Z",
      },
      selectedPath: "README.md",
      onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(),
    }));

    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Workspace files"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('title="README.md"');
    expect(html).toContain('aria-label="Rendered preview of README.md"');
    expect(html).toContain('data-language-family="markup"');
    expect(html).toContain("Markdown recognized locally");
    expect(html).toContain("Rendering Markdown");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain('role="list"');
  });

  it("renders bounded root, loading, and preview failure states accessibly", () => {
    const loadingHtml = renderToStaticMarkup(createElement(FilesPanel, {
      ...FILES_PROJECT,
      entries: [],
      preview: null,
      selectedPath: null,
      loading: true,
      entriesTruncated: true,
      onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(),
    }));
    expect(loadingHtml).toContain('role="status"');
    expect(loadingHtml).toContain("Loading files");

    const errorHtml = renderToStaticMarkup(createElement(FilesPanel, {
      ...FILES_PROJECT,
      entries: [{ path: "deep/file.ts", kind: "file" as const }],
      preview: null,
      selectedPath: "deep/file.ts",
      previewError: "This file is not valid UTF-8 text.",
      onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(),
    }));
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Could not preview file.ts");
    expect(errorHtml).toContain("This file is not valid UTF-8 text.");
  });

  it("keeps previews above the transport-safe edit limit read-only", () => {
    const html = renderToStaticMarkup(createElement(FilesPanel, {
      ...FILES_PROJECT,
      entries: [{ path: "large.txt", kind: "file" as const }],
      preview: {
        path: "large.txt",
        content: "x".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES + 1),
        truncated: false,
        language: "text",
        contentDigest: "a".repeat(64),
        modifiedAt: "2026-07-29T10:00:00.000Z",
      },
      selectedPath: "large.txt",
      onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(),
      onSaveFile: vi.fn(),
      canSaveFile: () => false,
    }));

    expect(html).toContain(
      'aria-label="large.txt is too large to edit in Inertia"',
    );
    expect(html).toContain("disabled");
  });

  it("enables editing only when the exact save command passes preflight", () => {
    const html = renderToStaticMarkup(createElement(FilesPanel, {
      ...FILES_PROJECT,
      entries: [{ path: "ordinary.txt", kind: "file" as const }],
      preview: {
        path: "ordinary.txt",
        content: "ordinary text\n",
        truncated: false,
        language: "text",
        contentDigest: "a".repeat(64),
        modifiedAt: "2026-07-29T10:00:00.000Z",
      },
      selectedPath: "ordinary.txt",
      onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(),
      onSaveFile: vi.fn(),
      canSaveFile: () => true,
    }));

    expect(html).toContain(
      'aria-label="Edit ordinary.txt in Inertia"',
    );
    expect(html).not.toContain(
      'aria-label="ordinary.txt is too large to edit in Inertia"',
    );
  });
});

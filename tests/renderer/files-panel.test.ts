import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";

describe("FilesPanel", () => {
  it("renders a lazy accessible tree with roving focus and a clear selection", () => {
    const html = renderToStaticMarkup(createElement(FilesPanel, {
      entries: [
        { path: "src", kind: "directory" as const },
        { path: "README.md", kind: "file" as const },
      ],
      preview: {
        path: "README.md",
        content: "# Project",
        truncated: false,
        language: "md",
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
    expect(html).toContain('aria-label="Contents of README.md"');
    expect(html).not.toContain('role="list"');
  });

  it("renders bounded root, loading, and preview failure states accessibly", () => {
    const loadingHtml = renderToStaticMarkup(createElement(FilesPanel, {
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
});

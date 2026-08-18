import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  FilesPanel,
  MAX_RENDERED_MARKDOWN_PREVIEW_CHARACTERS,
} from "../../src/renderer/src/components/FilesPanel";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

function markdownPreview(content: string, path = "docs/README.md") {
  return {
    path,
    content,
    truncated: false,
    language: "untrusted-provider-value",
    contentDigest: "a".repeat(64),
    modifiedAt: "2026-08-18T08:00:00.000Z",
  };
}

describe("FilesPanel Markdown preview", () => {
  it("renders safe GFM by default and opens relative project links", () => {
    const onSelectFile = vi.fn();
    const { container } = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "docs/README.md", kind: "file" }]}
        preview={markdownPreview([
          "# Project guide",
          "",
          "- [x] Preview Markdown",
          "",
          "| File | State |",
          "| --- | --- |",
          "| `guide.md` | ready |",
          "",
          "[Open the guide](./guide.md#L7)",
          "",
          '<script>alert("blocked")</script>',
          '<img src="https://example.com/preview.png" onerror="alert(1)">',
        ].join("\n"))}
        selectedPath="docs/README.md"
        onSelectFile={onSelectFile}
        onLoadEntries={vi.fn()}
      />,
    );

    const document = screen.getByRole("document", {
      name: "Rendered preview of docs/README.md",
    });
    expect(within(document).getByRole("heading", { name: "Project guide" }))
      .toBeInTheDocument();
    expect(within(document).getByRole("table")).toBeInTheDocument();
    expect(within(document).getByRole("checkbox")).toBeChecked();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).not.toHaveAttribute("onerror");

    fireEvent.click(within(document).getByRole("link", {
      name: "Open the guide",
    }));
    expect(onSelectFile).toHaveBeenCalledWith(
      "docs/guide.md",
      { startLine: 7, endLine: 7 },
    );
  });

  it("switches between rendered Markdown and highlighted source", () => {
    const { container } = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "README.markdown", kind: "file" }]}
        preview={markdownPreview("# Visible heading", "README.markdown")}
        selectedPath="README.markdown"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    const viewToggle = screen.getByRole("group", { name: "Markdown view" });
    expect(within(viewToggle).getByRole("button", { name: "Preview" }))
      .toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(viewToggle).getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("Contents of README.markdown"))
      .toHaveTextContent("# Visible heading");
    expect(container.querySelector(".file-preview-code .hljs-section"))
      .toHaveTextContent("# Visible heading");

    fireEvent.click(within(viewToggle).getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("document", {
      name: "Rendered preview of README.markdown",
    })).toBeInTheDocument();
  });

  it("opens a referenced Markdown location in exact source view", () => {
    const { container } = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "README.md", kind: "file" }]}
        preview={markdownPreview([
          "# Heading",
          "",
          "Referenced source line",
        ].join("\n"), "README.md")}
        selectedPath="README.md"
        selectedLocation={{ startLine: 3, endLine: 3 }}
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Contents of README.md")).toBeInTheDocument();
    expect(screen.queryByRole("document", {
      name: "Rendered preview of README.md",
    })).toBeNull();
    expect(container.querySelector('[data-source-line="3"]'))
      .toHaveClass("is-referenced");
    expect(screen.getByRole("button", { name: "Source" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("keeps oversized and newline-dense Markdown in bounded source view", () => {
    const overCharacterLimit = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "large.md", kind: "file" }]}
        preview={markdownPreview(
          `# Large\n${"x".repeat(MAX_RENDERED_MARKDOWN_PREVIEW_CHARACTERS)}`,
          "large.md",
        )}
        selectedPath="large.md"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByText(/Rendered preview is limited to 100,000 characters/u))
      .toBeInTheDocument();
    overCharacterLimit.unmount();

    const { container } = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "dense.md", kind: "file" }]}
        preview={markdownPreview("# line\n".repeat(2_001), "dense.md")}
        selectedPath="dense.md"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByText(/Rendered preview is limited to 2,000 lines/u))
      .toBeInTheDocument();
    expect(container.querySelectorAll(".file-preview-line")).toHaveLength(2_000);
  });
});

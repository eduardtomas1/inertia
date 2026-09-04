import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  FilesPanel,
  MarkdownPreviewSurface,
  MAX_RENDERED_MARKDOWN_PREVIEW_CHARACTERS,
} from "../../src/renderer/src/components/FilesPanel";
import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

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
  it("contains a lazy renderer failure and retries without losing source access", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("stale Markdown chunk"))
      .mockResolvedValue({ ResponseMarkdown });
    const onShowSource = vi.fn();
    render(
      <MarkdownPreviewSurface
        loader={loader}
        loadingFallback={<span>Rendering Markdown…</span>}
        onShowSource={onShowSource}
        content="# Recovered preview"
        projectRoot="/work/project"
        projectId={FILES_PROJECT.projectId}
        defaultCodeWrap
      />,
    );

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Preview failed");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onShowSource).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", {
      name: "Recovered preview",
    })).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("renders safe GFM by default and opens relative project links", async () => {
    const onSelectFile = vi.fn();
    const onOpenWorkspaceEntry = vi.fn();
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
        onOpenWorkspaceEntry={onOpenWorkspaceEntry}
        onLoadEntries={vi.fn()}
      />,
    );

    const document = screen.getByRole("document", {
      name: "Preview of docs/README.md",
    });
    expect(await within(document).findByRole("heading", { name: "Project guide" }))
      .toBeInTheDocument();
    expect(within(document).getByRole("table")).toBeInTheDocument();
    expect(within(document).getByRole("checkbox")).toBeChecked();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    const unavailable = container.querySelector(
      ".response-markdown-image-unavailable",
    );
    expect(unavailable).toHaveAttribute("aria-hidden", "true");
    expect(within(document).queryByRole("img")).not.toBeInTheDocument();

    fireEvent.click(within(document).getByRole("link", {
      name: "Open the guide",
    }));
    expect(onOpenWorkspaceEntry).toHaveBeenCalledWith(
      "docs/guide.md",
      { startLine: 7, endLine: 7 },
      undefined,
    );
    expect(onSelectFile).not.toHaveBeenCalled();
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

    const viewToggle = screen.getByRole("group", { name: "Markdown" });
    expect(within(viewToggle).getByRole("button", { name: "Preview" }))
      .toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(viewToggle).getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("Contents of README.markdown"))
      .toHaveTextContent("# Visible heading");
    expect(container.querySelector(".file-preview-code .hljs-section"))
      .toHaveTextContent("# Visible heading");

    fireEvent.click(within(viewToggle).getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("document", {
      name: "Preview of README.markdown",
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
      name: "Preview of README.md",
    })).toBeNull();
    expect(container.querySelector('[data-source-line="3"]'))
      .toHaveClass("is-referenced");
    expect(screen.getByRole("button", { name: "Source" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("keeps oversized and newline-dense Markdown in virtualized source view", () => {
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
    expect(screen.getByText(/Limit: 100,000 characters/u))
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
    expect(screen.getByText(/Limit: 2,000 lines/u))
      .toBeInTheDocument();
    expect(container.querySelectorAll(".file-preview-line").length)
      .toBeLessThan(200);
    expect(container.querySelector(".file-preview-code > code"))
      .toHaveClass("is-virtualized");
  });

  it("resets interactive and pending copy state when the preview identity changes", async () => {
    let finishCopy: ((copied: boolean) => void) | undefined;
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        copyText: vi.fn(() => new Promise<boolean>((resolve) => {
          finishCopy = resolve;
        })),
      },
    });
    const props = {
      ...FILES_PROJECT,
      entries: [
        { path: "docs/a.md", kind: "file" as const },
        { path: "docs/b.md", kind: "file" as const },
      ],
      onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(),
    };
    const view = render(
      <FilesPanel
        {...props}
        preview={markdownPreview("```ts\nconst a = true;\n```", "docs/a.md")}
        selectedPath="docs/a.md"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copying" })).toBeDisabled();

    view.rerender(
      <FilesPanel
        {...props}
        preview={markdownPreview("```ts\nconst b = true;\n```", "docs/b.md")}
        selectedPath="docs/b.md"
      />,
    );
    expect(await screen.findByRole("button", { name: "Copy" }))
      .not.toBeDisabled();
    finishCopy?.(true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy" }))
        .toHaveTextContent("Copy");
    });
  });

  it("hands directory links and cross-file heading fragments to workspace routing", async () => {
    const onOpenWorkspaceEntry = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const props = {
      ...FILES_PROJECT,
      entries: [{ path: "docs/README.md", kind: "file" as const }],
      selectedPath: "docs/README.md",
      onSelectFile: vi.fn(),
      onOpenWorkspaceEntry,
      onLoadEntries: vi.fn(),
    };
    const view = render(
      <FilesPanel
        {...props}
        preview={markdownPreview([
          "[Directory](../docs)",
          "[Directory hint](../docs/)",
          "[Guide section](./guide.md#cafe%CC%81)",
        ].join("\n\n"))}
      />,
    );
    fireEvent.click(await screen.findByRole("link", { name: "Directory" }));
    fireEvent.click(screen.getByRole("link", { name: "Directory hint" }));
    fireEvent.click(screen.getByRole("link", { name: "Guide section" }));
    expect(onOpenWorkspaceEntry).toHaveBeenNthCalledWith(
      1,
      "docs",
      undefined,
      undefined,
    );
    expect(onOpenWorkspaceEntry).toHaveBeenNthCalledWith(
      2,
      "docs",
      undefined,
      undefined,
    );
    expect(onOpenWorkspaceEntry).toHaveBeenNthCalledWith(
      3,
      "docs/guide.md",
      undefined,
      undefined,
      "cafe\u0301",
    );
    view.rerender(
      <FilesPanel
        {...props}
        preview={markdownPreview("# Cafe\u0301", "docs/guide.md")}
        selectedPath="docs/guide.md"
        selectedMarkdownHeading={{
          path: "docs/guide.md",
          headingId: "cafe\u0301",
          requestId: 1,
        }}
      />,
    );
    const heading = await screen.findByRole("heading", { name: "Cafe\u0301" });
    expect(heading).toHaveAttribute("id", "user-content-cafe\u0301");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(heading).toHaveFocus();

    const sourceView = screen.getByRole("button", { name: "Source" });
    sourceView.focus();
    fireEvent.click(sourceView);

    view.rerender(
      <FilesPanel
        {...props}
        preview={markdownPreview("# Cafe\u0301", "docs/guide.md")}
        selectedPath="docs/guide.md"
        selectedMarkdownHeading={{
          path: "docs/guide.md",
          headingId: "cafe\u0301",
          requestId: 2,
        }}
      />,
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Cafe\u0301" })).toHaveFocus();
    const previewView = screen.getByRole("button", { name: "Preview" });
    expect(previewView).toHaveAttribute("aria-pressed", "true");

    sourceView.focus();
    fireEvent.click(sourceView);
    previewView.focus();
    fireEvent.click(previewView);
    expect(previewView).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});

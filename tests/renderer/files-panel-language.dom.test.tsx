import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

const JAVA_CONTENT = [
  "package demo;",
  "",
  "public final class OrderService {",
  "  private final String state = \"ready\";",
  "  public String state() { return state; }",
  "}",
].join("\n");

describe("FilesPanel language presentation", () => {
  it("highlights Java and focuses a validated source range", async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe(): void {}
      disconnect(): void {
        disconnect();
      }
    });
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const { container } = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[
          { path: "OrderService.java", kind: "file" },
          { path: "check.py", kind: "file" },
          { path: "README.md", kind: "file" },
        ]}
        preview={{
          path: "src/OrderService.java",
          content: JAVA_CONTENT,
          truncated: false,
          language: "misleading-provider-value",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-08-13T12:00:00.000Z",
        }}
        selectedPath="src/OrderService.java"
        selectedLocation={{ startLine: 3, endLine: 5 }}
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    expect(screen.getByTitle("Java recognized locally"))
      .toHaveTextContent("Java");
    expect(screen.getByRole("treeitem", { name: "OrderService.java" }))
      .toHaveAttribute("data-language-family", "java");
    expect(screen.getByRole("treeitem", { name: "check.py" }))
      .toHaveAttribute("data-language-family", "script");
    expect(screen.getByRole("treeitem", { name: "README.md" }))
      .toHaveAttribute("data-language-family", "markup");
    expect(container.querySelectorAll(".file-preview-line.is-referenced"))
      .toHaveLength(3);
    expect(container.querySelector(
      '.file-preview-code [data-source-line="3"] .hljs-keyword',
    ))
      .toHaveTextContent("public");
    expect(container.querySelector(".file-preview-code .hljs-string"))
      .toHaveTextContent('"ready"');
    expect(container.querySelector(".file-preview")?.getAttribute("aria-live"))
      .toBeNull();
    expect(container.querySelector(".file-preview-header [role=status]"))
      .toHaveAttribute("aria-live", "polite");

    const firstReferencedLine = screen.getByLabelText(
      "Lines 3–5 in src/OrderService.java",
    );
    await waitFor(() => expect(firstReferencedLine).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
    fireEvent.wheel(screen.getByLabelText(
      "Contents of src/OrderService.java",
    ));
    expect(disconnect).toHaveBeenCalled();
    scrollIntoView.mockClear();
    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keeps an unknown extension neutral instead of trusting protocol metadata", () => {
    const { container } = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "notes.unknown", kind: "file" }]}
        preview={{
          path: "notes.unknown",
          content: "ordinary text",
          truncated: false,
          language: "java",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-08-13T12:00:00.000Z",
        }}
        selectedPath="notes.unknown"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    expect(screen.getByTitle("Text recognized locally"))
      .toHaveTextContent("Text");
    expect(container.querySelector(".file-preview-code .hljs")).toBeNull();
  });

  it("bounds a newline-dense preview while keeping its requested line visible", () => {
    const { container } = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "dense.txt", kind: "file" }]}
        preview={{
          path: "dense.txt",
          content: "\n".repeat(1_048_576),
          truncated: false,
          language: "text",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-08-14T10:00:00.000Z",
        }}
        selectedPath="dense.txt"
        selectedLocation={{ startLine: 900_000, endLine: 900_000 }}
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    expect(container.querySelectorAll(".file-preview-line")).toHaveLength(2_000);
    expect(container.querySelector('[data-source-line="900000"]'))
      .toHaveClass("is-referenced");
    expect(container.querySelector('[data-source-line="1"]')).toBeNull();
    expect(screen.getByText(
      "Lines 899000–900999 of 1048577 shown.",
    )).toBeInTheDocument();
  });
});

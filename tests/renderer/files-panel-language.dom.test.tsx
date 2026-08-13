import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";

describe("FilesPanel language-aware source preview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("highlights Java and focuses a validated source range", async () => {
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {
        disconnect();
      }
    });
    const content = [
      "package example;",
      "public final class Service {",
      "  private final int value = 42;",
      "}",
    ].join("\n");
    const { container } = render(
      <FilesPanel
        entries={[
          { path: "Service.java", kind: "file" },
          { path: "opaque.future", kind: "file" },
        ]}
        preview={{
          path: "src/main/java/example/Service.java",
          content,
          truncated: false,
          language: "provider-value-is-not-authoritative",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-08-13T12:00:00.000Z",
        }}
        selectedPath="src/main/java/example/Service.java"
        selectedLocation={{ startLine: 2, endLine: 3 }}
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    const javaRow = screen.getByRole("treeitem", { name: "Service.java" });
    expect(javaRow).toHaveAttribute("data-language", "java");
    expect(javaRow).toHaveAttribute("data-language-accent", "amber");
    expect(screen.getByText("Java")).toHaveAttribute("data-language", "java");

    const preview = screen.getByLabelText(
      "Contents of src/main/java/example/Service.java, lines 2 to 3",
    );
    expect(preview).toHaveAttribute("data-source-start-line", "2");
    expect(preview).toHaveAttribute("data-source-end-line", "3");
    expect(container.querySelector("code.hljs.language-java")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("package");
    expect(container.querySelectorAll(
      ".file-preview-line-numbers > .is-source-target",
    )).toHaveLength(2);
    await waitFor(() => expect(preview).toHaveFocus());
    fireEvent.wheel(preview);
    expect(disconnect).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opened src/main/java/example/Service.java at lines 2 to 3.",
    );

    expect(screen.getByRole("treeitem", { name: "opaque.future" }))
      .toHaveAttribute("data-language-accent", "neutral");
  });
});

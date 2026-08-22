import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  FilesPanel,
  type WorkspaceEntriesPage,
} from "../../src/renderer/src/components/FilesPanel";
import type { WorkspaceEntry } from "../../src/shared/contracts";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

const ROOT_ENTRIES: WorkspaceEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];

function page(
  directory: string,
  entries: WorkspaceEntry[],
  truncated = false,
): WorkspaceEntriesPage {
  return {
    directory,
    entries,
    truncated,
  };
}

describe("FilesPanel root refresh", () => {
  it("reveals an externally opened file through its lazy ancestor chain", async () => {
    const onLoadEntries = vi.fn(async ({
      directory = "",
    }: {
      directory?: string;
    }): Promise<WorkspaceEntriesPage> => {
      if (directory === "src") {
        return page(directory, [
          { path: "src/components", kind: "directory" },
        ]);
      }
      if (directory === "src/components") {
        return page(directory, [
          { path: "src/components/Button.tsx", kind: "file" },
        ]);
      }
      return page(directory, ROOT_ENTRIES);
    });
    render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={ROOT_ENTRIES}
        preview={null}
        selectedPath="src/components/Button.tsx"
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );

    const selected = await screen.findByRole("treeitem", {
      name: "Button.tsx",
    });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(selected).toHaveAttribute("aria-level", "3");
    expect(screen.getByRole("treeitem", { name: "src" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "components" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(document.body);
    for (const directory of ["src", "src/components"]) {
      expect(onLoadEntries.mock.calls.filter(
        ([request]) => request.directory === directory,
      )).toHaveLength(1);
    }
  });

  it("clears a search that would hide a newly selected external file", async () => {
    const onLoadEntries = vi.fn(async ({
      directory = "",
      query,
    }: {
      directory?: string;
      query?: string;
    }): Promise<WorkspaceEntriesPage> => {
      if (query === "readme") return page("", [ROOT_ENTRIES[1]!]);
      if (directory === "src") {
        return page(directory, [
          { path: "src/components", kind: "directory" },
        ]);
      }
      if (directory === "src/components") {
        return page(directory, [
          { path: "src/components/Button.tsx", kind: "file" },
        ]);
      }
      return page(directory, ROOT_ENTRIES);
    });
    const view = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={ROOT_ENTRIES}
        preview={null}
        selectedPath="README.md"
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );
    const search = screen.getByRole("searchbox", {
      name: "Search files",
    });
    fireEvent.change(search, { target: { value: "readme" } });
    await screen.findByRole("treeitem", { name: "README.md" });

    view.rerender(
      <FilesPanel
        {...FILES_PROJECT}
        entries={ROOT_ENTRIES}
        preview={null}
        selectedPath="src/components/Button.tsx"
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: "Button.tsx" }))
      .toHaveAttribute("aria-selected", "true");
    expect(search).toHaveValue("");
    expect(screen.getByRole("tree", { name: "Files" }))
      .toBeInTheDocument();
  });

  it("retains a selected chain across truncated root refreshes", async () => {
    const onLoadEntries = vi.fn(async ({
      directory = "",
    }: {
      directory?: string;
    }): Promise<WorkspaceEntriesPage> => {
      if (directory === "src" || directory === "src/components") {
        return page(directory, [], true);
      }
      return page(directory, [{ path: "README.md", kind: "file" }], true);
    });
    const view = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "README.md", kind: "file" }]}
        entriesTruncated
        preview={null}
        selectedPath="src/components/Button.tsx"
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: "Button.tsx" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("treeitem", { name: "src" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "components" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("More root items.")).toBeInTheDocument();
    expect(screen.getByText("More in components."))
      .toBeInTheDocument();

    view.rerender(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[{ path: "README.md", kind: "file" }]}
        entriesTruncated
        preview={null}
        selectedPath="src/components/Button.tsx"
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );

    await waitFor(() => {
      expect(onLoadEntries.mock.calls.filter(
        ([request]) => request.directory === "src/components",
      )).toHaveLength(2);
    });
    expect(screen.getByRole("treeitem", { name: "Button.tsx" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("treeitem", { name: "src" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("re-reveals the selected row when its tree container resizes", () => {
    let notifyResize: (() => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }

      observe(target: Element): void {
        observe(target);
      }

      disconnect(): void {
        disconnect();
      }
    });
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    try {
      render(
        <FilesPanel
          {...FILES_PROJECT}
          entries={ROOT_ENTRIES}
          preview={null}
          selectedPath="README.md"
          onSelectFile={vi.fn()}
          onLoadEntries={vi.fn()}
        />,
      );
      const tree = screen.getByRole("tree", { name: "Files" });
      expect(observe).toHaveBeenCalledWith(tree);
      scrollIntoView.mockClear();

      act(() => notifyResize?.());

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(document.activeElement).toBe(document.body);
    } finally {
      scrollIntoView.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("reveals a searched directory once when activated from the keyboard", async () => {
    const user = userEvent.setup();
    const onLoadEntries = vi.fn(async ({
      directory = "",
      query,
    }: {
      directory?: string;
      query?: string;
    }): Promise<WorkspaceEntriesPage> => {
      if (query === "deep") {
        return page("", [
          { path: "src/components/deep", kind: "directory" },
        ]);
      }
      if (directory === "src") {
        return page(directory, [
          { path: "src/components", kind: "directory" },
        ]);
      }
      if (directory === "src/components") {
        return page(directory, [
          { path: "src/components/deep", kind: "directory" },
        ]);
      }
      if (directory === "src/components/deep") {
        return page(directory, [
          { path: "src/components/deep/CaseSensitiveLeaf.ts", kind: "file" },
        ]);
      }
      return page(directory, ROOT_ENTRIES);
    });
    render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={ROOT_ENTRIES}
        preview={null}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );

    const search = screen.getByRole("searchbox", {
      name: "Search files",
    });
    await user.type(search, "deep");
    const result = await screen.findByRole("treeitem", { name: /deep/u });
    result.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("treeitem", {
      name: "CaseSensitiveLeaf.ts",
    })).toHaveAttribute("aria-level", "4");
    expect(screen.getByRole("treeitem", { name: "deep" }))
      .toHaveAttribute("aria-expanded", "true");
    for (const directory of [
      "src",
      "src/components",
      "src/components/deep",
    ]) {
      expect(onLoadEntries.mock.calls.filter(
        ([request]) => request.directory === directory,
      )).toHaveLength(1);
    }
  });

  it("preserves and reloads expanded search paths after a late root refresh", async () => {
    const onLoadEntries = vi.fn(async ({
      directory = "",
      query,
    }: {
      directory?: string;
      query?: string;
    }): Promise<WorkspaceEntriesPage> => {
      if (query === "deep") {
        return page("", [
          { path: "src/components/deep", kind: "directory" },
        ]);
      }
      if (directory === "src") {
        return page(directory, [
          { path: "src/components", kind: "directory" },
        ]);
      }
      if (directory === "src/components") {
        return page(directory, [
          { path: "src/components/deep", kind: "directory" },
          { path: "src/components/Button.tsx", kind: "file" },
        ]);
      }
      if (directory === "src/components/deep") {
        return page(directory, [
          { path: "src/components/deep/CaseSensitiveLeaf.ts", kind: "file" },
        ]);
      }
      return page(directory, ROOT_ENTRIES);
    });
    const view = render(
      <FilesPanel
        {...FILES_PROJECT}
        entries={ROOT_ENTRIES}
        preview={null}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );

    const search = screen.getByRole("searchbox", {
      name: "Search files",
    });
    fireEvent.change(search, { target: { value: "deep" } });
    const result = await screen.findByRole("treeitem", {
      name: /deep/u,
    });
    fireEvent.click(result);

    const leaf = await screen.findByRole("treeitem", {
      name: "CaseSensitiveLeaf.ts",
    });
    expect(screen.getByRole("treeitem", {
      name: "deep",
    })).toHaveAttribute("aria-expanded", "true");
    expect(leaf).toHaveAttribute("aria-level", "4");

    view.rerender(
      <FilesPanel
        {...FILES_PROJECT}
        entries={[...ROOT_ENTRIES]}
        preview={null}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onLoadEntries={onLoadEntries}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("treeitem", {
        name: "CaseSensitiveLeaf.ts",
      })).toHaveAttribute("aria-level", "4");
    });
    expect(screen.getByRole("treeitem", {
      name: "deep",
    })).toHaveAttribute("aria-expanded", "true");
    expect(
      onLoadEntries.mock.calls.filter(
        ([request]) => request.directory === "src/components/deep",
      ),
    ).toHaveLength(2);
  });
});

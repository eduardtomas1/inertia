import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
): WorkspaceEntriesPage {
  return {
    directory,
    entries,
    truncated: false,
  };
}

describe("FilesPanel root refresh", () => {
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
      name: "Search project files",
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
      name: "Search project files",
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

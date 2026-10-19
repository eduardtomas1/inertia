import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceContentSearchPage } from "../../src/shared/contracts";
import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

const RESULTS: WorkspaceContentSearchPage = {
  matches: [
    { projectPath: "src/app.ts", line: 12, column: 7, snippet: "const Needle = 1;" },
    { projectPath: "src/lib/util.ts", line: 3, column: 1, snippet: "needle();" },
  ],
  truncated: true,
};

function renderPanel(
  onSearchContent: (query: string) => Promise<WorkspaceContentSearchPage>,
) {
  const onSelectFile = vi.fn();
  const onLoadEntries = vi.fn(async () => ({
    directory: "",
    entries: [{ path: "src/needle.ts", kind: "file" as const }],
    truncated: false,
  }));
  render(
    <FilesPanel
      {...FILES_PROJECT}
      entries={[{ path: "src", kind: "directory" }]}
      preview={null}
      selectedPath={null}
      onSelectFile={onSelectFile}
      onLoadEntries={onLoadEntries}
      onSearchContent={onSearchContent}
    />,
  );
  return { onSelectFile, onLoadEntries };
}

describe("FilesPanel content search", () => {
  it("searches file contents, shows snippets, and opens a match at its line", async () => {
    const onSearchContent = vi.fn(async () => RESULTS);
    const { onSelectFile, onLoadEntries } = renderPanel(onSearchContent);

    const names = screen.getByRole("button", { name: "Names" });
    const contents = screen.getByRole("button", { name: "Contents" });
    expect(screen.getByRole("group", { name: "Search in" })).toBeInTheDocument();
    expect(names).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(contents);
    expect(contents).toHaveAttribute("aria-pressed", "true");

    const search = screen.getByRole("searchbox", { name: "Search file contents" });
    fireEvent.change(search, { target: { value: "needle" } });
    expect(await screen.findByText("Searching…")).toBeInTheDocument();

    await screen.findByRole("button", { name: "src/app.ts, line 12: const Needle = 1;" });
    const results = screen.getByRole("list", { name: "Content search results" });
    expect(onSearchContent).toHaveBeenCalledTimes(1);
    expect(onSearchContent).toHaveBeenCalledWith("needle");
    expect(onLoadEntries).not.toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(String) }));
    expect(results.querySelectorAll("mark")[0]).toHaveTextContent("Needle");
    expect(screen.getByText("Partial results. Refine for more.")).toBeInTheDocument();
    expect(screen.getByText("2 matches")).toBeInTheDocument();

    const first = screen.getByRole("button", { name: "src/app.ts, line 12: const Needle = 1;" });
    const second = screen.getByRole("button", { name: "src/lib/util.ts, line 3: needle();" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("tabindex", "0");
    fireEvent.click(second);
    expect(onSelectFile).toHaveBeenCalledWith(
      "src/lib/util.ts",
      { startLine: 3, endLine: 3, startColumn: 1 },
      true,
    );

    fireEvent.click(names);
    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("needle");
    expect(await screen.findByRole("tree", { name: "Search results" })).toBeInTheDocument();
    await waitFor(() => expect(onLoadEntries).toHaveBeenCalledWith({ query: "needle" }));
    expect(onSearchContent).toHaveBeenCalledTimes(1);
  });

  it("debounces typing and reports search failures and empty results", async () => {
    const onSearchContent = vi.fn(async (query: string) => {
      if (query === "boom") throw new Error("Unable to search this workspace.");
      return { matches: [], truncated: false };
    });
    renderPanel(onSearchContent);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    const search = screen.getByRole("searchbox", { name: "Search file contents" });
    fireEvent.change(search, { target: { value: "b" } });
    fireEvent.change(search, { target: { value: "bo" } });
    fireEvent.change(search, { target: { value: "boom" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to search this workspace.");
    expect(onSearchContent).toHaveBeenCalledTimes(1);

    fireEvent.change(search, { target: { value: "nothing" } });
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText(/Partial results/u)).toBeNull();
  });
});

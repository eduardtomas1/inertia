import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  WorkspaceContentSearchPage,
  WorkspaceFilePreview,
} from "../../src/shared/contracts";
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

const UTIL_PREVIEW: WorkspaceFilePreview = {
  path: "src/lib/util.ts",
  content: "export {};\n\nneedle();\n",
  truncated: false,
  language: "typescript",
  contentDigest: "b".repeat(64),
  modifiedAt: "2026-08-13T12:00:00.000Z",
};

type PanelProps = Partial<React.ComponentProps<typeof FilesPanel>>;

function renderPanel(
  onSearchContent: (query: string) => Promise<WorkspaceContentSearchPage>,
) {
  const onSelectFile = vi.fn();
  const onLoadEntries = vi.fn(async () => ({
    directory: "",
    entries: [{ path: "src/needle.ts", kind: "file" as const }],
    truncated: false,
  }));
  const element = (props: PanelProps = {}) => (
    <FilesPanel
      {...FILES_PROJECT}
      entries={[{ path: "src", kind: "directory" }]}
      preview={null}
      selectedPath={null}
      onSelectFile={onSelectFile}
      onLoadEntries={onLoadEntries}
      onSearchContent={onSearchContent}
      {...props}
    />
  );
  const view = render(element());
  return {
    onSelectFile,
    onLoadEntries,
    rerender: (props: PanelProps) => view.rerender(element(props)),
  };
}

describe("FilesPanel content search", () => {
  it("shows results in the main area, opens a match, and returns to the results", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const onSearchContent = vi.fn(async () => RESULTS);
    const { onSelectFile, onLoadEntries, rerender } = renderPanel(onSearchContent);

    const names = screen.getByRole("button", { name: "Names" });
    const contents = screen.getByRole("button", { name: "Contents" });
    expect(screen.getByRole("group", { name: "Search in" })).toBeInTheDocument();
    expect(names).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(contents);
    expect(contents).toHaveAttribute("aria-pressed", "true");

    const search = screen.getByRole("searchbox", { name: "Search file contents" });
    fireEvent.change(search, { target: { value: "needle" } });
    expect(await screen.findByText("Searching for “needle”…")).toBeInTheDocument();

    await screen.findByRole("button", { name: "src/app.ts, line 12: const Needle = 1;" });
    expect(onSearchContent).toHaveBeenCalledTimes(1);
    expect(onSearchContent).toHaveBeenCalledWith("needle");
    expect(onLoadEntries).not.toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(String) }));

    // Results occupy the preview area; the tree column keeps the file tree.
    const preview = document.querySelector(".file-preview")!;
    const results = screen.getByRole("list", { name: "Content search results" });
    expect(preview).toContainElement(results);
    expect(screen.getByRole("tree", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByText("2 matches for “needle”")).toBeInTheDocument();
    expect(screen.getByText("Partial results. Refine for more.")).toBeInTheDocument();
    expect(screen.queryByText("Select a file.")).toBeNull();
    expect(results.querySelectorAll("mark")[0]).toHaveTextContent("Needle");
    expect(results.querySelector(".file-content-result-location strong")).toHaveTextContent("app.ts");
    expect(results.querySelector(".file-content-result-location small")).toHaveTextContent("src");
    expect(results.querySelector(".file-content-result-line")).toHaveTextContent("Line 12");

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

    rerender({
      preview: UTIL_PREVIEW,
      selectedPath: UTIL_PREVIEW.path,
      selectedLocation: { startLine: 3, endLine: 3, startColumn: 1 },
    });
    expect(screen.queryByRole("list", { name: "Content search results" })).toBeNull();
    expect(document.querySelectorAll(".file-preview-line.is-referenced")).toHaveLength(1);
    expect(document.querySelector(".file-preview-line.is-referenced"))
      .toHaveAttribute("data-source-line", "3");
    expect(search).toHaveValue("needle");

    const rafs: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafs.push(callback);
      return rafs.length;
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
    act(() => {
      for (const callback of rafs.splice(0)) callback(0);
    });
    const selected = screen.getByRole("button", { name: "src/lib/util.ts, line 3: needle();" });
    expect(selected).toHaveAttribute("aria-current", "location");
    expect(selected).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Back to results" })).toBeNull();
    vi.mocked(window.requestAnimationFrame).mockRestore();

    fireEvent.click(names);
    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("needle");
    expect(await screen.findByRole("tree", { name: "Search results" })).toBeInTheDocument();
    await waitFor(() => expect(onLoadEntries).toHaveBeenCalledWith({ query: "needle" }));
    expect(screen.queryByRole("list", { name: "Content search results" })).toBeNull();
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
    expect(await screen.findByText("No matches for “nothing”")).toBeInTheDocument();
    expect(screen.queryByText(/Partial results/u)).toBeNull();
  });

  it("ignores a superseded search's cancelled reply and keeps the newer results", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    let answerOlder!: (page: WorkspaceContentSearchPage) => void;
    const onSearchContent = vi.fn((query: string) => query === "need"
      ? new Promise<WorkspaceContentSearchPage>((resolve) => { answerOlder = resolve; })
      : Promise.resolve(RESULTS));
    renderPanel(onSearchContent);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    const search = screen.getByRole("searchbox", { name: "Search file contents" });
    fireEvent.change(search, { target: { value: "need" } });
    await waitFor(() => expect(onSearchContent).toHaveBeenCalledWith("need"));
    fireEvent.change(search, { target: { value: "needle" } });
    await screen.findByRole("button", { name: "src/app.ts, line 12: const Needle = 1;" });

    await act(async () => answerOlder({ matches: [], truncated: false, cancelled: true }));
    expect(screen.getByRole("button", { name: "src/app.ts, line 12: const Needle = 1;" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when another search replaced the current one", async () => {
    const onSearchContent = vi.fn(async (): Promise<WorkspaceContentSearchPage> => ({
      matches: [], truncated: false, cancelled: true,
    }));
    renderPanel(onSearchContent);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search file contents" }), { target: { value: "needle" } });
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Another search replaced this one. Edit the text to search again.");
  });
});

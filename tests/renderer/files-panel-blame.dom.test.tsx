import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";
import { useFilePreviewBlame, type FilePreviewBlameLoader } from "../../src/renderer/src/components/FilesPanelBlame";
import type { WorkspaceFilePreview, WorkspaceGitSnapshot } from "../../src/shared/contracts";
import type { GitBlameLine, GitBlamePage } from "../../src/shared/contracts/git-history";

const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

function preview(path: string, content: string): WorkspaceFilePreview {
  return {
    path,
    content,
    truncated: false,
    language: "plaintext",
    contentDigest: "a".repeat(64),
    modifiedAt: "2026-08-13T12:00:00.000Z",
  };
}

function line(number: number, sha: string, summary: string): GitBlameLine {
  return {
    line: number,
    sha: sha.repeat(40).slice(0, 40),
    shortSha: sha.repeat(7).slice(0, 7),
    authorName: `Author ${sha}`,
    authorDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    summary,
    uncommitted: false,
  };
}

function page(
  path: string,
  startLine: number,
  endLine: number,
  lineCount: number,
  entries: (lineNumber: number) => GitBlameLine,
): GitBlamePage {
  const lines = Array.from({ length: Math.max(0, endLine - startLine + 1) }, (_, index) => entries(startLine + index));
  return { path, state: "ready", startLine, endLine, lineCount, lines, nextStartLine: endLine < lineCount ? endLine + 1 : null };
}

function renderPanel(file: WorkspaceFilePreview, load: FilePreviewBlameLoader, extra: Partial<React.ComponentProps<typeof FilesPanel>> = {}) {
  return render(
    <FilesPanel
      {...FILES_PROJECT}
      entries={[{ path: file.path, kind: "file" }]}
      preview={file}
      selectedPath={file.path}
      onSelectFile={vi.fn()}
      onLoadEntries={vi.fn()}
      onLoadBlame={load}
      {...extra}
    />,
  );
}

describe("FilesPanel blame", () => {
  it("is off by default, then shows compact run entries with a summary popover", async () => {
    const file = preview("src/app.ts", "one\ntwo\nthree\nfour");
    const load = vi.fn<FilePreviewBlameLoader>(async ({ path, startLine, endLine }) =>
      page(path, startLine, Math.min(endLine, 4), 4, (number) => number <= 2
        ? line(number, "a", "Add the first lines")
        : line(number, "b", "Change the tail")));
    const { container } = renderPanel(file, load);

    const toggle = screen.getByRole("button", { name: "Blame" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".file-preview-blame")).toBeNull();
    expect(load).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(load).toHaveBeenCalledWith({ path: "src/app.ts", startLine: 1, endLine: 2_000 }));
    const first = await screen.findByRole("button", { name: /^Line 1: aaaaaaa · Author a · 2 days ago\. Add the first lines$/u });
    const third = screen.getByRole("button", { name: /^Line 3: bbbbbbb · Author b/u });
    // Only the first line of each same-commit run carries an entry.
    expect(container.querySelectorAll("button[data-blame-line]")).toHaveLength(2);
    expect(container.querySelector(".file-preview-code")).toHaveClass("has-blame");
    expect(first).toHaveAttribute("tabindex", "0");
    expect(third).toHaveAttribute("tabindex", "-1");
    // The capped gutter shows the short SHA and author; the date lives in the popover.
    expect(first.querySelector(".file-preview-blame-sha")).toHaveTextContent("aaaaaaa");
    expect(first.querySelector(".file-preview-blame-author")).toHaveTextContent("Author a");
    expect(first).not.toHaveTextContent("ago");

    act(() => first.focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Add the first lines");
    expect(tooltip).toHaveTextContent("2 days ago");
    expect(tooltip.querySelector("time")).toHaveAttribute("dateTime");
    expect(first).toHaveAttribute("aria-describedby", tooltip.id);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(third).toHaveFocus();
    expect(third).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Change the tail");
    fireEvent.pointerLeave(third);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".file-preview-blame")).toBeNull();
  });

  it("is disabled for untracked files and turns off when the runtime reports one", async () => {
    const file = preview("notes.txt", "draft");
    const untrackedSnapshot = {
      partial: false,
      truncated: false,
      repositories: [{
        repositoryPath: ".",
        state: "ready",
        truncated: false,
        files: [{ path: "notes.txt", status: "untracked", untracked: true, indexStatus: "?", worktreeStatus: "?", staged: false, unstaged: true }],
      }],
    } as unknown as WorkspaceGitSnapshot;
    const load = vi.fn<FilePreviewBlameLoader>();
    const { unmount } = renderPanel(file, load, { git: { snapshot: untrackedSnapshot, loading: false, unavailable: false } });
    expect(screen.getByRole("button", { name: "Blame" })).toBeDisabled();
    unmount();

    const reported = vi.fn<FilePreviewBlameLoader>(async ({ path, startLine }) => ({
      path, state: "untracked", startLine, endLine: startLine - 1, lineCount: 0, lines: [], nextStartLine: null,
    }));
    renderPanel(file, reported);
    fireEvent.click(screen.getByRole("button", { name: "Blame" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Blame" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Blame" })).toHaveAttribute("aria-pressed", "false");
  });

  it("is disabled in Markdown preview mode and for binary content", () => {
    const markdown = preview("README.md", "# Title\n\nBody");
    const load = vi.fn<FilePreviewBlameLoader>();
    const { unmount } = renderPanel(markdown, load);
    expect(screen.getByRole("button", { name: "Blame" })).toBeDisabled();
    fireEvent.click(within(screen.getByRole("group", { name: "Markdown" })).getByRole("button", { name: "Source" }));
    expect(screen.getByRole("button", { name: "Blame" })).toBeEnabled();
    unmount();

    renderPanel(preview("data.bin", "a\0b"), load);
    expect(screen.getByRole("button", { name: "Blame" })).toBeDisabled();
    expect(load).not.toHaveBeenCalled();
  });

  it("loads only the visible 2,000-line page of a long file and shows load errors", async () => {
    const total = 4_500;
    const file = preview("long.txt", Array.from({ length: total }, (_, index) => `line ${index + 1}`).join("\n"));
    const load = vi.fn<FilePreviewBlameLoader>(async ({ path, startLine, endLine }) =>
      page(path, startLine, Math.min(endLine, total), total, (number) => line(number, number % 2 ? "c" : "d", `Line ${number}`)));
    renderPanel(file, load);
    fireEvent.click(screen.getByRole("button", { name: "Blame" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith({ path: "long.txt", startLine: 1, endLine: 2_000 });
    // Happy DOM renders no virtual rows, so the window stays on the first page.
    await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn<FilePreviewBlameLoader>(async () => { throw new Error("Git inspection took too long."); });
    const other = preview("other.txt", "x");
    renderPanel(other, failing);
    const toggles = screen.getAllByRole("button", { name: "Blame" });
    fireEvent.click(toggles.at(-1)!);
    await waitFor(() => expect(toggles.at(-1)).toHaveClass("has-error"));
    expect(failing).toHaveBeenCalledOnce();
  });

  it("loads further 2,000-line pages as the rendered window scrolls", async () => {
    const total = 4_500;
    const file = preview("long.txt", "x\n".repeat(total - 1) + "x");
    const load = vi.fn<FilePreviewBlameLoader>(async ({ path, startLine, endLine }) =>
      page(path, startLine, Math.min(endLine, total), total, (number) => line(number, "e", "Long")));
    const windowAt = (first: number) => Array.from({ length: 40 }, (_, index) => ({ lineNumber: first + index }));
    const { result, rerender } = renderHook(
      ({ renderedLines }) => useFilePreviewBlame({ preview: file, load, markdownPreview: false, untracked: false, renderedLines }),
      { initialProps: { renderedLines: windowAt(1) } },
    );
    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.entry(1)).toBeDefined());
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ renderedLines: windowAt(1_990) });
    await waitFor(() => expect(result.current.entry(2_010)).toBeDefined());
    expect(load).toHaveBeenLastCalledWith({ path: "long.txt", startLine: 2_001, endLine: 4_000 });
    rerender({ renderedLines: windowAt(4_461) });
    await waitFor(() => expect(result.current.entry(4_500)).toBeDefined());
    expect(load).toHaveBeenLastCalledWith({ path: "long.txt", startLine: 4_001, endLine: 6_000 });
    rerender({ renderedLines: windowAt(1) });
    expect(load).toHaveBeenCalledTimes(3);
    expect(result.current.runStart(2_001)).toBe(false);
  });
});

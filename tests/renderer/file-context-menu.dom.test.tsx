import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";
import { WorkspaceChangesPanel } from "../../src/renderer/src/components/WorkspaceChangesPanel";
import type { ContextMenuAction, ContextMenuRequest } from "../../src/shared/context-menu";
import type { ChangedFile, WorkspaceGitSnapshot } from "../../src/shared/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

const bridge = {
  showContextMenu: vi.fn<(request: ContextMenuRequest) => Promise<ContextMenuAction | null>>(),
  copyText: vi.fn(async (_text: string) => true),
  openProjectPath: vi.fn(async () => ""),
  getPlatform: () => "darwin" as NodeJS.Platform,
};

const lastRequest = () => bridge.showContextMenu.mock.calls.at(-1)![0];

async function choose(element: Element, action: ContextMenuAction): Promise<void> {
  bridge.showContextMenu.mockResolvedValueOnce(action);
  fireEvent.contextMenu(element, { clientX: 5, clientY: 9 });
  await act(async () => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.showContextMenu.mockResolvedValue(null);
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
});

afterEach(cleanup);

function renderFiles(projectRoot = "/work/project") {
  render(
    <FilesPanel
      projectRoot={projectRoot}
      projectId={projectId}
      conversationId={conversationId}
      entries={[{ path: "src", kind: "directory" }, { path: "README.md", kind: "file" }]}
      preview={null}
      selectedPath={null}
      onSelectFile={vi.fn()}
      onLoadEntries={vi.fn()}
    />,
  );
  return within(screen.getByRole("tree", { name: "Files" }));
}

describe("file tree context menu", () => {
  it("describes a file by project identity and runs path actions without the page naming labels", async () => {
    const file = renderFiles().getByRole("treeitem", { name: "README.md" });
    fireEvent.contextMenu(file, { clientX: 5, clientY: 9 });
    expect(lastRequest()).toEqual({
      kind: "file", projectId, conversationId, relativePath: "README.md", directory: false, anchor: { x: 5, y: 9 },
    });
    await choose(file, "open");
    await choose(file, "reveal");
    await choose(file, "copy-path");
    await choose(file, "copy-relative-path");
    expect(bridge.openProjectPath.mock.calls).toEqual([
      [{ projectId, conversationId, relativePath: "README.md", action: "open-externally" }],
      [{ projectId, conversationId, relativePath: "README.md", action: "reveal" }],
    ]);
    expect(bridge.copyText.mock.calls).toEqual([["/work/project/README.md"], ["README.md"]]);
  });

  it("marks folders so main leaves out Open", () => {
    const folder = renderFiles().getByRole("treeitem", { name: "src" });
    fireEvent.contextMenu(folder);
    expect(lastRequest()).toMatchObject({ kind: "file", relativePath: "src", directory: true });
  });

  it("joins Windows project roots with backslashes", async () => {
    const file = renderFiles("C:\\Users\\me\\project\\").getByRole("treeitem", { name: "README.md" });
    await choose(file, "copy-path");
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith("C:\\Users\\me\\project\\README.md");
  });

  it("opens from the Menu key and Shift+F10 on the focused row and keeps tree navigation", async () => {
    const tree = renderFiles();
    const file = tree.getByRole("treeitem", { name: "README.md" });
    file.focus();
    fireEvent.keyDown(file, { key: "ContextMenu" });
    fireEvent.keyDown(file, { key: "F10", shiftKey: true });
    expect(bridge.showContextMenu).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(file);
    fireEvent.keyDown(file, { key: "ArrowUp" });
    await waitFor(() => expect(tree.getByRole("treeitem", { name: "src" })).toHaveFocus());
    expect(bridge.showContextMenu).toHaveBeenCalledTimes(2);
  });
});

function changedFile(path: string): ChangedFile {
  return {
    path, status: "modified", insertions: 1, deletions: 1, untracked: false,
    staged: false, unstaged: true, indexStatus: ".", worktreeStatus: "M",
  };
}

describe("changed file context menu", () => {
  it("opens through the panel's own open action and reveals inside the project", async () => {
    const files = [changedFile("app/notes.md")];
    const snapshot: WorkspaceGitSnapshot = {
      repositories: [{
        repositoryPath: ".", state: "ready", error: null, branch: "main", upstream: null,
        ahead: 0, behind: 0, hasRemote: false, files, insertions: 1, deletions: 1,
        clean: false, truncated: false, workspacePrefix: "app",
      }],
      files: 1, insertions: 1, deletions: 1, scannedDirectories: 1, skippedDirectories: 0,
      discoveredRepositories: 1, repositoryLimit: 64, partial: false, truncated: false, issues: [],
    };
    const onOpenWorkspaceFile = vi.fn();
    await act(async () => {
      render(<WorkspaceChangesPanel
        projectName="App"
        projectRoot="/work/app"
        projectId={projectId}
        conversationId={conversationId}
        snapshot={snapshot}
        summary={null}
        onRefresh={vi.fn()}
        onLoadRepositoryDiff={async (repositoryPath) => ({ repositoryPath, patch: "", files, truncated: false })}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />);
    });
    const row = screen.getByRole("navigation", { name: "Git repositories and changed files" })
      .querySelector(".workspace-repository-file")!;
    fireEvent.contextMenu(row);
    expect(lastRequest()).toEqual({
      kind: "diff-file", projectId, conversationId, relativePath: "notes.md", anchor: { x: 0, y: 0 },
    });
    await choose(row, "open");
    expect(onOpenWorkspaceFile).toHaveBeenCalledExactlyOnceWith("notes.md");
    await choose(row, "reveal");
    expect(bridge.openProjectPath).toHaveBeenCalledExactlyOnceWith({
      projectId, conversationId, relativePath: "notes.md", action: "reveal",
    });
    await choose(row, "copy-path");
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith("/work/app/notes.md");
  });
});

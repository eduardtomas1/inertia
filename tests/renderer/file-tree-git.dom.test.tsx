import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChangedFile, WorkspaceGitRepositorySnapshot, WorkspaceGitSnapshot } from "../../src/shared/contracts";
import { buildFileTreeGitIndex, FILE_GIT_LIMITS } from "../../src/renderer/src/utils/fileTreeGit";
import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";

function file(path: string, status = "modified", extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status, insertions: 0, deletions: 0, staged: false, unstaged: true, untracked: false,
    indexStatus: ".", worktreeStatus: "M", ...extra };
}
function repo(repositoryPath: string, files: ChangedFile[], extra: Partial<WorkspaceGitRepositorySnapshot> = {}): WorkspaceGitRepositorySnapshot {
  return { repositoryPath, state: "ready", error: null, branch: "main", upstream: null, ahead: 0, behind: 0,
    hasRemote: false, files, insertions: 0, deletions: 0, clean: files.length === 0, truncated: false, ...extra };
}
function snapshot(repositories: WorkspaceGitRepositorySnapshot[], extra: Partial<WorkspaceGitSnapshot> = {}): WorkspaceGitSnapshot {
  return { repositories, files: repositories.reduce((n, repository) => n + repository.files.length, 0), insertions: 0,
    deletions: 0, scannedDirectories: 1, skippedDirectories: 0, discoveredRepositories: repositories.length,
    repositoryLimit: 16, partial: false, truncated: false, issues: [], ...extra };
}
const project = { projectRoot: "/project", projectId: "11111111-1111-4111-8111-111111111111" };
const state = (value: WorkspaceGitSnapshot) => ({ snapshot: value, loading: false, unavailable: false });

describe("bounded Git decorations in the Files editor", () => {
  it("projects actual status, staging, rename destinations and conflicts without reading contents", () => {
    const index = buildFileTreeGitIndex(state(snapshot([repo(".", [
      file("src/edit.ts"), file("new.ts", "added", { staged: true, unstaged: false }),
      file("scratch.txt", "untracked", { untracked: true }), file("renamed.ts", "renamed"),
      file("conflict.ts", "modified", { indexStatus: "U", worktreeStatus: "U" }),
      file("gone.ts", "deleted"), file("../../outside"),
    ])])));
    expect(index.files.get("src/edit.ts")).toMatchObject({ mark: "M", label: "Modified · unstaged" });
    expect(index.files.get("new.ts")?.label).toBe("Added · staged");
    expect(index.files.get("scratch.txt")?.mark).toBe("?");
    expect(index.files.get("renamed.ts")?.mark).toBe("R");
    expect(index.files.get("conflict.ts")?.label).toBe("Merge conflict");
    expect(index.files.get("gone.ts")?.mark).toBe("D");
    expect(index.files.has("../../outside")).toBe(false);
    expect(index.directories.has("src")).toBe(true);
  });

  it("uses exact nested repository boundaries, including failed child repositories and sibling prefixes", () => {
    const index = buildFileTreeGitIndex(state(snapshot([
      repo(".", [file("nested/same.ts"), file("nested-two/same.ts"), file("broken/secret.ts")]),
      repo("nested", [file("same.ts", "added")]), repo("broken", [], { state: "error", error: "unavailable" }),
    ])));
    expect(index.files.get("nested/same.ts")?.mark).toBe("A");
    expect(index.files.get("nested-two/same.ts")?.mark).toBe("M");
    expect(index.files.has("broken/secret.ts")).toBe(false);
    expect(index.notice).toContain("partial");
  });

  it("bounds oversized status projection and never treats missing badges as clean", () => {
    const files = Array.from({ length: FILE_GIT_LIMITS.files + 10 }, (_, i) => file(`file-${i}.ts`));
    const index = buildFileTreeGitIndex(state(snapshot([repo(".", files)])));
    expect(index.files.size).toBe(FILE_GIT_LIMITS.files);
    expect(index.notice).toContain("Files without badges may still have changes");
    expect(buildFileTreeGitIndex(state(snapshot([]))).notice).toContain("No Git repository detected");
    expect(buildFileTreeGitIndex({ ...state(snapshot([repo(".", files)])), unavailable: true }).files.size).toBe(0);
    expect(buildFileTreeGitIndex({ ...state(snapshot([repo(".", files)])), loading: true }).files.size).toBe(0);
  });

  it("keeps names, keyboard selection and alignment slots while replacing stale badges on refresh", async () => {
    const onSelectFile = vi.fn(); const onLoadEntries = vi.fn();
    const props = { ...project, entries: [{ path: "bundle.js", kind: "file" as const }, { path: "clean.ts", kind: "file" as const }],
      preview: null, selectedPath: null, onSelectFile, onLoadEntries };
    const { rerender } = render(<FilesPanel {...props} git={state(snapshot([repo(".", [file("bundle.js")])]))} />);
    const changed = screen.getByRole("treeitem", { name: "bundle.js" });
    expect(changed).toHaveAccessibleDescription("Git: Modified · unstaged");
    expect(changed.querySelector(".file-entry-name")).toHaveTextContent("bundle.js");
    expect(screen.getByRole("treeitem", { name: "clean.ts" }).querySelector(".file-git-badge")).toBeNull();
    fireEvent.keyDown(changed, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("treeitem", { name: "clean.ts" })).toHaveFocus());
    // Native Enter/Space synthesize click in Electron, not in fireEvent.
    fireEvent.click(changed);
    expect(onSelectFile).toHaveBeenCalledWith("bundle.js");
    rerender(<FilesPanel {...props} git={state(snapshot([repo(".", [])]))} />);
    expect(screen.getByRole("treeitem", { name: "bundle.js" }).querySelector(".file-git-badge")).toBeNull();
    expect(changed).not.toHaveAttribute("aria-description");
    rerender(<FilesPanel {...props} git={{ snapshot: null, loading: false, unavailable: true }} />);
    expect(screen.getByText(/Git status unavailable/u)).toBeVisible();
    expect(onLoadEntries).not.toHaveBeenCalled();
  });

  it("preserves expanded folder names and keyboard focus when a Git scan adds a badge", async () => {
    const props = { ...project, entries: [{ path: "src", kind: "directory" as const }],
      preview: null, selectedPath: null, onSelectFile: vi.fn(),
      onLoadEntries: vi.fn(async () => ({ directory: "src", truncated: false,
        entries: [{ path: "src/edit.ts", kind: "file" as const }] })) };
    const { rerender } = render(<FilesPanel {...props} git={state(snapshot([repo(".", [])]))} />);
    const folder = screen.getByRole("treeitem", { name: "src" });
    fireEvent.click(folder);
    const child = await screen.findByRole("treeitem", { name: "edit.ts" });
    rerender(<FilesPanel {...props} git={state(snapshot([repo(".", [file("src/edit.ts")])]))} />);
    expect(screen.getByRole("treeitem", { name: "src" })).toBe(folder);
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(folder).toHaveAccessibleDescription("Contains Git changes");
    expect(screen.getByRole("treeitem", { name: "edit.ts" })).toBe(child);
    expect(child).toHaveAccessibleDescription("Git: Modified · unstaged");
    fireEvent.keyDown(folder, { key: "ArrowRight" });
    await waitFor(() => expect(child).toHaveFocus());
    expect(props.onLoadEntries).toHaveBeenCalledTimes(1);
  });
});

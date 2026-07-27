import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceChangesPanel } from "../../src/renderer/src/components/WorkspaceChangesPanel";
import type {
  ChangedFile,
  WorkspaceGitSnapshot,
} from "../../src/shared/contracts";

function changedFile(path: string, insertions = 2, deletions = 1): ChangedFile {
  return {
    path,
    status: "modified",
    insertions,
    deletions,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: ".",
    worktreeStatus: "M",
  };
}

function snapshot(partial = false): WorkspaceGitSnapshot {
  return {
    repositories: [
      {
        repositoryPath: ".",
        state: "ready",
        error: null,
        branch: "main",
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
        hasRemote: true,
        files: [changedFile("README.md", 1, 0)],
        insertions: 1,
        deletions: 0,
        clean: false,
        truncated: false,
      },
      {
        repositoryPath: "modules/org.openbravo.alpha",
        state: "ready",
        error: null,
        branch: "develop",
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [changedFile("src/Main.java")],
        insertions: 2,
        deletions: 1,
        clean: false,
        truncated: false,
      },
      {
        repositoryPath: "modules/org.openbravo.beta",
        state: "ready",
        error: null,
        branch: "feature/beta",
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [changedFile("src/Main.java", 3, 2)],
        insertions: 3,
        deletions: 2,
        clean: false,
        truncated: false,
      },
      {
        repositoryPath: "modules/clean",
        state: "ready",
        error: null,
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [],
        insertions: 0,
        deletions: 0,
        clean: true,
        truncated: false,
      },
    ],
    files: 3,
    insertions: 6,
    deletions: 3,
    scannedDirectories: 19,
    skippedDirectories: 4,
    partial,
    truncated: partial,
    issues: partial ? [{ repositoryPath: "modules/deep", message: "Depth limit reached." }] : [],
  };
}

function renderWorkspaceChanges(status: WorkspaceGitSnapshot): string {
  return renderToStaticMarkup(createElement(WorkspaceChangesPanel, {
    projectName: "Openbravo",
    snapshot: status,
    loading: false,
    summary: null,
    selectionAnswer: null,
    reviewStates: [],
    notes: [],
    wrapLines: true,
    onRefresh: () => undefined,
    onLoadRepositoryDiff: async (repositoryPath: string) => ({
      repositoryPath,
      patch: "",
      truncated: false,
      files: [],
    }),
    onOpenWorkspaceFile: () => undefined,
    onAsk: async () => undefined,
    onRequestRevision: async () => undefined,
    onRevert: async () => undefined,
    onSetReviewState: async () => undefined,
    onCreateNote: async () => undefined,
    onUpdateNote: async () => undefined,
    onDeleteNote: async () => undefined,
    onAddTextToPrompt: () => undefined,
    onAddToPrompt: () => undefined,
  }));
}

describe("workspace repository-grouped Changes panel", () => {
  it("renders compact native repository disclosures without flattening duplicate file paths", () => {
    const html = renderWorkspaceChanges(snapshot());

    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Openbravo");
    expect(html).toContain("project root");
    expect(html).toContain("modules/org.openbravo.alpha");
    expect(html).toContain("modules/org.openbravo.beta");
    expect((html.match(/Main\.java/gu) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("No local changes");
    expect(html).toContain("3 files in 4 repositories");
    expect(html).toContain("aria-label=\"Git repositories and changed files\"");
    expect(html).toContain("Open src/Main.java from modules/org.openbravo.alpha");
    expect(html).toContain("Open src/Main.java from modules/org.openbravo.beta");
  });

  it("announces bounded discovery honestly while preserving visible repository results", () => {
    const html = renderWorkspaceChanges(snapshot(true));

    expect(html).toContain('role="status"');
    expect(html).toContain("Repository scan was bounded.");
    expect(html).toContain("Scanned 19 folders");
    expect(html).toContain("modules/org.openbravo.alpha");
  });

  it("shows a precise nested-only review capability notice", () => {
    const nested = snapshot();
    nested.repositories = nested.repositories.filter((repository) => repository.repositoryPath !== ".");
    nested.files = 2;
    const html = renderWorkspaceChanges(nested);

    expect(html).toContain("Reviewing modules/org.openbravo.alpha.");
    expect(html).toContain("Questions and prompt references keep this repository identity.");
    expect(html).toContain("Persistent marks, local notes, revisions, and selective revert");
  });
});

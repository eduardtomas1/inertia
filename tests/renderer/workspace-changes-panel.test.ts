import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChangesPanel,
} from "../../src/renderer/src/components/ChangesPanel";
import {
  WorkspaceChangesPanel,
  workspaceGitRepositoriesWithMissingReviewTargets,
  workspaceGitSelectedFileRevision,
} from "../../src/renderer/src/components/WorkspaceChangesPanel";
import type {
  ChangedFile,
  DiffReviewNote,
  DiffReviewState,
  DiffReviewSummary,
  WorkspaceGitSnapshot,
} from "../../src/shared/contracts";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

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
    discoveredRepositories: 4,
    repositoryLimit: 128,
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

describe("workspace repository-scoped Changes panel", () => {
  it("renders a repository-scoped summary while displaying a selected-file diff", () => {
    const selectedPatch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const repositoryPatch = [
      selectedPatch,
      "diff --git a/other.md b/other.md",
      "--- a/other.md",
      "+++ b/other.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const repositoryFingerprint = parseUnifiedDiff(repositoryPatch).fingerprint;
    const selectedFingerprint = parseUnifiedDiff(selectedPatch).fingerprint;
    const summary: DiffReviewSummary = {
      conversationId: "conversation",
      fingerprint: repositoryFingerprint,
      providerId: "codex",
      harnessId: "codex",
      backendProfileId: null,
      model: null,
      overall: "Repository summary",
      classifications: [],
      files: [{
        path: "README.md",
        summary: "Selected-file summary from the repository review.",
        classifications: [],
        hunks: [],
      }],
      generatedAt: new Date(0).toISOString(),
    };

    expect(repositoryFingerprint).not.toBe(selectedFingerprint);
    const html = renderToStaticMarkup(createElement(ChangesPanel, {
      files: [changedFile("README.md")],
      diff: {
        patch: selectedPatch,
        truncated: false,
        files: [changedFile("README.md")],
      },
      selectedPath: "README.md",
      summary,
      summaryFingerprint: repositoryFingerprint,
      onSelectFile: () => undefined,
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

    expect(html).toContain("Selected-file summary from the repository review.");
  });

  it("keeps POSIX literal backslashes in Git wire-path basenames", () => {
    const path = "docs/notes\\draft.md";
    const patch = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const html = renderToStaticMarkup(createElement(ChangesPanel, {
      files: [changedFile(path)],
      diff: {
        patch,
        truncated: false,
        files: [changedFile(path)],
      },
      selectedPath: path,
      summary: null,
      onSelectFile: () => undefined,
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

    expect(html).toContain(
      '<span class="change-file-name">notes\\draft.md</span>',
    );
    expect(html).toContain(
      '<span class="change-file-path">docs</span>',
    );
    expect(html).toContain('data-language-family="markup"');
  });

  it("renders one flat repository scope without flattening repository identity", () => {
    const html = renderWorkspaceChanges(snapshot());

    expect(html).not.toContain("<details");
    expect(html).toContain('aria-label="Repository scope"');
    expect(html).toContain("Openbravo");
    expect(html).toContain("modules/org.openbravo.alpha");
    expect(html).toContain("modules/org.openbravo.beta");
    expect(html).toContain("README.md");
    expect(html).toContain('data-language-family="markup"');
    expect(html).not.toContain("Main.java");
    expect(html).toContain("3 files in 4 repositories");
    expect(html).toContain("aria-label=\"Git repositories and changed files\"");
    expect(html).toContain("Open README.md from Openbravo");
  });

  it("announces bounded discovery honestly while preserving visible repository results", () => {
    const html = renderWorkspaceChanges(snapshot(true));

    expect(html).toContain('role="status"');
    expect(html).toContain("Repository discovery was bounded.");
    expect(html).toContain("Scanned 19 folders");
    expect(html).toContain("modules/org.openbravo.alpha");
  });

  it("separates fully staged files from working-tree changes", () => {
    const current = snapshot();
    current.repositories[0]!.files = [
      { ...changedFile("staged.ts"), staged: true, unstaged: false },
      changedFile("working.ts"),
    ];
    const html = renderWorkspaceChanges(current);

    expect(html).toContain("Staged");
    expect(html).toContain("Changes");
    expect(html).toContain("staged.ts");
    expect(html).toContain("working.ts");
  });

  it("changes the selected diff revision when a refresh keeps the file count stable", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.repositories[1]!.files[0]!.insertions = 4;
    after.repositories[1]!.insertions = 4;
    after.insertions = 8;
    const selection = {
      repositoryPath: "modules/org.openbravo.alpha",
      filePath: "src/Main.java",
    };

    expect(after.files).toBe(before.files);
    expect(workspaceGitSelectedFileRevision(after, selection)).not.toBe(
      workspaceGitSelectedFileRevision(before, selection),
    );
  });

  it("finds complete nested repositories whose active review targets disappeared", () => {
    const current = snapshot();
    current.repositories[1]!.files = [];
    current.repositories[1]!.insertions = 0;
    current.repositories[1]!.deletions = 0;
    current.repositories[1]!.clean = true;
    const state: DiffReviewState = {
      conversationId: "conversation",
      repositoryPath: "modules/org.openbravo.alpha",
      scope: "file",
      path: "src/Main.java",
      hunkId: null,
      targetFingerprint: "a".repeat(64),
      reviewed: true,
      stale: false,
      updatedAt: new Date(0).toISOString(),
    };
    const note: DiffReviewNote = {
      id: "note",
      conversationId: "conversation",
      repositoryPath: "modules/org.openbravo.beta",
      path: "src/Removed.java",
      hunkId: null,
      lineIds: [],
      targetFingerprint: "b".repeat(64),
      body: "Review target that is no longer dirty.",
      stale: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    expect(workspaceGitRepositoriesWithMissingReviewTargets(
      current,
      [state],
      [note],
    )).toEqual([
      "modules/org.openbravo.alpha",
      "modules/org.openbravo.beta",
    ]);

    current.repositories[1]!.truncated = true;
    expect(workspaceGitRepositoriesWithMissingReviewTargets(
      current,
      [state, { ...state, repositoryPath: ".", path: "missing-root.ts" }],
      [{ ...note, stale: true }],
    )).toEqual([]);
  });

  it("shows nested review support and the checkpoint-backed revision boundary", () => {
    const nested = snapshot();
    nested.repositories = nested.repositories.filter((repository) => repository.repositoryPath !== ".");
    nested.files = 2;
    const html = renderWorkspaceChanges(nested);

    expect(html).toContain("Nested repo");
    expect(html).toContain("Review marks, local notes, questions, prompt references, and selective revert keep this repository identity");
    expect(html).toContain("Agent summaries and revisions remain available only for the project-root repository");
    expect(html).toContain("recovery checkpoints cover that root");
  });
});

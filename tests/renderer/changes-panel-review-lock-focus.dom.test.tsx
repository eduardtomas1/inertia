import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChangesPanel, type ChangesPanelProps } from "../../src/renderer/src/components/ChangesPanel";
import { WorkspaceChangesPanel } from "../../src/renderer/src/components/WorkspaceChangesPanel";
import type { ChangedFile, DiffReviewNote, WorkspaceGitSnapshot } from "../../src/shared/contracts";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

const file: ChangedFile = {
  path: "README.md",
  status: "modified",
  insertions: 1,
  deletions: 1,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
};

const patch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");

const hunkNote: DiffReviewNote = {
  id: "note-hunk",
  conversationId: "11111111-1111-4111-8111-111111111111",
  repositoryPath: ".",
  path: "README.md",
  hunkId: parseUnifiedDiff(patch).files[0]!.hunks[0]!.id,
  lineIds: [],
  targetFingerprint: "a".repeat(64),
  body: "Explain",
  stale: false,
  createdAt: "2026-09-27T12:00:00.000Z",
  updatedAt: "2026-09-27T12:00:00.000Z",
};

const handlers = () => ({
  onAsk: vi.fn(async () => undefined),
  onRequestRevision: vi.fn(async () => undefined),
  onRevert: vi.fn(async () => undefined),
  onSetReviewState: vi.fn(async () => undefined),
  onCreateNote: vi.fn(async () => undefined),
  onUpdateNote: vi.fn(async () => undefined),
  onDeleteNote: vi.fn(async () => undefined),
  onAddTextToPrompt: vi.fn(),
  onAddToPrompt: vi.fn(),
});

describe("review actions while the diff lock engages", () => {
  it("keeps every lock-gated review action focusable and inert", () => {
    const callbacks = handlers();
    const props: ChangesPanelProps = {
      ...callbacks,
      files: [file],
      diff: { patch, truncated: false, files: [file] },
      selectedPath: "README.md",
      summary: null,
      notes: [hunkNote],
      reviewLock: null,
      onSelectFile: vi.fn(),
    };
    const view = render(<ChangesPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "+ after" }));
    const popover = document.querySelector<HTMLElement>(".diff-selection-popover")!;
    const gated = [
      screen.getByRole("button", { name: "Mark file reviewed" }),
      screen.getByRole("button", { name: "Mark reviewed" }),
      ...screen.getAllByRole("button", { name: "Note" }),
      screen.getByRole("button", { name: "Revise" }),
      within(popover).getByRole("button", { name: "Ask about" }),
      within(popover).getByRole("button", { name: "Request revision" }),
      within(popover).getByRole("button", { name: "Revert" }),
      within(popover).getByRole("button", { name: "Add to prompt" }),
    ];
    expect(gated).toHaveLength(10);
    const focused = within(popover).getByRole("button", { name: "Request revision" });
    focused.focus();

    view.rerender(<ChangesPanel {...props} reviewLock="refreshing" />);

    expect(focused).toHaveFocus();
    for (const button of gated) {
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
    }
    expect(popover.querySelector("form")).toBeNull();
    for (const handler of Object.values(callbacks)) expect(handler).not.toHaveBeenCalled();

    view.rerender(<ChangesPanel {...props} />);
    for (const button of gated) expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("keeps Retry focusable while the status refresh it started is running", async () => {
    const onRefresh = vi.fn();
    const snapshot: WorkspaceGitSnapshot = {
      repositories: [{
        repositoryPath: ".",
        state: "ready",
        error: null,
        branch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        hasRemote: true,
        files: [file],
        insertions: 1,
        deletions: 1,
        clean: false,
        truncated: false,
      }],
      files: 1,
      insertions: 1,
      deletions: 1,
      scannedDirectories: 1,
      skippedDirectories: 0,
      discoveredRepositories: 1,
      repositoryLimit: 64,
      partial: false,
      truncated: false,
      issues: [],
    };
    const base = {
      ...handlers(),
      projectName: "Inertia",
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      summary: null,
      onRefresh,
      onOpenWorkspaceFile: vi.fn(),
      onLoadRepositoryDiff: vi.fn(async () => ({ repositoryPath: ".", patch, truncated: false, files: [file] })),
      snapshot,
      statusError: "Git inspection timed out.",
    };
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WorkspaceChangesPanel {...base} />);
    });
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      view.rerender(<WorkspaceChangesPanel {...base} loading />);
    });

    expect(retry).toHaveFocus();
    expect(retry).toBeEnabled();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(retry);
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

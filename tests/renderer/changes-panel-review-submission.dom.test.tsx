import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceChangesPanel } from "../../src/renderer/src/components/WorkspaceChangesPanel";
import type { ChangedFile, WorkspaceGitSnapshot } from "../../src/shared/contracts";

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    insertions: 2,
    deletions: 1,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: ".",
    worktreeStatus: "M",
  };
}

function patchFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
}

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
    files: [changedFile("README.md")],
    insertions: 2,
    deletions: 1,
    clean: false,
    truncated: false,
  }],
  files: 1,
  insertions: 2,
  deletions: 1,
  scannedDirectories: 1,
  skippedDirectories: 0,
  discoveredRepositories: 1,
  repositoryLimit: 64,
  partial: false,
  truncated: false,
  issues: [],
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

const panelProps = () => ({
  ...handlers(),
  projectName: "Inertia",
  projectId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  summary: null,
  onRefresh: vi.fn(),
  onOpenWorkspaceFile: vi.fn(),
  snapshot,
  onLoadRepositoryDiff: vi.fn(async () => ({ repositoryPath: ".", patch: patchFor("README.md"), truncated: false, files: [changedFile("README.md")] })),
});

describe("changes panel review submission", () => {
  it("does not re-enable submit for a second in-flight question after an A-B-A scope round trip", async () => {
    const settles: Array<() => void> = [];
    const onAsk = vi.fn(() => new Promise<void>((resolve) => { settles.push(resolve); }));
    const base = { ...panelProps(), onAsk };
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WorkspaceChangesPanel {...base} />);
    });
    const ask = async (text: string) => {
      fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
      fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
      fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), { target: { value: text } });
      fireEvent.submit(document.querySelector(".diff-selection-popover form")!);
    };
    await ask("First");
    await act(async () => { view.rerender(<WorkspaceChangesPanel {...base} conversationId="33333333-3333-4333-8333-333333333333" />); });
    await act(async () => { view.rerender(<WorkspaceChangesPanel {...base} />); });
    await ask("Second");
    expect(onAsk).toHaveBeenCalledTimes(2);

    await act(async () => settles[0]!());
    const submitButton = document.querySelector<HTMLButtonElement>(".diff-selection-popover button[type=submit]")!;
    fireEvent.submit(document.querySelector(".diff-selection-popover form")!);
    await act(async () => undefined);
    expect(onAsk).toHaveBeenCalledTimes(2);
    expect(submitButton).toBeDisabled();

    await act(async () => settles[1]!());
    expect(screen.queryByRole("button", { name: "Ask agent" })).not.toBeInTheDocument();
  });
});

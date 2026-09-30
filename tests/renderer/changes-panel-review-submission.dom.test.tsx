import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangesPanel, type ChangesPanelProps } from "../../src/renderer/src/components/ChangesPanel";
import { WorkspaceChangesPanel } from "../../src/renderer/src/components/WorkspaceChangesPanel";
import type { ChangedFile, DiffReviewNote, WorkspaceGitSnapshot } from "../../src/shared/contracts";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

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
  it("clears a submitted draft even when the diff changed while the action was running", async () => {
    let finishRevision!: () => void;
    const onRequestRevision = vi.fn(() => new Promise<void>((resolve) => { finishRevision = resolve; }));
    const base = { ...panelProps(), onRequestRevision };
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WorkspaceChangesPanel {...base} />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    fireEvent.change(screen.getByPlaceholderText("Describe the revision you want…"), {
      target: { value: "Rename this" },
    });
    fireEvent.submit(document.querySelector(".diff-selection-popover form")!);
    expect(onRequestRevision).toHaveBeenCalledOnce();

    const edited = patchFor("README.md").replace("+after", "+after edited");
    await act(async () => {
      view.rerender(<WorkspaceChangesPanel
        {...base}
        snapshot={structuredClone(snapshot)}
        onLoadRepositoryDiff={vi.fn(async () => ({ repositoryPath: ".", patch: edited, truncated: false, files: [changedFile("README.md")] }))}
      />);
    });
    await screen.findByRole("button", { name: "+ after edited" });
    await act(async () => finishRevision());

    expect(screen.queryByText(/The diff changed while it refreshed/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ after edited" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("");
  });

  it("keeps a draft the user edited while the submission was running", async () => {
    let finishRevision!: () => void;
    const onRequestRevision = vi.fn(() => new Promise<void>((resolve) => { finishRevision = resolve; }));
    await act(async () => {
      render(<WorkspaceChangesPanel {...panelProps()} onRequestRevision={onRequestRevision} />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    const textarea = screen.getByPlaceholderText("Describe the revision you want…");
    fireEvent.change(textarea, { target: { value: "Rename this" } });
    fireEvent.submit(document.querySelector(".diff-selection-popover form")!);
    fireEvent.change(textarea, { target: { value: "Rename this and that" } });
    await act(async () => finishRevision());

    expect(screen.getByPlaceholderText("Describe the revision you want…")).toHaveValue("Rename this and that");
  });

  it("keeps a held draft when the user reselects a range as the help text instructs", async () => {
    const base = panelProps();
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WorkspaceChangesPanel {...base} />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), { target: { value: "Held question" } });
    const edited = patchFor("README.md").replace("+after", "+after edited");
    await act(async () => {
      view.rerender(<WorkspaceChangesPanel
        {...base}
        snapshot={structuredClone(snapshot)}
        onLoadRepositoryDiff={vi.fn(async () => ({ repositoryPath: ".", patch: edited, truncated: false, files: [changedFile("README.md")] }))}
      />);
    });
    await screen.findByText(/The diff changed while it refreshed/u);
    fireEvent.click(screen.getByRole("button", { name: "− before" }));
    fireEvent.click(screen.getByRole("button", { name: "+ after edited" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    expect(screen.getByText("2 selected lines")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("Held question");
  });

  it("drops the comment when the user starts a new selection", async () => {
    await act(async () => {
      render(<WorkspaceChangesPanel {...panelProps()} />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), { target: { value: "About after" } });
    fireEvent.click(screen.getByRole("button", { name: "− before" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    expect(screen.getByText("1 selected lines")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("");
  });

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

describe("changes panel review action failures", () => {
  const patch = patchFor("README.md");
  const hunkId = parseUnifiedDiff(patch).files[0]!.hunks[0]!.id;
  const note = (overrides: Partial<DiffReviewNote>): DiffReviewNote => ({
    id: "note-file",
    conversationId: "11111111-1111-4111-8111-111111111111",
    repositoryPath: ".",
    path: "README.md",
    hunkId: null,
    lineIds: [],
    targetFingerprint: "a".repeat(64),
    body: "Explain",
    stale: false,
    createdAt: "2026-09-27T12:00:00.000Z",
    updatedAt: "2026-09-27T12:00:00.000Z",
    ...overrides,
  });

  const renderPanel = (props: Partial<ChangesPanelProps>) => render(<ChangesPanel
    {...handlers()}
    files={[changedFile("README.md")]}
    diff={{ patch, truncated: false, files: [changedFile("README.md")] }}
    selectedPath="README.md"
    summary={null}
    onSelectFile={vi.fn()}
    {...props}
  />);

  const withoutUnhandledRejections = async (run: () => void) => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      run();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a note deletion failure instead of rejecting unhandled", async () => {
    vi.stubGlobal("confirm", () => true);
    const onDeleteNote = vi.fn(async () => {
      throw new Error("The note could not be deleted.");
    });
    await withoutUnhandledRejections(() => {
      renderPanel({ onDeleteNote, notes: [note({})] });
      fireEvent.click(screen.getByRole("button", { name: "Delete file note: Explain" }));
      expect(onDeleteNote).toHaveBeenCalledOnce();
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The note could not be deleted."));
  });

  it("shows a hunk note deletion failure", async () => {
    vi.stubGlobal("confirm", () => true);
    const onDeleteNote = vi.fn(async () => {
      throw new Error("The hunk note could not be deleted.");
    });
    await withoutUnhandledRejections(() => {
      renderPanel({ onDeleteNote, notes: [note({ id: "note-hunk", hunkId })] });
      fireEvent.click(screen.getByRole("button", { name: "Delete hunk note: Explain" }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The hunk note could not be deleted."));
  });

  it("does not delete a note the user did not confirm", () => {
    vi.stubGlobal("confirm", () => false);
    const onDeleteNote = vi.fn(async () => undefined);
    renderPanel({ onDeleteNote, notes: [note({})] });
    fireEvent.click(screen.getByRole("button", { name: "Delete file note: Explain" }));
    expect(onDeleteNote).not.toHaveBeenCalled();
  });

  it("shows a note revision failure", async () => {
    const onRequestRevision = vi.fn(async () => {
      throw new Error("The revision could not be requested.");
    });
    await withoutUnhandledRejections(() => {
      renderPanel({ onRequestRevision, notes: [note({ id: "note-hunk", hunkId })] });
      fireEvent.click(screen.getByRole("button", { name: "Revise" }));
      expect(onRequestRevision).toHaveBeenCalledOnce();
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The revision could not be requested."));
  });

  it("shows an undo revert failure", async () => {
    const onUndoReversal = vi.fn(async () => {
      throw new Error("The reversal could not be undone.");
    });
    await withoutUnhandledRejections(() => {
      renderPanel({
        onUndoReversal,
        lastReversal: {
          id: "reversal-1",
          filePath: "README.md",
          selectedLineCount: 1,
          affectedLayers: ["worktree"],
          createdAt: "2026-09-27T12:00:00.000Z",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Undo revert" }));
      expect(onUndoReversal).toHaveBeenCalledOnce();
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The reversal could not be undone."));
  });
});

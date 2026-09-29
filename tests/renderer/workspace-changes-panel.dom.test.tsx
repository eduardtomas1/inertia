import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceChangesPanel } from "../../src/renderer/src/components/WorkspaceChangesPanel";
import { ChangesPanel } from "../../src/renderer/src/components/ChangesPanel";
import type { ChangedFile, ServerEvent, WorkspaceGitSnapshot } from "../../src/shared/contracts";

const reviewReceipt = {
  authorityRef: "33333333-3333-4333-8333-333333333333",
  fingerprint: "a".repeat(64),
};

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
  repositories: [
    {
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
    },
    {
      repositoryPath: "modules/alpha",
      state: "ready",
      error: null,
      branch: "feature/alpha",
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
    {
      repositoryPath: "modules/unavailable",
      state: "error",
      error: "Permission denied while inspecting this repository.",
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: false,
      files: [],
      insertions: 0,
      deletions: 0,
      clean: false,
      truncated: false,
    },
  ],
  files: 2,
  insertions: 4,
  deletions: 2,
  scannedDirectories: 4,
  skippedDirectories: 0,
  discoveredRepositories: 4,
  repositoryLimit: 64,
  partial: false,
  truncated: false,
  issues: [],
};

describe("WorkspaceChangesPanel repository scope", () => {
  it("opens the workspace file while keeping a same-name parent file reviewable without opening it", async () => {
    const files = [changedFile("app/README.md"), changedFile("README.md")];
    const onOpenWorkspaceFile = vi.fn();
    // Settle the loaded diff and its selection-reset effect before clicking a line.
    await act(async () => {
      render(<WorkspaceChangesPanel
        projectName="Subfolder"
        snapshot={{ ...snapshot, repositories: [{ ...snapshot.repositories[0], workspacePrefix: "app", files }] }}
        summary={null}
        onRefresh={vi.fn()}
        onLoadRepositoryDiff={async (repositoryPath, filePath) => ({ repositoryPath, patch: patchFor(filePath!), files, truncated: false })}
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

    fireEvent.click(screen.getByRole("button", { name: "Open app/README.md from Subfolder" }));
    expect(onOpenWorkspaceFile).toHaveBeenCalledExactlyOnceWith("README.md");
    const parentFile = screen.getByRole("button", { name: "Open README.md from Subfolder" });
    expect(parentFile).toBeDisabled();
    fireEvent.click(parentFile);
    expect(onOpenWorkspaceFile).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "+ after" }));
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    const navigator = screen.getByRole("navigation", { name: "Git repositories and changed files" });
    await act(async () => {
      fireEvent.click(navigator.querySelectorAll(".workspace-repository-file")[1]);
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open file" })).not.toBeInTheDocument());
    await screen.findByRole("region", { name: "Diff content for README.md" });
    fireEvent.click(screen.getByRole("button", { name: "+ after" }));
    expect(screen.getByRole("button", { name: "Ask about" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
    expect(navigator.querySelectorAll(".workspace-repository-file")[1]).toHaveAttribute("aria-current", "true");
  });

  it.each([
    [false, true],
    [true, false],
  ])("offers agent revision only when the chat can continue (unavailable: %s)", async (agentRevisionUnavailable, offered) => {
    const files = [changedFile("app/README.md")];
    const onRequestRevision = vi.fn(async () => undefined);
    await act(async () => {
      render(<WorkspaceChangesPanel
        projectName="Subfolder"
        agentRevisionUnavailable={agentRevisionUnavailable}
        snapshot={{ ...snapshot, repositories: [{ ...snapshot.repositories[0], workspacePrefix: "app", files }] }}
        summary={null}
        onRefresh={vi.fn()}
        onLoadRepositoryDiff={async (repositoryPath, filePath) => ({ repositoryPath, patch: patchFor(filePath!), files, truncated: false })}
        onOpenWorkspaceFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={onRequestRevision}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "+ after" }));
    expect(screen.getByRole("button", { name: "Ask about" })).toBeEnabled();
    expect(screen.queryAllByRole("button", { name: "Request revision" })).toHaveLength(offered ? 1 : 0);
    expect(onRequestRevision).not.toHaveBeenCalled();
  });

  it("creates a file note through the in-app dialog with its repository scope", async () => {
    const onCreateNote = vi.fn(async () => undefined);
    render(<ChangesPanel
      repositoryPath="modules/alpha"
      files={[changedFile("README.md")]}
      diff={{ patch: patchFor("README.md"), truncated: false, files: [changedFile("README.md")] }}
      selectedPath="README.md" summary={null}
      onSelectFile={vi.fn()} onAsk={vi.fn(async () => undefined)}
      onRequestRevision={vi.fn(async () => undefined)} onRevert={vi.fn(async () => undefined)}
      onSetReviewState={vi.fn(async () => undefined)} onCreateNote={onCreateNote}
      onUpdateNote={vi.fn(async () => undefined)} onDeleteNote={vi.fn(async () => undefined)}
      onAddTextToPrompt={vi.fn()} onAddToPrompt={vi.fn()}
    />);
    fireEvent.click(screen.getAllByRole("button", { name: "Note" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Add note for README.md" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Review note" }), {
      target: { value: "  Explain this change  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(onCreateNote).toHaveBeenCalledWith({
      repositoryPath: "modules/alpha", path: "README.md", hunkId: null,
      lineIds: [], targetFingerprint: expect.any(String), body: "Explain this change",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps a keyboard-focusable stop control beside an active selection question", async () => {
    let finishQuestion: (() => void) | undefined;
    let finishCancellation: (() => void) | undefined;
    const onAsk = vi.fn(() => new Promise<void>((resolve) => {
      finishQuestion = resolve;
    }));
    const onCancelAsk = vi.fn(() => new Promise<void>((resolve) => {
      finishCancellation = resolve;
    }));
    render(
      <ChangesPanel
        files={[changedFile("README.md")]}
        diff={{
          patch: patchFor("README.md"),
          truncated: false,
          files: [changedFile("README.md")],
        }}
        selectedPath="README.md"
        summary={null}
        onSelectFile={vi.fn()}
        onRefresh={vi.fn()}
        onAsk={onAsk}
        onCancelAsk={onCancelAsk}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );

    fireEvent.click((await screen.findByText("after")).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));

    const stop = await screen.findByRole("button", { name: "Stop asking" });
    stop.focus();
    expect(document.activeElement).toBe(stop);
    expect(screen.queryByRole("button", { name: "Ask agent" })).not.toBeInTheDocument();
    fireEvent.click(stop);
    expect(onCancelAsk).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Stopping…$/u })).toBeDisabled();

    await act(async () => {
      finishCancellation?.();
      finishQuestion?.();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Stopping…$/u }))
      .not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Refresh changes" }))
      .toHaveFocus();
  });

  it("restores the stop control after selection UI unmounts and reports cancellation failure", async () => {
    const onCancelAsk = vi.fn(async () => {
      throw new Error("The active review question was already released.");
    });
    render(
      <ChangesPanel
        files={[changedFile("README.md")]}
        diff={{
          patch: patchFor("README.md"),
          truncated: false,
          files: [changedFile("README.md")],
        }}
        selectedPath="README.md"
        summary={null}
        questionRunning
        onSelectFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onCancelAsk={onCancelAsk}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );

    const stop = screen.getByRole("button", { name: "Stop asking" });
    stop.focus();
    expect(document.activeElement).toBe(stop);
    fireEvent.click(stop);

    expect(onCancelAsk).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(
      "The active review question was already released.",
    )).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "Stop asking" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop asking" })).toHaveFocus();

    fireEvent.click(screen.getByText("after").closest("button")!);
    expect(screen.getByRole("button", { name: "Ask about" })).toBeDisabled();
  });

  it("keeps a selection drafted while an earlier question was still answering", async () => {
    let finishQuestion!: () => void;
    const onAsk = vi.fn(() => new Promise<void>((resolve) => {
      finishQuestion = resolve;
    }));
    render(
      <ChangesPanel
        files={[changedFile("README.md")]}
        diff={{ patch: patchFor("README.md"), truncated: false, files: [changedFile("README.md")] }}
        selectedPath="README.md"
        summary={null}
        onSelectFile={vi.fn()}
        onAsk={onAsk}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
      target: { value: "First question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));
    expect(onAsk).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "− before" }));
    fireEvent.click(within(document.querySelector<HTMLElement>(".diff-selection-popover")!)
      .getByRole("button", { name: "Note" }));
    fireEvent.change(screen.getByPlaceholderText("Write a local note about this range…"), {
      target: { value: "Second draft" },
    });
    await act(async () => finishQuestion());

    expect(screen.getByPlaceholderText("Write a local note about this range…"))
      .toHaveValue("Second draft");
  });

  it("shows review action failures without losing the draft", async () => {
    const onAsk = vi.fn(async () => {
      throw new Error("The review question could not be sent.");
    });
    const onSetReviewState = vi.fn(async () => {
      throw new Error("The review mark could not be saved.");
    });
    render(
      <ChangesPanel
        files={[changedFile("README.md")]}
        diff={{ patch: patchFor("README.md"), truncated: false, files: [changedFile("README.md")] }}
        selectedPath="README.md"
        summary={null}
        onSelectFile={vi.fn()}
        onAsk={onAsk}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={onSetReviewState}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
      target: { value: "Keep this question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The review question could not be sent.",
    );
    expect(screen.getByPlaceholderText("What would you like to know?"))
      .toHaveValue("Keep this question");

    fireEvent.click(screen.getByRole("button", { name: "Mark file reviewed" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "The review mark could not be saved.",
    ));
  });

  it("extends a line selection from the keyboard", () => {
    render(
      <ChangesPanel
        files={[changedFile("README.md")]}
        diff={{ patch: patchFor("README.md"), truncated: false, files: [changedFile("README.md")] }}
        selectedPath="README.md"
        summary={null}
        onSelectFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "− before" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "+ after" }), {
      key: "Enter",
      shiftKey: true,
    });
    fireEvent.click(within(document.querySelector<HTMLElement>(".diff-selection-popover")!)
      .getByRole("button", { name: "Note" }));
    expect(screen.getByText("2 selected lines")).toBeInTheDocument();
    expect(screen.getByText(/Shift\+Enter/u)).toBeInTheDocument();
  });

  it("names each review note control after its note", () => {
    const note = (id: string, hunkId: string | null, body: string) => ({
      id,
      conversationId: "11111111-1111-4111-8111-111111111111",
      repositoryPath: ".",
      path: "README.md",
      hunkId,
      lineIds: [],
      targetFingerprint: "a".repeat(64),
      body,
      stale: hunkId !== null,
      createdAt: "2026-09-27T12:00:00.000Z",
      updatedAt: "2026-09-27T12:00:00.000Z",
    });
    render(
      <ChangesPanel
        files={[changedFile("README.md")]}
        diff={{ patch: patchFor("README.md"), truncated: false, files: [changedFile("README.md")] }}
        selectedPath="README.md"
        summary={null}
        notes={[
          note("note-file", null, "Explain the rename"),
          note("note-stale", "hunk-missing", "Check the heading"),
        ]}
        onSelectFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit file note: Explain the rename" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete file note: Explain the rename" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit stale note: Check the heading" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit note" })).not.toBeInTheDocument();
  });

  it("clears a completed stop attempt before a later question starts", async () => {
    const onCancelAsk = vi.fn(async () => undefined);
    const panel = (questionRunning: boolean): React.JSX.Element => (
      <ChangesPanel
        files={[changedFile("README.md")]}
        diff={{
          patch: patchFor("README.md"),
          truncated: false,
          files: [changedFile("README.md")],
        }}
        selectedPath="README.md"
        summary={null}
        questionRunning={questionRunning}
        onSelectFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onCancelAsk={onCancelAsk}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />
    );
    const view = render(panel(true));

    fireEvent.click(screen.getByRole("button", { name: "Stop asking" }));
    expect(screen.getByRole("button", { name: /Stopping…$/u })).toBeDisabled();

    view.rerender(panel(false));
    expect(screen.queryByRole("button", { name: "Stop asking" }))
      .not.toBeInTheDocument();
    view.rerender(panel(true));
    expect(screen.getByRole("button", { name: "Stop asking" })).toBeEnabled();
  });

  it("switches one flat file navigator between repositories without losing identity", async () => {
    const onLoadRepositoryDiff = vi.fn(async (
      repositoryPath: string,
      filePath?: string,
    ) => ({
      repositoryPath,
      patch: filePath ? [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n") : "",
      truncated: false,
      files: filePath ? [changedFile(filePath)] : [],
    }));

    render(
      <WorkspaceChangesPanel
        projectName="Inertia"
        snapshot={snapshot}
        summary={null}
        onRefresh={vi.fn()}
        onLoadRepositoryDiff={onLoadRepositoryDiff}
        onOpenWorkspaceFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );

    const repositoryScope = screen.getByRole("combobox", {
      name: "Repository scope",
    });
    const rootFile = screen.getByText("README.md", { exact: true })
      .closest("button");
    expect(rootFile).not.toBeNull();
    expect(within(rootFile!).getAllByText("unstaged", { exact: true }))
      .toHaveLength(1);
    expect(screen.queryByText("Main.java", { exact: true })).not.toBeInTheDocument();

    fireEvent.change(repositoryScope, { target: { value: "modules/alpha" } });

    expect(await screen.findByText("Main.java", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("README.md", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Nested repo", { exact: true })).toBeInTheDocument();
    await waitFor(() => {
      expect(onLoadRepositoryDiff).toHaveBeenLastCalledWith(
        "modules/alpha",
        "src/Main.java",
      );
    });

    fireEvent.change(repositoryScope, { target: { value: "modules/clean" } });
    expect(await screen.findByText("modules/clean is clean", { exact: true }))
      .toBeInTheDocument();
    expect(screen.queryByRole("navigation", {
      name: "Git repositories and changed files",
    })).not.toBeInTheDocument();

    fireEvent.change(repositoryScope, {
      target: { value: "modules/unavailable" },
    });
    expect(await screen.findByText("Repository unavailable", { exact: true }))
      .toBeInTheDocument();
    expect(screen.getAllByText(
      "Permission denied while inspecting this repository.",
      { exact: true },
    )).toHaveLength(1);
    expect(screen.queryByRole("navigation", {
      name: "Git repositories and changed files",
    })).not.toBeInTheDocument();
  });

  it("never exposes a prior repository diff under a new identity and settles when the target is clean", async () => {
    const duplicatePathSnapshot = structuredClone(snapshot);
    duplicatePathSnapshot.repositories[0]!.files = [changedFile("src/shared.ts")];
    duplicatePathSnapshot.repositories[1]!.files = [changedFile("src/shared.ts")];
    const pending = new Map<string, {
      resolve: (value: {
        repositoryPath: string;
        patch: string;
        truncated: false;
        files: ChangedFile[];
      }) => void;
      promise: Promise<{
        repositoryPath: string;
        patch: string;
        truncated: false;
        files: ChangedFile[];
      }>;
    }>();
    const onLoadRepositoryDiff = vi.fn((repositoryPath: string) => {
      let resolve!: (value: {
        repositoryPath: string;
        patch: string;
        truncated: false;
        files: ChangedFile[];
      }) => void;
      const promise = new Promise<{
        repositoryPath: string;
        patch: string;
        truncated: false;
        files: ChangedFile[];
      }>((accept) => {
        resolve = accept;
      });
      pending.set(repositoryPath, { resolve, promise });
      return promise;
    });
    const diff = (repositoryPath: string, marker: string) => ({
      repositoryPath,
      patch: [
        "diff --git a/src/shared.ts b/src/shared.ts",
        "--- a/src/shared.ts",
        "+++ b/src/shared.ts",
        "@@ -1 +1 @@",
        `-${marker} before`,
        `+${marker} after`,
        "",
      ].join("\n"),
      truncated: false as const,
      files: [changedFile("src/shared.ts")],
    });

    render(
      <WorkspaceChangesPanel
        projectName="Inertia"
        snapshot={duplicatePathSnapshot}
        summary={null}
        onRefresh={vi.fn()}
        onLoadRepositoryDiff={onLoadRepositoryDiff}
        onOpenWorkspaceFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );

    await waitFor(() => expect(pending.has(".")).toBe(true));
    await act(async () => pending.get(".")!.resolve(diff(".", "root")));
    expect(await screen.findByText(/root after/u)).toBeInTheDocument();

    const repositoryScope = screen.getByRole("combobox", {
      name: "Repository scope",
    });
    fireEvent.change(repositoryScope, { target: { value: "modules/alpha" } });
    await waitFor(() => expect(pending.has("modules/alpha")).toBe(true));
    expect(screen.queryByText(/root after/u)).not.toBeInTheDocument();

    fireEvent.change(repositoryScope, { target: { value: "modules/clean" } });
    await waitFor(() => {
      expect(screen.getByLabelText("Workspace changes"))
        .toHaveAttribute("aria-busy", "false");
    });
    await act(async () => {
      pending.get("modules/alpha")!.resolve(diff("modules/alpha", "alpha"));
    });
    expect(screen.queryByText(/alpha after/u)).not.toBeInTheDocument();
    expect(screen.getByText("modules/clean is clean", { exact: true }))
      .toBeInTheDocument();
  });

  it("keeps the loaded diff and an in-progress review comment across a same-file refresh", async () => {
    const props = {
      projectName: "Inertia",
      summary: null,
      onRefresh: vi.fn(),
      onOpenWorkspaceFile: vi.fn(),
      onAsk: vi.fn(async () => undefined),
      onRequestRevision: vi.fn(async () => undefined),
      onRevert: vi.fn(async () => undefined),
      onSetReviewState: vi.fn(async () => undefined),
      onCreateNote: vi.fn(async () => undefined),
      onUpdateNote: vi.fn(async () => undefined),
      onDeleteNote: vi.fn(async () => undefined),
      onAddTextToPrompt: vi.fn(),
      onAddToPrompt: vi.fn(),
    };
    const loader = () => vi.fn(async (repositoryPath: string, filePath?: string) => ({
      repositoryPath,
      patch: patchFor(filePath ?? "README.md"),
      truncated: false,
      files: [changedFile(filePath ?? "README.md")],
    }));
    const firstLoader = loader();
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WorkspaceChangesPanel
        {...props}
        snapshot={snapshot}
        onLoadRepositoryDiff={firstLoader}
      />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
      target: { value: "Why this change?" },
    });

    const refreshedLoader = loader();
    await act(async () => {
      view.rerender(<WorkspaceChangesPanel
        {...props}
        snapshot={structuredClone(snapshot)}
        onLoadRepositoryDiff={refreshedLoader}
      />);
    });

    expect(refreshedLoader).toHaveBeenCalledWith(".", "README.md");
    expect(screen.getByRole("region", { name: "Diff content for README.md" }))
      .toBeInTheDocument();
    expect(screen.getByPlaceholderText("What would you like to know?"))
      .toHaveValue("Why this change?");
    expect(screen.getByText("1 selected lines")).toBeInTheDocument();
  });

  describe("while a same-file refresh revalidates the retained diff", () => {
    const callbacks = () => ({
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
    const editedPatch = patchFor("README.md").replace("+after", "+after edited");
    const loaded = (patch: string) => ({
      repositoryPath: ".",
      patch,
      truncated: false,
      files: [changedFile("README.md")],
    });

    async function draftThenRefresh(settle: "pending" | "same" | "changed" | "failed") {
      const handlers = callbacks();
      const props = {
        projectName: "Inertia",
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
        summary: null,
        onRefresh: vi.fn(),
        onOpenWorkspaceFile: vi.fn(),
        ...handlers,
      };
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<WorkspaceChangesPanel
          {...props}
          snapshot={snapshot}
          onLoadRepositoryDiff={vi.fn(async () => loaded(patchFor("README.md")))}
        />);
      });
      fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
      fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
      fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
        target: { value: "Held question" },
      });
      let resolveLoad!: (patch: string) => void;
      let rejectLoad!: (error: Error) => void;
      view.rerender(<WorkspaceChangesPanel
        {...props}
        snapshot={structuredClone(snapshot)}
        onLoadRepositoryDiff={vi.fn(() => new Promise<ReturnType<typeof loaded>>((resolve, reject) => {
          resolveLoad = (patch) => resolve(loaded(patch));
          rejectLoad = reject;
        }))}
      />);
      const pending = {
        region: screen.getByRole("region", { name: "Diff content for README.md" }),
        draft: screen.getByPlaceholderText("What would you like to know?"),
      };
      if (settle === "same") await act(async () => resolveLoad(patchFor("README.md")));
      if (settle === "changed") await act(async () => resolveLoad(editedPatch));
      if (settle === "failed") await act(async () => rejectLoad(new Error("Git inspection timed out.")));
      return { handlers, pending };
    }

    function expectReadOnly(handlers: ReturnType<typeof callbacks>): void {
      const popover = document.querySelector<HTMLElement>(".diff-selection-popover")!;
      for (const name of ["Ask about", "Request revision", "Revert", "Note", "Add to prompt"]) {
        const button = within(popover).queryByRole("button", { name });
        if (button) expect(button).toBeDisabled();
      }
      expect(within(popover).getByRole("button", { name: "Ask agent" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Mark file reviewed" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
      for (const note of screen.getAllByRole("button", { name: "Note" })) {
        expect(note).toBeDisabled();
      }
      const line = screen.getByRole("button", { name: "− before" });
      expect(line).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(line);
      fireEvent.keyDown(screen.getByRole("button", { name: "+ after" }), { key: "Enter", shiftKey: true });
      fireEvent.submit(popover.querySelector("form")!);
      for (const button of within(popover).getAllByRole("button")) {
        if (button.getAttribute("aria-label") !== "Clear selection") fireEvent.click(button);
      }
      fireEvent.click(screen.getByRole("button", { name: "Mark file reviewed" }));
      expect(screen.getByText("1 selected lines")).toBeInTheDocument();
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    }

    it("keeps the draft visible but blocks every review action while the reload is pending", async () => {
      const { handlers, pending } = await draftThenRefresh("pending");
      expect(pending.region).toBeInTheDocument();
      expect(pending.draft).toHaveValue("Held question");
      expectReadOnly(handlers);
      expect(screen.getByText("Refreshing this diff. Review actions resume when it is current."))
        .toHaveAttribute("role", "status");
    });

    it("re-enables the same selection and draft when the reload returns the same diff", async () => {
      const { handlers } = await draftThenRefresh("same");
      expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("Held question");
      expect(screen.getByText("1 selected lines")).toBeInTheDocument();
      expect(screen.queryByText(/Review actions resume/u)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add to prompt" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));
      await waitFor(() => expect(handlers.onAsk).toHaveBeenCalledOnce());
    });

    it("keeps only the draft text when the reload returns different lines", async () => {
      await draftThenRefresh("changed");
      expect(await screen.findByRole("button", { name: "+ after edited" })).toBeEnabled();
      expect(screen.queryByPlaceholderText("What would you like to know?")).not.toBeInTheDocument();
      expect(document.querySelector(".diff-selection-popover")).toBeNull();
      expect(screen.getByText("The diff changed while it refreshed. Select lines again to continue your draft."))
        .toHaveAttribute("role", "status");

      fireEvent.click(screen.getByRole("button", { name: "+ after edited" }));
      fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
      expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("Held question");
    });

    it("stays read-only with the retained diff and shows the error when the reload fails", async () => {
      const { handlers } = await draftThenRefresh("failed");
      expect(screen.getByRole("alert")).toHaveTextContent("Diff could not be refreshed. Git inspection timed out.");
      expect(screen.getByRole("region", { name: "Diff content for README.md" })).toBeInTheDocument();
      expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("Held question");
      expect(screen.getByText("This diff could not be refreshed. Review actions stay paused until it is current."))
        .toHaveAttribute("role", "status");
      expectReadOnly(handlers);
    });
  });

  describe("retained diff lock inputs from the workspace status refresh", () => {
    async function validatedDraft() {
      const handlers = {
        onAsk: vi.fn(async () => undefined),
        onRequestRevision: vi.fn(async () => undefined),
        onRevert: vi.fn(async () => undefined),
        onSetReviewState: vi.fn(async () => undefined),
        onCreateNote: vi.fn(async () => undefined),
        onUpdateNote: vi.fn(async () => undefined),
        onDeleteNote: vi.fn(async () => undefined),
        onAddTextToPrompt: vi.fn(),
        onAddToPrompt: vi.fn(),
      };
      const onRefresh = vi.fn();
      const base = {
        projectName: "Inertia",
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
        summary: null,
        onRefresh,
        onOpenWorkspaceFile: vi.fn(),
        onLoadRepositoryDiff: vi.fn(async (repositoryPath: string, filePath?: string) => ({
          repositoryPath,
          patch: patchFor(filePath ?? "README.md"),
          truncated: false,
          files: [changedFile(filePath ?? "README.md")],
        })),
        snapshot,
        ...handlers,
      };
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<WorkspaceChangesPanel {...base} />);
      });
      fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
      fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
      fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
        target: { value: "Held question" },
      });
      const update = async (change: Partial<React.ComponentProps<typeof WorkspaceChangesPanel>>) => {
        await act(async () => {
          view.rerender(<WorkspaceChangesPanel {...base} {...change} />);
        });
      };
      return { handlers, onRefresh, update };
    }

    function expectLocked(handlers: Record<string, ReturnType<typeof vi.fn>>, message: string): void {
      expect(screen.getByText(message)).toHaveAttribute("role", "status");
      expect(screen.getByRole("button", { name: "Add to prompt" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Ask agent" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Mark file reviewed" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "− before" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("Held question");
      fireEvent.submit(document.querySelector(".diff-selection-popover form")!);
      fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
      fireEvent.click(screen.getByRole("button", { name: "− before" }));
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    }

    function expectUnlocked(): void {
      expect(screen.queryByText(/Review actions (resume|stay paused)|may be out of date/u)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add to prompt" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Ask agent" })).toBeEnabled();
      expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("Held question");
    }

    it("unlocks only after a diff load validates the current snapshot", async () => {
      await validatedDraft();
      expectUnlocked();
    });

    it("locks while a status refresh is pending or hung", async () => {
      const { handlers, update } = await validatedDraft();
      await update({ loading: true });
      expectLocked(handlers, "Refreshing this diff. Review actions resume when it is current.");
    });

    it("stays locked after an authoritative status refresh fails, until a later refresh revalidates the diff", async () => {
      const { handlers, onRefresh, update } = await validatedDraft();
      await update({ loading: true });
      await update({ loading: false, statusError: "Git inspection timed out." });

      expect(screen.getByRole("button", { name: "Add to prompt" })).toBeDisabled();
      expectLocked(handlers, "This diff could not be refreshed. Review actions stay paused until it is current.");
      expect(screen.getByRole("alert")).toHaveTextContent("Git status could not be refreshed. Git inspection timed out.");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRefresh).toHaveBeenCalledOnce();

      await update({ loading: true, statusError: null });
      expectLocked(handlers, "Refreshing this diff. Review actions resume when it is current.");
      await update({ loading: false, statusError: null, snapshot: structuredClone(snapshot) });
      expectUnlocked();
      fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));
      await waitFor(() => expect(handlers.onAsk).toHaveBeenCalledOnce());
    });

    it("stays locked when a failed refresh clears without delivering a new snapshot", async () => {
      const { handlers, update } = await validatedDraft();
      await update({ statusError: "Git inspection timed out." });
      await update({ statusError: null });
      expectLocked(handlers, "This diff may be out of date. Refresh changes to resume review actions.");
      await update({ snapshot: structuredClone(snapshot) });
      expectUnlocked();
    });

    it("locks on an invalidation that has not refreshed yet and unlocks after the refreshed diff validates", async () => {
      const { handlers, update } = await validatedDraft();
      await update({ statusStale: true });
      expectLocked(handlers, "This diff may be out of date. Refresh changes to resume review actions.");
      await update({ statusStale: false, snapshot: structuredClone(snapshot) });
      expectUnlocked();
    });

    it("removes the retained diff and its actions when the repository is no longer ready", async () => {
      const { handlers, update } = await validatedDraft();
      const unavailable = structuredClone(snapshot);
      unavailable.repositories[0] = { ...unavailable.repositories[0]!, state: "error", error: "Permission denied." };
      await update({ snapshot: unavailable });
      expect(screen.queryByRole("region", { name: "Diff content for README.md" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add to prompt" })).not.toBeInTheDocument();
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("scope-bound review controls", () => {
    const projectA = "11111111-1111-4111-8111-111111111111";
    const projectB = "44444444-4444-4444-8444-444444444444";
    const chatA = "22222222-2222-4222-8222-222222222222";
    const chatB = "33333333-3333-4333-8333-333333333333";
    const scoped = structuredClone(snapshot);
    scoped.repositories[0]!.files = [changedFile("README.md"), changedFile("docs/guide.md")];
    scoped.repositories[0]!.authorityRef = "55555555-5555-4555-8555-555555555555";
    const fileNote = {
      id: "note-file",
      conversationId: chatA,
      repositoryPath: ".",
      path: "README.md",
      hunkId: null,
      lineIds: [],
      targetFingerprint: "a".repeat(64),
      body: "Check the heading",
      stale: false,
      createdAt: "2026-09-27T12:00:00.000Z",
      updatedAt: "2026-09-27T12:00:00.000Z",
    };

    async function renderScoped(overrides: Partial<React.ComponentProps<typeof WorkspaceChangesPanel>> = {}) {
      const handlers = {
        onAsk: vi.fn(async () => undefined),
        onRequestRevision: vi.fn(async () => undefined),
        onRevert: vi.fn(async () => undefined),
        onSetReviewState: vi.fn(async () => undefined),
        onCreateNote: vi.fn(async () => undefined),
        onUpdateNote: vi.fn(async () => undefined),
        onDeleteNote: vi.fn(async () => undefined),
        onAddTextToPrompt: vi.fn(),
        onAddToPrompt: vi.fn(),
      };
      const run = vi.fn(async (): Promise<ServerEvent> => ({ type: "request.ok", requestId: crypto.randomUUID() }));
      const base: React.ComponentProps<typeof WorkspaceChangesPanel> = {
        projectName: "Inertia",
        projectId: projectA,
        conversationId: chatA,
        summary: null,
        notes: [fileNote],
        run,
        onRefresh: vi.fn(),
        onOpenWorkspaceFile: vi.fn(),
        onLoadRepositoryDiff: vi.fn(async (repositoryPath: string, filePath?: string, commitReview?: boolean) => ({
          repositoryPath,
          patch: filePath ? patchFor(filePath) : scoped.repositories[0]!.files.map(({ path }) => patchFor(path)).join("\n"),
          truncated: false,
          files: filePath ? [changedFile(filePath)] : scoped.repositories[0]!.files,
          ...(commitReview ? { commitReview: reviewReceipt } : {}),
        })),
        snapshot: scoped,
        ...handlers,
        ...overrides,
      };
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<WorkspaceChangesPanel {...base} />);
      });
      await screen.findByRole("region", { name: "Diff content for README.md" });
      const update = async (change: Partial<React.ComponentProps<typeof WorkspaceChangesPanel>>) => {
        await act(async () => {
          view.rerender(<WorkspaceChangesPanel {...base} {...change} />);
        });
      };
      return { handlers, run, update };
    }

    const switches: Array<[string, (update: (change: Partial<React.ComponentProps<typeof WorkspaceChangesPanel>>) => Promise<void>) => Promise<void>]> = [
      ["file", async () => {
        const navigator = screen.getByRole("navigation", { name: "Git repositories and changed files" });
        await act(async () => {
          fireEvent.click(navigator.querySelectorAll(".workspace-repository-file")[1]!);
        });
      }],
      ["repository", async () => {
        await act(async () => {
          fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
            target: { value: "modules/alpha" },
          });
        });
      }],
      ["project", async (update) => update({ projectId: projectB })],
      ["conversation", async (update) => update({ conversationId: chatB })],
    ];
    const controls: Array<[string, () => Promise<void>]> = [
      ["new note dialog", async () => {
        fireEvent.click(within(document.querySelector<HTMLElement>(".diff-file-review-heading")!)
          .getByRole("button", { name: "Note" }));
        const dialog = await screen.findByRole("dialog", { name: "Add note for README.md" });
        fireEvent.change(within(dialog).getByRole("textbox", { name: "Review note" }), {
          target: { value: "Note for the first scope" },
        });
      }],
      ["edit note dialog", async () => {
        fireEvent.click(screen.getByRole("button", { name: "Edit file note: Check the heading" }));
        const dialog = await screen.findByRole("dialog", { name: "Edit review note" });
        fireEvent.change(within(dialog).getByRole("textbox", { name: "Review note" }), {
          target: { value: "Edited in the first scope" },
        });
      }],
      ["selection popover draft", async () => {
        fireEvent.click(screen.getByRole("button", { name: "+ after" }));
        fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
        fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
          target: { value: "Question for the first scope" },
        });
      }],
    ];

    for (const [control, open] of controls) {
      for (const [scope, change] of switches) {
        it(`closes the ${control} when the ${scope} changes`, async () => {
          const { handlers, update } = await renderScoped();
          await open();
          await change(update);

          expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
          expect(document.querySelector(".diff-selection-popover")).toBeNull();
          expect(screen.queryByDisplayValue(/first scope/u)).not.toBeInTheDocument();
          for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
        });
      }
    }

    it.each(["project", "conversation"] as const)("closes the commit review when the %s changes", async (scope) => {
      const { run, update } = await renderScoped();
      fireEvent.click(within(screen.getByLabelText("Actions for Inertia")).getByRole("button", { name: "Commit" }));
      expect(await screen.findByRole("dialog", { name: "Commit changes" })).toBeInTheDocument();

      await update(scope === "project" ? { projectId: projectB } : { conversationId: chatB });

      expect(screen.queryByRole("dialog", { name: "Commit changes" })).not.toBeInTheDocument();
      expect(run).not.toHaveBeenCalled();
    });

    it("keeps a question that finishes after a scope switch out of the new scope", async () => {
      let settleQuestion!: (error?: Error) => void;
      const onAsk = vi.fn(() => new Promise<void>((resolve, reject) => {
        settleQuestion = (error) => error ? reject(error) : resolve();
      }));
      const { update } = await renderScoped({ onAsk });
      fireEvent.click(screen.getByRole("button", { name: "+ after" }));
      fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
      fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
        target: { value: "Question in chat A" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));
      expect(onAsk).toHaveBeenCalledOnce();

      await update({ conversationId: chatB, onAsk });
      fireEvent.click(screen.getByRole("button", { name: "+ after" }));
      fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
      fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
        target: { value: "Draft in chat B" },
      });
      expect(screen.getByRole("button", { name: "Ask agent" })).toBeEnabled();

      await act(async () => settleQuestion(new Error("The chat A question failed.")));

      expect(screen.getByPlaceholderText("What would you like to know?")).toHaveValue("Draft in chat B");
      expect(screen.getByText("1 selected lines")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ask agent" })).toBeEnabled();
      expect(screen.queryByText("The chat A question failed.")).not.toBeInTheDocument();
    });
  });

  it("drops the retained diff and review draft when the workspace owner changes behind the same paths", async () => {
    const onAsk = vi.fn(async () => undefined);
    const props = {
      projectName: "Inertia",
      summary: null,
      onRefresh: vi.fn(),
      onOpenWorkspaceFile: vi.fn(),
      onAsk,
      onRequestRevision: vi.fn(async () => undefined),
      onRevert: vi.fn(async () => undefined),
      onSetReviewState: vi.fn(async () => undefined),
      onCreateNote: vi.fn(async () => undefined),
      onUpdateNote: vi.fn(async () => undefined),
      onDeleteNote: vi.fn(async () => undefined),
      onAddTextToPrompt: vi.fn(),
      onAddToPrompt: vi.fn(),
    };
    const diff = (repositoryPath: string, filePath?: string) => ({
      repositoryPath,
      patch: patchFor(filePath ?? "README.md"),
      truncated: false,
      files: [changedFile(filePath ?? "README.md")],
    });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WorkspaceChangesPanel
        {...props}
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        snapshot={snapshot}
        onLoadRepositoryDiff={vi.fn(async (repositoryPath: string, filePath?: string) => diff(repositoryPath, filePath))}
      />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "+ after" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    fireEvent.change(screen.getByPlaceholderText("What would you like to know?"), {
      target: { value: "Question for the first chat" },
    });

    for (const owner of [
      { projectId: "11111111-1111-4111-8111-111111111111", conversationId: "33333333-3333-4333-8333-333333333333" },
      { projectId: "44444444-4444-4444-8444-444444444444", conversationId: "33333333-3333-4333-8333-333333333333" },
    ]) {
      let finishLoad!: () => void;
      const pendingLoad = vi.fn((repositoryPath: string, filePath?: string) => new Promise<ReturnType<typeof diff>>((resolve) => {
        finishLoad = () => resolve(diff(repositoryPath, filePath));
      }));
      view.rerender(<WorkspaceChangesPanel
        {...props}
        {...owner}
        snapshot={snapshot}
        onLoadRepositoryDiff={pendingLoad}
      />);

      expect(pendingLoad).toHaveBeenCalledWith(".", "README.md");
      expect(screen.queryByRole("region", { name: "Diff content for README.md" }))
        .not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("What would you like to know?"))
        .not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Ask agent" })).not.toBeInTheDocument();

      await act(async () => finishLoad());
      expect(await screen.findByRole("region", { name: "Diff content for README.md" }))
        .toBeInTheDocument();
      expect(screen.queryByPlaceholderText("What would you like to know?"))
        .not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Ask about" })).not.toBeInTheDocument();
    }
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("labels copied, type-changed, and unknown repository files like the review list", async () => {
    const files = [
      { ...changedFile("copied.ts"), status: "copied" },
      { ...changedFile("link.ts"), status: "type-changed" },
      { ...changedFile("odd.ts"), status: "unknown" },
      { ...changedFile("new.ts"), status: "untracked", untracked: true },
    ];
    await act(async () => {
      render(<WorkspaceChangesPanel
        projectName="Inertia"
        snapshot={{ ...snapshot, repositories: [{ ...snapshot.repositories[0]!, files }] }}
        summary={null}
        onRefresh={vi.fn()}
        onLoadRepositoryDiff={async (repositoryPath, filePath) => ({
          repositoryPath, patch: patchFor(filePath!), files, truncated: false,
        })}
        onOpenWorkspaceFile={vi.fn()}
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
    const navigator = screen.getByRole("navigation", { name: "Git repositories and changed files" });
    expect([...navigator.querySelectorAll(".change-file-status")].map((node) => [
      node.textContent,
      node.getAttribute("title"),
    ])).toEqual([
      ["C", "Copied"],
      ["T", "Type changed"],
      ["?", "Unknown"],
      ["U", "Untracked"],
    ]);
    expect(screen.getByRole("combobox", { name: "Repository and changed file" }))
      .toHaveTextContent("C · copied.ts");
  });

  it("runs requested commit and push actions against the exact nested repository identity", async () => {
    const actionable = structuredClone(snapshot);
    actionable.repositories[0]!.authorityRef = "22222222-2222-4222-8222-222222222222";
    actionable.repositories[0]!.authorityRef =
      "22222222-2222-4222-8222-222222222222";
    const nested = actionable.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.upstream = "origin/feature/alpha";
    nested.ahead = 1;
    nested.hasRemote = true;
    nested.pullRequest = {
      available: true,
      remoteName: "origin",
      forge: "github",
      unavailableReason: null,
    };
    nested.authorityRef = "33333333-3333-4333-8333-333333333333";
    nested.files.push(changedFile("src/Other.java"));
    nested.insertions += 2;
    nested.deletions += 1;
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const pullRequestUrl = "https://github.com/example/alpha/pull/12";
    const openExternal = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openExternal },
    });
    const run = vi.fn(async (
      _key: string,
      command: { type: string },
    ): Promise<ServerEvent> => command.type === "git.pr.create"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "external.url",
            url: pullRequestUrl,
            label: "Open pull request",
          },
        }
      : {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
    const onRefresh = vi.fn();
    const onChangesRequestHandled = vi.fn();
    const patchFor = (path: string) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const onLoadRepositoryDiff = vi.fn(async (
      repositoryPath: string,
      filePath?: string,
      commitReview?: boolean,
    ) => {
      const files = filePath
        ? [changedFile(filePath)]
        : repositoryPath === "modules/alpha"
          ? nested.files
          : [];
      return {
        repositoryPath,
        patch: files.map(({ path }) => patchFor(path)).join("\n"),
        truncated: false,
        files,
        ...(commitReview ? { commitReview: reviewReceipt } : {}),
      };
    });
    const panel = (
      nextSnapshot: WorkspaceGitSnapshot,
      changesRequest?: {
        repositoryPath: string;
        action: "review" | "commit" | "push";
        revision: number;
      },
    ) => (
      <WorkspaceChangesPanel
        projectName="Inertia"
        projectId={projectId}
        conversationId={conversationId}
        snapshot={nextSnapshot}
        summary={null}
        onRefresh={onRefresh}
        run={run}
        onLoadRepositoryDiff={onLoadRepositoryDiff}
        onOpenWorkspaceFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
        changesRequest={changesRequest}
        onChangesRequestHandled={onChangesRequestHandled}
      />
    );
    const view = render(panel(actionable));

    const rootActions = screen.getByLabelText("Actions for Inertia");
    expect(within(rootActions).getByRole("button", { name: "Commit" }))
      .toBeEnabled();

    view.rerender(panel(actionable, {
      repositoryPath: "modules/alpha",
      action: "commit",
      revision: 1,
    }));
    const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
    expect(screen.getByRole("combobox", { name: "Repository scope" }))
      .toHaveValue("modules/alpha");
    expect(onChangesRequestHandled).toHaveBeenCalledWith(1);
    expect(await within(dialog).findByText("2 selected hunks are unreviewed."))
      .toBeInTheDocument();
    expect(onLoadRepositoryDiff).toHaveBeenCalledWith(
      "modules/alpha",
      undefined,
      true,
    );
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Commit message" }), {
      target: { value: "Commit nested work" },
    });
    await waitFor(() => expect(
      within(dialog).getByRole("button", { name: "Commit" }),
    ).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(run).toHaveBeenCalledWith("git.commit", {
      type: "git.commit",
      payload: {
        projectId,
        conversationId,
        repositoryPath: "modules/alpha",
        authorityRef: nested.authorityRef,
        message: "Commit nested work",
        paths: ["src/Main.java", "src/Other.java"],
        reviewReceipt,
      },
    }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));

    const pushed = structuredClone(actionable);
    const pushedNested = pushed.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    pushedNested.files = [];
    pushedNested.clean = true;
    pushedNested.insertions = 0;
    pushedNested.deletions = 0;
    view.rerender(panel(pushed, {
      repositoryPath: "modules/alpha",
      action: "push",
      revision: 2,
    }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("git.push", {
      type: "git.push",
      payload: {
        projectId,
        conversationId,
        repositoryPath: "modules/alpha",
        authorityRef: nested.authorityRef,
      },
    }));
    expect(onChangesRequestHandled).toHaveBeenCalledWith(2);

    const behind = structuredClone(pushed);
    const behindNested = behind.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    behindNested.ahead = 0;
    behindNested.behind = 1;
    view.rerender(panel(behind));
    fireEvent.click(within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).getByRole("button", { name: "Pull 1" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("git.pull", {
      type: "git.pull",
      payload: {
        projectId,
        conversationId,
        repositoryPath: "modules/alpha",
        authorityRef: nested.authorityRef,
      },
    }));

    const synchronized = structuredClone(behind);
    synchronized.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!.behind = 0;
    view.rerender(panel(synchronized));
    fireEvent.click(await within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).findByRole("button", { name: "PR" }));
    const pullRequestDialog = await screen.findByRole("dialog", {
      name: "Create GitHub pull request",
    });
    fireEvent.click(within(pullRequestDialog).getByRole("button", {
      name: "Create pull request",
    }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("git.pr.create", {
      type: "git.pr.create",
      payload: {
        projectId,
        conversationId,
        repositoryPath: "modules/alpha",
        authorityRef: nested.authorityRef,
        title: "feature/alpha",
        body: "",
        draft: true,
      },
    }));
    expect(openExternal).toHaveBeenCalledWith(pullRequestUrl);
  });

  it("closes a nested commit review when the same-path repository authority changes", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.authorityRef = "33333333-3333-4333-8333-333333333333";
    const projectId = crypto.randomUUID();
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const props = {
      projectName: "Inertia",
      projectId,
      snapshot: initial,
      summary: null,
      onRefresh: vi.fn(),
      run,
      onLoadRepositoryDiff: vi.fn(async (
        repositoryPath: string,
        filePath?: string,
      ) => ({
        repositoryPath,
        patch: [
          `diff --git a/${filePath ?? "src/Main.java"} b/${filePath ?? "src/Main.java"}`,
          `--- a/${filePath ?? "src/Main.java"}`,
          `+++ b/${filePath ?? "src/Main.java"}`,
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
        truncated: false as const,
        files: [changedFile(filePath ?? "src/Main.java")],
      })),
      onOpenWorkspaceFile: vi.fn(),
      onAsk: vi.fn(async () => undefined),
      onRequestRevision: vi.fn(async () => undefined),
      onRevert: vi.fn(async () => undefined),
      onSetReviewState: vi.fn(async () => undefined),
      onCreateNote: vi.fn(async () => undefined),
      onUpdateNote: vi.fn(async () => undefined),
      onDeleteNote: vi.fn(async () => undefined),
      onAddTextToPrompt: vi.fn(),
      onAddToPrompt: vi.fn(),
    };
    const view = render(<WorkspaceChangesPanel {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).getByRole("button", { name: "Commit" }));
    expect(await screen.findByRole("dialog", { name: "Commit changes" }))
      .toBeInTheDocument();

    const replaced = structuredClone(initial);
    const replacedNested = replaced.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    replacedNested.authorityRef = "44444444-4444-4444-8444-444444444444";
    replacedNested.files.push(changedFile("src/New.java"));
    view.rerender(<WorkspaceChangesPanel {...props} snapshot={replaced} />);

    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Commit changes",
    })).not.toBeInTheDocument());
    expect(run).not.toHaveBeenCalled();
  });

  it("closes a nested review after commit failure so its one-shot receipt cannot be retried", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.authorityRef = reviewReceipt.authorityRef;
    const run = vi.fn(async (): Promise<ServerEvent> => {
      throw new Error("The reviewed repository changed.");
    });
    render(
      <WorkspaceChangesPanel
        projectName="Inertia"
        projectId={crypto.randomUUID()}
        snapshot={initial}
        summary={null}
        onRefresh={vi.fn()}
        run={run}
        onLoadRepositoryDiff={vi.fn(async (
          repositoryPath: string,
          filePath?: string,
          commitReview?: boolean,
        ) => ({
          repositoryPath,
          patch: patchFor(filePath ?? "src/Main.java"),
          truncated: false as const,
          files: [changedFile(filePath ?? "src/Main.java")],
          ...(commitReview ? { commitReview: reviewReceipt } : {}),
        }))}
        onOpenWorkspaceFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).getByRole("button", { name: "Commit" }));
    const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
    const message = within(dialog).getByRole("textbox", { name: "Commit message" });
    fireEvent.change(message, { target: { value: "Attempt once" } });
    await waitFor(() => expect(within(dialog).getByRole("button", {
      name: "Commit",
    })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Commit changes",
    })).not.toBeInTheDocument());
    expect(run).toHaveBeenCalledOnce();
  });

  it("surfaces nested commit-and-push partial success and cannot commit twice", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.authorityRef = reviewReceipt.authorityRef;
    nested.upstream = "origin/feature/alpha";
    nested.hasRemote = true;
    const onActionError = vi.fn();
    const run = vi.fn(async (
      _key: string,
      command: { type: string },
    ): Promise<ServerEvent> => {
      if (command.type === "git.push") throw new Error("remote rejected push");
      return { type: "request.ok", requestId: crypto.randomUUID() };
    });
    render(
      <WorkspaceChangesPanel
        projectName="Inertia"
        projectId={crypto.randomUUID()}
        snapshot={initial}
        summary={null}
        onRefresh={vi.fn()}
        run={run}
        onActionError={onActionError}
        onLoadRepositoryDiff={vi.fn(async (
          repositoryPath: string,
          filePath?: string,
          commitReview?: boolean,
        ) => ({
          repositoryPath,
          patch: patchFor(filePath ?? "src/Main.java"),
          truncated: false as const,
          files: [changedFile(filePath ?? "src/Main.java")],
          ...(commitReview ? { commitReview: reviewReceipt } : {}),
        }))}
        onOpenWorkspaceFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).getByRole("button", { name: "Commit" }));
    const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
    fireEvent.change(within(dialog).getByRole("textbox", {
      name: "Commit message",
    }), { target: { value: "Commit then push" } });
    await waitFor(() => expect(within(dialog).getByRole("button", {
      name: "Commit & push",
    })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit & push" }));

    await waitFor(() => expect(onActionError).toHaveBeenCalledWith(
      "The commit was created, but push failed. Refresh the repository before retrying the push.",
    ));
    expect(screen.queryByRole("dialog", { name: "Commit changes" }))
      .not.toBeInTheDocument();
    expect(run.mock.calls.filter(([, command]) => command.type === "git.commit"))
      .toHaveLength(1);
  });

  it("does not allow a commit when the complete repository diff is truncated", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.authorityRef = "33333333-3333-4333-8333-333333333333";
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    render(
      <WorkspaceChangesPanel
        projectName="Inertia"
        projectId={crypto.randomUUID()}
        snapshot={initial}
        summary={null}
        onRefresh={vi.fn()}
        run={run}
        onLoadRepositoryDiff={vi.fn(async (
          repositoryPath: string,
          filePath?: string,
        ) => ({
          repositoryPath,
          patch: [
            `diff --git a/${filePath ?? "src/Main.java"} b/${filePath ?? "src/Main.java"}`,
            `--- a/${filePath ?? "src/Main.java"}`,
            `+++ b/${filePath ?? "src/Main.java"}`,
            "@@ -1 +1 @@",
            "-before",
            "+after",
            "",
          ].join("\n"),
          truncated: filePath === undefined,
          files: [changedFile(filePath ?? "src/Main.java")],
        }))}
        onOpenWorkspaceFile={vi.fn()}
        onAsk={vi.fn(async () => undefined)}
        onRequestRevision={vi.fn(async () => undefined)}
        onRevert={vi.fn(async () => undefined)}
        onSetReviewState={vi.fn(async () => undefined)}
        onCreateNote={vi.fn(async () => undefined)}
        onUpdateNote={vi.fn(async () => undefined)}
        onDeleteNote={vi.fn(async () => undefined)}
        onAddTextToPrompt={vi.fn()}
        onAddToPrompt={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).getByRole("button", { name: "Commit" }));
    const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The complete repository diff was truncated. Refresh this repository and try again before committing.",
    );
    const message = within(dialog).getByRole("textbox", {
      name: "Commit message",
    });
    fireEvent.change(message, { target: { value: "Must not commit" } });
    expect(within(dialog).getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Commit & push" })).toBeDisabled();
    fireEvent.keyDown(message, { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves a verified pull request recovery link across same-repository refreshes", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.upstream = "origin/feature/alpha";
    nested.hasRemote = true;
    nested.pullRequest = {
      available: true,
      remoteName: "origin",
      forge: "github",
      unavailableReason: null,
    };
    nested.authorityRef = "33333333-3333-4333-8333-333333333333";
    const projectId = crypto.randomUUID();
    const pullRequestUrl = "https://github.com/example/alpha/pull/12";
    const openExternal = vi.fn(async () => {
      throw new Error("The browser could not be opened.");
    });
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openExternal },
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "external.url",
        url: pullRequestUrl,
        label: "Open pull request",
      },
    }));
    const props = {
      projectName: "Inertia",
      projectId,
      snapshot: initial,
      summary: null,
      onRefresh: vi.fn(),
      run,
      onLoadRepositoryDiff: vi.fn(async (
        repositoryPath: string,
        filePath?: string,
      ) => ({
        repositoryPath,
        patch: "",
        truncated: false as const,
        files: filePath ? [changedFile(filePath)] : [],
      })),
      onOpenWorkspaceFile: vi.fn(),
      onAsk: vi.fn(async () => undefined),
      onRequestRevision: vi.fn(async () => undefined),
      onRevert: vi.fn(async () => undefined),
      onSetReviewState: vi.fn(async () => undefined),
      onCreateNote: vi.fn(async () => undefined),
      onUpdateNote: vi.fn(async () => undefined),
      onDeleteNote: vi.fn(async () => undefined),
      onAddTextToPrompt: vi.fn(),
      onAddToPrompt: vi.fn(),
    };
    const view = render(<WorkspaceChangesPanel {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(await within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).findByRole("button", { name: "PR" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Create GitHub pull request",
    });
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create pull request",
    }));

    expect(await within(dialog).findByRole("textbox", {
      name: "Created pull request link",
    })).toHaveValue(pullRequestUrl);
    expect(run).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(pullRequestUrl);

    const refreshed = structuredClone(initial);
    refreshed.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!.authorityRef = "44444444-4444-4444-8444-444444444444";
    view.rerender(<WorkspaceChangesPanel {...props} snapshot={refreshed} />);

    const preservedDialog = await screen.findByRole("dialog", {
      name: "Create GitHub pull request",
    });
    expect(within(preservedDialog).getByRole("textbox", {
      name: "Created pull request link",
    })).toHaveValue(pullRequestUrl);
    expect(within(preservedDialog).queryByRole("button", {
      name: "Create pull request",
    })).not.toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("submits an open pull request draft only with its opening repository authority", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.upstream = "origin/feature/alpha";
    nested.hasRemote = true;
    nested.pullRequest = {
      available: true,
      remoteName: "origin",
      forge: "github",
      unavailableReason: null,
    };
    const openingAuthority = "33333333-3333-4333-8333-333333333333";
    nested.authorityRef = openingAuthority;
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const props = {
      projectName: "Inertia",
      projectId,
      conversationId,
      snapshot: initial,
      summary: null,
      onRefresh: vi.fn(),
      run,
      onLoadRepositoryDiff: vi.fn(async (
        repositoryPath: string,
        filePath?: string,
      ) => ({
        repositoryPath,
        patch: "",
        truncated: false as const,
        files: filePath ? [changedFile(filePath)] : [],
      })),
      onOpenWorkspaceFile: vi.fn(),
      onAsk: vi.fn(async () => undefined),
      onRequestRevision: vi.fn(async () => undefined),
      onRevert: vi.fn(async () => undefined),
      onSetReviewState: vi.fn(async () => undefined),
      onCreateNote: vi.fn(async () => undefined),
      onUpdateNote: vi.fn(async () => undefined),
      onDeleteNote: vi.fn(async () => undefined),
      onAddTextToPrompt: vi.fn(),
      onAddToPrompt: vi.fn(),
    };
    const view = render(<WorkspaceChangesPanel {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(await within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).findByRole("button", { name: "PR" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Create GitHub pull request",
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), {
      target: { value: "Draft bound to opening authority" },
    });

    const refreshed = structuredClone(initial);
    refreshed.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!.authorityRef = "44444444-4444-4444-8444-444444444444";
    view.rerender(<WorkspaceChangesPanel {...props} snapshot={refreshed} />);
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Create pull request",
    }));

    await waitFor(() => expect(run).toHaveBeenCalledWith("git.pr.create", {
      type: "git.pr.create",
      payload: {
        projectId,
        conversationId,
        repositoryPath: "modules/alpha",
        authorityRef: openingAuthority,
        title: "Draft bound to opening authority",
        body: "",
        draft: true,
      },
    }));
  });

  it("closes edited pull request state when the conversation identity changes", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.upstream = "origin/feature/alpha";
    nested.hasRemote = true;
    nested.pullRequest = {
      available: true,
      remoteName: "origin",
      forge: "github",
      unavailableReason: null,
    };
    nested.authorityRef = "33333333-3333-4333-8333-333333333333";
    const props = {
      projectName: "Inertia",
      projectId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      snapshot: initial,
      summary: null,
      onRefresh: vi.fn(),
      run: vi.fn(async (): Promise<ServerEvent> => ({
        type: "request.ok",
        requestId: crypto.randomUUID(),
      })),
      onLoadRepositoryDiff: vi.fn(async (
        repositoryPath: string,
        filePath?: string,
      ) => ({
        repositoryPath,
        patch: "",
        truncated: false as const,
        files: filePath ? [changedFile(filePath)] : [],
      })),
      onOpenWorkspaceFile: vi.fn(),
      onAsk: vi.fn(async () => undefined),
      onRequestRevision: vi.fn(async () => undefined),
      onRevert: vi.fn(async () => undefined),
      onSetReviewState: vi.fn(async () => undefined),
      onCreateNote: vi.fn(async () => undefined),
      onUpdateNote: vi.fn(async () => undefined),
      onDeleteNote: vi.fn(async () => undefined),
      onAddTextToPrompt: vi.fn(),
      onAddToPrompt: vi.fn(),
    };
    const view = render(<WorkspaceChangesPanel {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(await within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).findByRole("button", { name: "PR" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Create GitHub pull request",
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), {
      target: { value: "Stale title from the prior conversation" },
    });

    view.rerender(<WorkspaceChangesPanel
      {...props}
      conversationId={crypto.randomUUID()}
    />);

    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Create GitHub pull request",
    })).not.toBeInTheDocument());
    expect(props.run).not.toHaveBeenCalled();
  });

  it("closes a pull request dialog when the same-path branch changes", async () => {
    const initial = structuredClone(snapshot);
    const nested = initial.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    nested.upstream = "origin/feature/alpha";
    nested.hasRemote = true;
    nested.pullRequest = {
      available: true,
      remoteName: "origin",
      forge: "github",
      unavailableReason: null,
    };
    nested.authorityRef = "33333333-3333-4333-8333-333333333333";
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const props = {
      projectName: "Inertia",
      projectId: crypto.randomUUID(),
      snapshot: initial,
      summary: null,
      onRefresh: vi.fn(),
      run,
      onLoadRepositoryDiff: vi.fn(async (
        repositoryPath: string,
        filePath?: string,
      ) => ({
        repositoryPath,
        patch: "",
        truncated: false as const,
        files: filePath ? [changedFile(filePath)] : [],
      })),
      onOpenWorkspaceFile: vi.fn(),
      onAsk: vi.fn(async () => undefined),
      onRequestRevision: vi.fn(async () => undefined),
      onRevert: vi.fn(async () => undefined),
      onSetReviewState: vi.fn(async () => undefined),
      onCreateNote: vi.fn(async () => undefined),
      onUpdateNote: vi.fn(async () => undefined),
      onDeleteNote: vi.fn(async () => undefined),
      onAddTextToPrompt: vi.fn(),
      onAddToPrompt: vi.fn(),
    };
    const view = render(<WorkspaceChangesPanel {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "modules/alpha" },
    });
    fireEvent.click(await within(await screen.findByLabelText(
      "Actions for modules/alpha",
    )).findByRole("button", { name: "PR" }));
    expect(await screen.findByRole("dialog", {
      name: "Create GitHub pull request",
    })).toBeInTheDocument();

    const changedBranch = structuredClone(initial);
    const changedNested = changedBranch.repositories.find(
      ({ repositoryPath }) => repositoryPath === "modules/alpha",
    )!;
    changedNested.branch = "feature/replacement";
    changedNested.upstream = "origin/feature/replacement";
    changedNested.authorityRef = "44444444-4444-4444-8444-444444444444";
    view.rerender(<WorkspaceChangesPanel {...props} snapshot={changedBranch} />);

    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Create GitHub pull request",
    })).not.toBeInTheDocument());
    expect(run).not.toHaveBeenCalled();
  });
});

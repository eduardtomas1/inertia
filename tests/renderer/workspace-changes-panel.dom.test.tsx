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

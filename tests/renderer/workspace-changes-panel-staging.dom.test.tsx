import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  WorkspaceChangesPanel,
  type WorkspaceChangesPanelProps,
} from "../../src/renderer/src/components/WorkspaceChangesPanel";
import type { ContextMenuAction, ContextMenuRequest } from "../../src/shared/context-menu";
import type { ChangedFile, ServerEvent, WorkspaceGitSnapshot } from "../../src/shared/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const rootAuthority = "33333333-3333-4333-8333-333333333333";
const nestedAuthority = "44444444-4444-4444-8444-444444444444";

type Run = NonNullable<WorkspaceChangesPanelProps["run"]>;

const bridge = {
  showContextMenu: vi.fn<(request: ContextMenuRequest) => Promise<ContextMenuAction | null>>(),
  openProjectPath: vi.fn(async () => ""),
};

beforeEach(() => {
  vi.clearAllMocks();
  bridge.showContextMenu.mockResolvedValue(null);
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
});

afterEach(cleanup);

function fileRow(name: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>("button.workspace-repository-file")]
    .find((candidate) => candidate.querySelector("strong")?.textContent === name);
  if (!row) throw new Error(`Missing changed-file row ${name}`);
  return row;
}

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: "modified",
    insertions: 1,
    deletions: 1,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: ".",
    worktreeStatus: "M",
    ...overrides,
  };
}

function repository(repositoryPath: string, files: ChangedFile[], authorityRef: string | null) {
  return {
    repositoryPath,
    state: "ready" as const,
    error: null,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    authorityRef,
    files,
    insertions: files.length,
    deletions: files.length,
    clean: files.length === 0,
    truncated: false,
  };
}

function snapshot(rootFiles: ChangedFile[], options: { authorityRef?: string | null; nested?: ChangedFile[] } = {}): WorkspaceGitSnapshot {
  const repositories = [
    repository(".", rootFiles, options.authorityRef === undefined ? rootAuthority : options.authorityRef),
    ...(options.nested ? [repository("modules/alpha", options.nested, nestedAuthority)] : []),
  ];
  return {
    repositories,
    files: repositories.reduce((total, entry) => total + entry.files.length, 0),
    insertions: 0,
    deletions: 0,
    scannedDirectories: 1,
    skippedDirectories: 0,
    discoveredRepositories: repositories.length,
    repositoryLimit: 64,
    partial: false,
    truncated: false,
    issues: [],
  };
}

function renderPanel(current: WorkspaceGitSnapshot, options: {
  busyAction?: string | null;
  run?: Mock<Run>;
} = {}) {
  const run = options.run ?? vi.fn<Run>(async () => ({
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: { kind: "git.action", message: "ok" },
  }));
  const onRefresh = vi.fn();
  const view = render(
    <WorkspaceChangesPanel
      projectName="Inertia"
      projectId={projectId}
      conversationId={conversationId}
      projectRoot="/work/inertia"
      snapshot={current}
      summary={null}
      busyAction={options.busyAction ?? null}
      run={run}
      onRefresh={onRefresh}
      onLoadRepositoryDiff={async (repositoryPath) => ({ repositoryPath, patch: "", files: [], truncated: false })}
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
  return { run, onRefresh, view };
}

function payload(type: "git.stage" | "git.unstage", paths: string[], repositoryPath = ".", authorityRef = rootAuthority) {
  return {
    type,
    payload: { projectId, conversationId, repositoryPath, authorityRef, paths },
  };
}

const files = [
  file("src/staged.ts", { staged: true, unstaged: false, indexStatus: "M", worktreeStatus: "." }),
  file("src/both.ts", { staged: true, unstaged: true, indexStatus: "M", worktreeStatus: "M" }),
  file("src/working.ts"),
  file("src/new.ts", { status: "untracked", untracked: true, indexStatus: "?", worktreeStatus: "?" }),
  file("src/conflict.ts", { status: "unmerged", staged: true, unstaged: true, indexStatus: "U", worktreeStatus: "U" }),
];

describe("WorkspaceChangesPanel staging", () => {
  it("stages and unstages one file from its row and refreshes afterwards", async () => {
    const { run, onRefresh } = renderPanel(snapshot(files));
    const list = screen.getByRole("navigation", { name: "Git repositories and changed files" });

    fireEvent.click(within(list).getByRole("button", { name: "Stage src/working.ts in Inertia" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledExactlyOnceWith("git.stage", payload("git.stage", ["src/working.ts"]));

    fireEvent.click(within(list).getByRole("button", { name: "Unstage src/staged.ts in Inertia" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith("git.unstage", payload("git.unstage", ["src/staged.ts"]));

    expect(within(list).getByRole("button", { name: "Stage src/both.ts in Inertia" })).toBeEnabled();
    expect(within(list).queryByRole("button", { name: /Stage src\/conflict\.ts/u })).toBeNull();
  });

  it("places Stage/Unstage beside Open in one row-actions cluster", () => {
    renderPanel(snapshot(files));
    // Happy DOM cannot measure CSS layout, so assert the structure the
    // stylesheet relies on: only `.workspace-repository-row-actions` is
    // absolutely positioned and lays its buttons out side by side (index
    // action first, Open last), so the two never share one position.
    for (const [name, action] of [["working.ts", "Stage src/working.ts in Inertia"], ["staged.ts", "Unstage src/staged.ts in Inertia"]]) {
      const row = fileRow(name).closest("li")!;
      const cluster = row.querySelector(":scope > .workspace-repository-row-actions");
      expect(cluster).not.toBeNull();
      const buttons = [...cluster!.querySelectorAll("button")];
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        action,
        `Open src/${name} from Inertia`,
      ]);
      expect(buttons[0]).toHaveClass("icon-button", "workspace-repository-index-action");
      expect(buttons[1]).not.toHaveClass("workspace-repository-index-action");
      expect(row.querySelectorAll(":scope > .icon-button")).toHaveLength(0);
    }
  });

  it("applies group header actions to every stageable or unstageable file", async () => {
    const { run, onRefresh } = renderPanel(snapshot(files));

    fireEvent.click(screen.getByRole("button", { name: "Stage all 3 changed files in Inertia" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(run).toHaveBeenLastCalledWith(
      "git.stage",
      payload("git.stage", ["src/both.ts", "src/working.ts", "src/new.ts"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Unstage all 2 staged files in Inertia" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(
      "git.unstage",
      payload("git.unstage", ["src/staged.ts", "src/both.ts"]),
    );
  });

  it("splits a large Stage all into 200-path requests", async () => {
    const many = Array.from({ length: 450 }, (_, index) => file(`f/${index}.ts`));
    const { run, onRefresh } = renderPanel(snapshot(many));

    fireEvent.click(screen.getByRole("button", { name: "Stage all 450 changed files in Inertia" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(run.mock.calls.map(([, command]) => (command as { payload: { paths: string[] } }).payload.paths.length))
      .toEqual([200, 200, 50]);
  });

  it("offers Stage and Unstage in the changed-file context menu", async () => {
    const { run, onRefresh } = renderPanel(snapshot(files));
    const row = fileRow("both.ts");

    bridge.showContextMenu.mockResolvedValueOnce("git-unstage");
    fireEvent.contextMenu(row, { clientX: 5, clientY: 9 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(bridge.showContextMenu.mock.calls.at(-1)![0]).toMatchObject({
      kind: "diff-file",
      relativePath: "src/both.ts",
      stageable: true,
      unstageable: true,
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledExactlyOnceWith("git.unstage", payload("git.unstage", ["src/both.ts"]));

    fireEvent.contextMenu(fileRow("working.ts"), { clientX: 5, clientY: 9 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const request = bridge.showContextMenu.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ stageable: true });
    expect(request).not.toHaveProperty("unstageable");
  });

  it("targets the selected nested repository with its own authority", async () => {
    const { run } = renderPanel(snapshot([], { nested: [file("src/Main.java")] }));

    fireEvent.click(screen.getByRole("button", { name: "Stage src/Main.java in modules/alpha" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith(
      "git.stage",
      payload("git.stage", ["src/Main.java"], "modules/alpha", nestedAuthority),
    );
  });

  it("disables index actions while another Git action runs and hides them without authority", () => {
    const busy = renderPanel(snapshot(files), { busyAction: "git.push" });
    expect(screen.getByRole("button", { name: "Stage src/working.ts in Inertia" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stage all 3 changed files in Inertia" })).toBeDisabled();
    busy.view.unmount();

    renderPanel(snapshot(files, { authorityRef: null }));
    expect(screen.queryByRole("button", { name: /^Stage /u })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unstage /u })).toBeNull();
  });

  it("ignores a second click while a staging request is in flight", async () => {
    let finish!: () => void;
    const run = vi.fn<Run>(() => new Promise<ServerEvent>((resolve) => {
      finish = () => resolve({ type: "request.ok", requestId: crypto.randomUUID() });
    }));
    const { onRefresh } = renderPanel(snapshot(files), { run });
    const stage = screen.getByRole("button", { name: "Stage src/working.ts in Inertia" });

    fireEvent.click(stage);
    fireEvent.click(stage);
    expect(run).toHaveBeenCalledOnce();
    await waitFor(() => expect(stage).toBeDisabled());
    await act(async () => { finish(); });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });
});

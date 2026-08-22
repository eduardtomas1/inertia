import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  Project,
  ProjectAction,
  ServerEvent,
  WorkspaceRun,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { useActivityActions } from "../../src/renderer/src/hooks/useActivityActions";
import { useDesktopTools } from "../../src/renderer/src/hooks/useDesktopTools";
import { useWorkspaceTools } from "../../src/renderer/src/hooks/useWorkspaceTools";
import { CommitDialog } from "../../src/renderer/src/components/CommitDialog";
import { openWorkspaceEntry } from "../../src/renderer/src/hooks/workspace-tools/openWorkspaceEntry";
import {
  useWorkspaceFiles,
} from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceFiles";
import {
  useWorkspaceGit,
} from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceGit";
import {
  useWorkspaceReview,
} from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceReview";
import type {
  CommandWithoutId,
} from "../../src/renderer/src/lib/runtimeCommands";
import { markWorkspaceFileSearchEdit } from "../../src/renderer/src/utils/workspaceFileReference";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/${name.toLowerCase()}`,
    normalizedPath: `/${name.toLowerCase()}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#5555ff",
    status: "ready",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  };
}

function conversation(id: string, owner: Project): Conversation {
  return {
    id,
    projectId: owner.id,
    title: `${owner.name} chat`,
    providerId: "codex",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    model: "default",
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  };
}

function result(
  value: Extract<ServerEvent, { type: "request.result" }>["result"],
): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: value,
  };
}

const noopSubscribe = (_listener: (event: ServerEvent) => void) =>
  () => undefined;

const alpha = project("11111111-1111-4111-8111-111111111111", "Alpha");
const beta = project("22222222-2222-4222-8222-222222222222", "Beta");
const alphaChat = conversation(
  "33333333-3333-4333-8333-333333333333",
  alpha,
);
const betaChat = conversation(
  "44444444-4444-4444-8444-444444444444",
  beta,
);

function deferredWorkspaceGitRequests() {
  const statusResolvers: Array<(event: ServerEvent) => void> = [];
  const workspaceResolvers: Array<(event: ServerEvent) => void> = [];
  const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "git.refresh") {
      return new Promise((resolve) => statusResolvers.push(resolve));
    }
    if (command.type === "git.workspace.refresh") {
      return new Promise((resolve) => workspaceResolvers.push(resolve));
    }
    return Promise.reject(new Error("Unexpected command"));
  });
  return {
    request,
    settle(index: number, root: string) {
      statusResolvers[index]?.(result({
        kind: "git.status",
        status: {
          isRepository: false,
          root,
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
        },
      }));
      workspaceResolvers[index]?.(result({
        kind: "git.workspace.status",
        status: {
          repositories: [],
          files: 0,
          insertions: 0,
          deletions: 0,
          scannedDirectories: index + 1,
          skippedDirectories: 0,
          discoveredRepositories: 0,
          repositoryLimit: 64,
          partial: false,
          truncated: false,
          issues: [],
        },
      }));
    },
  };
}

describe("workspace pane authority", () => {
  it("consumes Environment repository action requests only at the handled revision", () => {
    const request = vi.fn(async (_command: CommandWithoutId): Promise<ServerEvent> => result({
      kind: "git.status",
      status: {
        isRepository: false,
        root: null,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [],
        insertions: 0,
        deletions: 0,
      },
    }));
    const hook = renderHook(() => useWorkspaceGit({
      enabled: false,
      loadStatusOnMount: false,
      loadWorkspaceOnMount: false,
      project: alpha,
      conversation: alphaChat,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run: async (_key, command) => await request(command),
      subscribe: noopSubscribe,
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.requestWorkspaceChanges(
      "modules/alpha",
      "commit",
    ));
    expect(hook.result.current.changesRequest).toMatchObject({
      repositoryPath: "modules/alpha",
      action: "commit",
      revision: 1,
    });

    act(() => hook.result.current.requestWorkspaceChanges(
      "modules/alpha",
      "push",
    ));
    act(() => hook.result.current.clearWorkspaceChangesRequest(1));
    expect(hook.result.current.changesRequest).toMatchObject({
      action: "push",
      revision: 2,
    });

    act(() => hook.result.current.clearWorkspaceChangesRequest(2));
    expect(hook.result.current.changesRequest).toBeNull();

    act(() => hook.result.current.requestWorkspaceChanges(
      "modules/alpha",
      "commit",
    ));
    expect(hook.result.current.changesRequest).toMatchObject({
      action: "commit",
      revision: 3,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps ordinary complete Changes diffs reviewable without a commit receipt", () => {
    const review = renderHook(() => useWorkspaceReview({
      project: alpha,
      conversation: alphaChat,
      detail: null,
      gitDiff: {
        patch: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
        truncated: false,
        files: [],
      },
      ignoreWhitespace: true,
      confirmDestructiveActions: false,
      request: vi.fn(),
      run: vi.fn(),
      setGitDiff: vi.fn(),
    }));

    expect(review.result.current.structuredDiffError).toBeNull();
    expect(review.result.current.structuredDiff.files).toHaveLength(1);
  });

  it("cancels only the active selection question for the viewed thread", async () => {
    const request = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const review = renderHook(() => useWorkspaceReview({
      project: alpha,
      conversation: alphaChat,
      detail: null,
      gitDiff: null,
      ignoreWhitespace: false,
      confirmDestructiveActions: false,
      request,
      run: vi.fn(),
      setGitDiff: vi.fn(),
    }));

    await act(async () => review.result.current.cancelDiffQuestion());

    expect(request).toHaveBeenCalledWith({
      type: "review.selection.cancel",
      payload: { conversationId: alphaChat.id },
    });
  });

  it("tracks concurrent selection questions under their initiating pane authority", async () => {
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const structured = parseUnifiedDiff(patch);
    const file = structured.files[0]!;
    const hunk = file.hunks[0]!;
    const selectedLine = hunk.lines.find(({ kind }) => kind === "addition")!;
    const selection = {
      fingerprint: structured.fingerprint,
      file,
      hunk,
      lineIds: [selectedLine.id],
      reference: file.path,
      repositoryPath: ".",
    };
    const pending: Array<{
      resolve: (event: ServerEvent) => void;
      reject: (error: Error) => void;
    }> = [];
    const run = vi.fn(() => new Promise<ServerEvent>((resolve, reject) => {
      pending.push({ resolve, reject });
    }));
    const review = renderHook((owner: {
      project: Project;
      conversation: Conversation;
    }) => useWorkspaceReview({
      ...owner,
      detail: null,
      gitDiff: { patch, truncated: false, files: [] },
      ignoreWhitespace: false,
      confirmDestructiveActions: false,
      request: vi.fn(),
      run,
      setGitDiff: vi.fn(),
    }), {
      initialProps: { project: alpha, conversation: alphaChat },
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = review.result.current.askAboutDiff(selection, "first");
      second = review.result.current.askAboutDiff(selection, "second");
    });
    await waitFor(() => {
      expect(review.result.current.selectionQuestionRunning).toBe(true);
      expect(pending).toHaveLength(2);
    });

    review.rerender({ project: beta, conversation: betaChat });
    expect(review.result.current.selectionQuestionRunning).toBe(false);
    review.rerender({ project: alpha, conversation: alphaChat });
    expect(review.result.current.selectionQuestionRunning).toBe(true);

    await act(async () => {
      pending[0]!.resolve({
        type: "request.ok",
        requestId: crypto.randomUUID(),
      });
      await first;
    });
    expect(review.result.current.selectionQuestionRunning).toBe(true);

    await act(async () => {
      pending[1]!.reject(new Error("Provider disconnected"));
      await expect(second).rejects.toThrow("Provider disconnected");
    });
    expect(review.result.current.selectionQuestionRunning).toBe(false);
  });

  it("blocks root commit clicks and Enter when the complete diff is truncated", () => {
    const review = renderHook(() => useWorkspaceReview({
      project: alpha,
      conversation: alphaChat,
      detail: null,
      gitDiff: {
        patch: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
        truncated: true,
        files: [],
      },
      ignoreWhitespace: false,
      confirmDestructiveActions: false,
      request: vi.fn(),
      run: vi.fn(),
      setGitDiff: vi.fn(),
    }));
    const onCommit = vi.fn(async () => undefined);
    render(
      <CommitDialog
        open
        repositoryPath="."
        status={{
          isRepository: true,
          root: "/workspace/inertia",
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [{
            path: "src/app.ts",
            status: "modified",
            insertions: 1,
            deletions: 1,
            untracked: false,
            staged: false,
            unstaged: true,
            indexStatus: ".",
            worktreeStatus: "M",
          }],
          insertions: 1,
          deletions: 1,
        }}
        diff={review.result.current.structuredDiff}
        diffParsing={review.result.current.structuredDiffParsing}
        diffError={review.result.current.structuredDiffError}
        reviewStates={[]}
        busy={false}
        onClose={vi.fn()}
        onCommit={onCommit}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Diff truncated. Refresh before committing.",
    );
    const message = screen.getByRole("textbox", { name: "Commit message" });
    fireEvent.change(message, { target: { value: "Must not commit" } });
    const commit = screen.getByRole("button", { name: "Commit" });
    const commitAndPush = screen.getByRole("button", { name: "Commit & push" });
    expect(commit).toBeDisabled();
    expect(commitAndPush).toBeDisabled();
    fireEvent.click(commit);
    fireEvent.click(commitAndPush);
    fireEvent.keyDown(message, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("routes actual directories to reveal and files to the internal preview", async () => {
    const openDirectory = vi.fn(async () => undefined);
    const openFile = vi.fn();
    const inspectDirectory = vi.fn(async (path: string) => {
      if (path === "README") throw new Error("not a directory");
    });

    await expect(openWorkspaceEntry("docs", {
      inspectDirectory,
      openDirectory,
      openFile,
    })).resolves.toBe("directory");
    await expect(openWorkspaceEntry("README", {
      inspectDirectory,
      openDirectory,
      openFile,
    })).resolves.toBe("file");

    expect(openDirectory).toHaveBeenCalledWith("docs");
    expect(openFile).toHaveBeenCalledWith("README", undefined, undefined);
  });

  it("does not finish opening a file after its workspace owner changes", async () => {
    let rejectInspection: ((reason?: unknown) => void) | undefined;
    let current = true;
    const openDirectory = vi.fn(async () => undefined);
    const openFile = vi.fn();
    const pending = openWorkspaceEntry("src/secret.ts:12", {
      inspectDirectory: () => new Promise((_resolve, reject) => {
        rejectInspection = reject;
      }),
      openDirectory,
      openFile,
      isCurrent: () => current,
    }, { startLine: 12, endLine: 12 });

    current = false;
    rejectInspection?.(new Error("not a directory"));

    await expect(pending).resolves.toBe("stale");
    expect(openDirectory).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("cancels an older external file open when probes settle out of order", async () => {
    const inspectionRejectors = new Map<string, (reason?: unknown) => void>();
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "workspace.entries") {
        return new Promise((_resolve, reject) => {
          inspectionRejectors.set(command.payload.directory ?? "", reject);
        });
      }
      if (command.type === "workspace.file.read") {
        return Promise.resolve(result({
          kind: "workspace.file",
          usedFallback: false,
          file: {
            path: command.payload.path,
            content: "export const ready = true;\n",
            truncated: false,
            language: "ts",
            contentDigest: "a".repeat(64),
            modifiedAt: "2026-08-22T12:00:00.000Z",
          },
        }));
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    const setActiveTool = vi.fn();
    const hook = renderHook(() => useWorkspaceTools({
      enabled: false,
      loadGitStatusOnMount: false,
      loadGitOnMount: false,
      loadFilesOnMount: false,
      project: alpha,
      conversation: alphaChat,
      detail: null,
      online: false,
      ignoreWhitespace: false,
      confirmDestructiveActions: true,
      refreshVersion: 0,
      request,
      run: vi.fn((_key: string, command: CommandWithoutId) => request(command)),
      subscribe: noopSubscribe,
      setActionError: vi.fn(),
      setActiveTool,
    }));

    act(() => hook.result.current.openTurnFile("src/First.ts"));
    await waitFor(() => expect(inspectionRejectors.has("src/First.ts")).toBe(true));
    markWorkspaceFileSearchEdit(alpha.id, alphaChat.id);
    act(() => hook.result.current.openTurnFile("src/Second.ts"));
    await waitFor(() => expect(inspectionRejectors.has("src/Second.ts")).toBe(true));

    await act(async () => {
      inspectionRejectors.get("src/First.ts")?.(new Error("not a directory"));
      await Promise.resolve();
    });
    expect(hook.result.current.selectedFile).toBeNull();
    expect(request.mock.calls.some(([command]) => (
      command.type === "workspace.file.read"
      && command.payload.path === "src/First.ts"
    ))).toBe(false);

    await act(async () => {
      inspectionRejectors.get("src/Second.ts")?.(new Error("not a directory"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hook.result.current.filePreview?.path).toBe("src/Second.ts");
    });
    expect(setActiveTool).toHaveBeenCalledWith("files");
  });

  it("ignores a file-selection callback captured by an old owner", async () => {
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "project.actions") {
        return Promise.resolve(result({
          kind: "project.actions",
          actions: [],
        }));
      }
      return Promise.reject(new Error("An old owner tried to read a file."));
    });
    const hook = renderHook((owner: {
      project: Project;
      conversation: Conversation;
    }) => useWorkspaceFiles({
      ...owner,
      enabled: true,
      loadOnMount: false,
      online: true,
      request,
      setActionError: vi.fn(),
    }), {
      initialProps: { project: alpha, conversation: alphaChat },
    });
    const staleSelection = hook.result.current.selectWorkspaceFile;

    hook.rerender({ project: beta, conversation: betaChat });
    act(() => staleSelection("src/private.ts:12"));
    await act(async () => await Promise.resolve());

    expect(request.mock.calls.some(
      ([command]) => command.type === "workspace.file.read",
    )).toBe(false);
    expect(hook.result.current.selectedFile).toBeNull();
    expect(hook.result.current.filePreview).toBeNull();
  });

  it("does not let a stale Markdown heading request follow a newer file", async () => {
    const fileResolvers = new Map<
      string,
      (event: ServerEvent) => void
    >();
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "project.actions") {
        return Promise.resolve(result({
          kind: "project.actions",
          actions: [],
        }));
      }
      if (command.type !== "workspace.file.read") {
        return Promise.reject(new Error("Unexpected command"));
      }
      return new Promise((resolve) => {
        fileResolvers.set(command.payload.path, resolve);
      });
    });
    const hook = renderHook(() => useWorkspaceFiles({
      project: alpha,
      conversation: alphaChat,
      enabled: true,
      loadOnMount: false,
      online: true,
      request,
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.selectWorkspaceFile(
      "docs/guide.md",
      undefined,
      false,
      "details",
    ));
    await waitFor(() => {
      expect(hook.result.current.selectedMarkdownHeading).toMatchObject({
        path: "docs/guide.md",
        headingId: "details",
      });
    });

    act(() => hook.result.current.selectWorkspaceFile("README.md"));
    await waitFor(() => {
      expect(hook.result.current.selectedFile).toBe("README.md");
      expect(hook.result.current.selectedMarkdownHeading).toBeNull();
    });

    await act(async () => {
      fileResolvers.get("docs/guide.md")?.(result({
        kind: "workspace.file",
        usedFallback: false,
        file: {
          path: "docs/guide.md",
          content: "# Guide\n\n## Details\n",
          truncated: false,
          language: "markdown",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-08-20T07:00:00.000Z",
        },
      }));
      await Promise.resolve();
    });
    expect(hook.result.current.selectedFile).toBe("README.md");
    expect(hook.result.current.selectedMarkdownHeading).toBeNull();

    await act(async () => {
      fileResolvers.get("README.md")?.(result({
        kind: "workspace.file",
        usedFallback: false,
        file: {
          path: "README.md",
          content: "# Readme\n",
          truncated: false,
          language: "markdown",
          contentDigest: "b".repeat(64),
          modifiedAt: "2026-08-20T07:00:00.000Z",
        },
      }));
      await Promise.resolve();
    });
    expect(hook.result.current.filePreview?.path).toBe("README.md");
    expect(hook.result.current.selectedMarkdownHeading).toBeNull();
  });

  it("opens literal colon filenames before retrying a Codex source location", async () => {
    const requests: Array<{ path: string; fallbackPath?: string }> = [];
    let literalExists = true;
    const request = vi.fn((
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "project.actions") {
        return Promise.resolve(result({
          kind: "project.actions",
          actions: [],
        }));
      }
      if (command.type !== "workspace.file.read") {
        return Promise.reject(new Error("Unexpected command"));
      }
      requests.push({
        path: command.payload.path,
        ...(command.payload.fallbackPath
          ? { fallbackPath: command.payload.fallbackPath }
          : {}),
      });
      const path = literalExists
        ? command.payload.path
        : "src/Example.ts";
      return Promise.resolve(result({
        kind: "workspace.file",
        usedFallback: !literalExists,
        file: {
          path,
          content: Array.from(
            { length: 50 },
            (_, index) => `export const value${index + 1} = ${index + 1};`,
          ).join("\n"),
          truncated: false,
          language: "ts",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-07-29T10:00:00.000Z",
        },
      }));
    });
    const hook = renderHook(() => useWorkspaceFiles({
      project: alpha,
      conversation: alphaChat,
      enabled: true,
      loadOnMount: false,
      online: true,
      request,
      setActionError: vi.fn(),
    }));

    act(() =>
      hook.result.current.selectWorkspaceFile("src/example.ts:42:7"));
    await waitFor(() => {
      expect(hook.result.current.filePreview?.path)
        .toBe("src/example.ts:42:7");
    });
    expect(requests).toEqual([{
      path: "src/example.ts:42:7",
      fallbackPath: "src/example.ts",
    }]);
    expect(hook.result.current.selectedFileLocation).toBeNull();

    literalExists = false;
    requests.length = 0;
    act(() =>
      hook.result.current.selectWorkspaceFile("src/example.ts:42:7"));
    await waitFor(() => {
      expect(hook.result.current.filePreview?.path).toBe("src/Example.ts");
    });
    expect(requests).toEqual([{
      path: "src/example.ts:42:7",
      fallbackPath: "src/example.ts",
    }]);
    expect(hook.result.current.selectedFile).toBe("src/Example.ts");
    expect(hook.result.current.selectedFileLocation).toEqual({
      startLine: 42,
      startColumn: 7,
      endLine: 42,
    });
  });

  it("does not reinterpret an encoded literal colon as a source location", async () => {
    const paths: Array<{ path: string; fallbackPath?: string }> = [];
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "project.actions") {
        return Promise.resolve(result({ kind: "project.actions", actions: [] }));
      }
      if (command.type !== "workspace.file.read") {
        return Promise.reject(new Error("Unexpected command"));
      }
      paths.push({
        path: command.payload.path,
        ...(command.payload.fallbackPath
          ? { fallbackPath: command.payload.fallbackPath }
          : {}),
      });
      return Promise.reject(new Error("Literal file not found"));
    });
    const hook = renderHook(() => useWorkspaceFiles({
      project: alpha,
      conversation: alphaChat,
      enabled: true,
      loadOnMount: false,
      online: true,
      request,
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.selectWorkspaceFile(
      "src/Service.java:42",
      undefined,
      true,
    ));
    await waitFor(() => expect(hook.result.current.filePreviewError)
      .toBe("Literal file not found"));
    expect(paths).toEqual([{ path: "src/Service.java:42" }]);
  });

  it("does not let delayed project actions replace the new owner's actions", async () => {
    let settleAlpha: ((event: ServerEvent) => void) | null = null;
    const alphaAction: ProjectAction = {
      id: "run",
      label: "Alpha run",
      command: "alpha",
      preview: false,
    };
    const betaAction: ProjectAction = {
      id: "run",
      label: "Beta run",
      command: "beta",
      preview: false,
    };
    const request = vi.fn((command: CommandWithoutId) => {
      if (command.type !== "project.actions") {
        return Promise.reject(new Error("Unexpected command"));
      }
      if (command.payload.projectId === alpha.id) {
        return new Promise<ServerEvent>((resolve) => {
          settleAlpha = resolve;
        });
      }
      return Promise.resolve(result({
        kind: "project.actions",
        actions: [betaAction],
      }));
    });
    const setActionError = vi.fn();
    const hook = renderHook((owner: {
      project: Project;
      conversation: Conversation;
    }) => useWorkspaceFiles({
      ...owner,
      enabled: true,
      loadOnMount: false,
      online: true,
      request,
      setActionError,
    }), {
      initialProps: { project: alpha, conversation: alphaChat },
    });

    hook.rerender({ project: beta, conversation: betaChat });
    await waitFor(() => {
      expect(hook.result.current.projectActions).toEqual([betaAction]);
    });
    await act(async () => {
      settleAlpha?.(result({
        kind: "project.actions",
        actions: [alphaAction],
      }));
      await Promise.resolve();
    });

    expect(hook.result.current.projectActions).toEqual([betaAction]);
  });

  it("preserves an agent-selected file when opening the Files tool loads its tree", async () => {
    let settlePreview: ((event: ServerEvent) => void) | null = null;
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "project.actions") {
        return Promise.resolve(result({
          kind: "project.actions",
          actions: [],
        }));
      }
      if (command.type === "workspace.entries") {
        return Promise.resolve(result({
          kind: "workspace.entries",
          directory: "",
          entries: [{ path: "src", kind: "directory" }],
          truncated: false,
        }));
      }
      if (command.type === "workspace.file.read") {
        return new Promise((resolve) => {
          settlePreview = resolve;
        });
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    const hook = renderHook(
      ({ loadOnMount }: { loadOnMount: boolean }) => useWorkspaceFiles({
        project: alpha,
        conversation: alphaChat,
        enabled: true,
        loadOnMount,
        online: true,
        request,
        setActionError: vi.fn(),
      }),
      { initialProps: { loadOnMount: false } },
    );

    act(() => hook.result.current.selectWorkspaceFile("src/example.ts"));
    hook.rerender({ loadOnMount: true });
    await waitFor(() => {
      expect(hook.result.current.workspaceEntries).toEqual([
        { path: "src", kind: "directory" },
      ]);
    });
    await act(async () => {
      settlePreview?.(result({
        kind: "workspace.file",
        usedFallback: false,
        file: {
          path: "src/example.ts",
          content: "export const value = 1;\n",
          truncated: false,
          language: "ts",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-07-29T10:00:00.000Z",
        },
      }));
      await Promise.resolve();
    });

    expect(hook.result.current.selectedFile).toBe("src/example.ts");
    expect(hook.result.current.filePreview?.path).toBe("src/example.ts");
  });

  it("does not reload and collapse the Files tree when reopening the same pane", async () => {
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "project.actions") {
        return Promise.resolve(result({
          kind: "project.actions",
          actions: [],
        }));
      }
      if (command.type === "workspace.entries") {
        return Promise.resolve(result({
          kind: "workspace.entries",
          directory: "",
          entries: [{ path: "src", kind: "directory" }],
          truncated: false,
        }));
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    const hook = renderHook(
      ({ loadOnMount, online }: {
        loadOnMount: boolean;
        online: boolean;
      }) => useWorkspaceFiles({
        project: alpha,
        conversation: alphaChat,
        enabled: true,
        loadOnMount,
        online,
        request,
        setActionError: vi.fn(),
      }),
      { initialProps: { loadOnMount: true, online: true } },
    );

    await waitFor(() => {
      expect(request.mock.calls.filter(
        ([command]) => command.type === "workspace.entries",
      )).toHaveLength(1);
    });
    hook.rerender({ loadOnMount: false, online: true });
    hook.rerender({ loadOnMount: true, online: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(request.mock.calls.filter(
      ([command]) => command.type === "workspace.entries",
    )).toHaveLength(1);
    expect(hook.result.current.workspaceEntries).toEqual([
      { path: "src", kind: "directory" },
    ]);

    hook.rerender({ loadOnMount: true, online: false });
    expect(hook.result.current.workspaceEntries).toEqual([
      { path: "src", kind: "directory" },
    ]);
    hook.rerender({ loadOnMount: true, online: true });
    await waitFor(() => {
      expect(request.mock.calls.filter(
        ([command]) => command.type === "workspace.entries",
      )).toHaveLength(2);
    });
    expect(hook.result.current.workspaceEntries).toEqual([
      { path: "src", kind: "directory" },
    ]);
  });

  it("discards a delayed Git refresh after the pane changes owner", async () => {
    const alphaResolvers: Array<(event: ServerEvent) => void> = [];
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (
        (
          command.type === "git.refresh"
          || command.type === "git.workspace.refresh"
          || command.type === "git.diff"
        )
        && command.payload.projectId === alpha.id
      ) {
        return new Promise((resolve) => alphaResolvers.push(resolve));
      }
      if (command.type === "git.refresh") {
        return Promise.resolve(result({
          kind: "git.status",
          status: {
            isRepository: true,
            authorityRef: "66666666-6666-4666-8666-666666666666",
            root: "/beta",
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            hasRemote: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        }));
      }
      if (command.type === "git.workspace.refresh") {
        return Promise.resolve(result({
          kind: "git.workspace.status",
          status: {
            repositories: [],
            files: 0,
            insertions: 0,
            deletions: 0,
            scannedDirectories: 1,
            skippedDirectories: 0,
            discoveredRepositories: 1,
            repositoryLimit: 64,
            partial: false,
            truncated: false,
            issues: [],
          },
        }));
      }
      if (command.type === "git.diff") {
        return Promise.resolve(result({
          kind: "git.diff",
          diff: { patch: "BETA", truncated: false, files: [] },
        }));
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    const setActionError = vi.fn();
    const run = async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => await request(command);
    const hook = renderHook((owner: {
      project: Project;
      conversation: Conversation;
    }) => useWorkspaceGit({
      ...owner,
      enabled: true,
      loadStatusOnMount: false,
      loadWorkspaceOnMount: false,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run,
      subscribe: noopSubscribe,
      setActionError,
    }), {
      initialProps: { project: alpha, conversation: alphaChat },
    });
    let alphaLoad!: Promise<void>;
    act(() => {
      alphaLoad = hook.result.current.loadGit();
    });
    hook.rerender({ project: beta, conversation: betaChat });
    await act(async () => {
      await hook.result.current.loadGit();
    });
    expect(hook.result.current.gitStatus?.root).toBe("/beta");
    expect(hook.result.current.gitDiff?.patch).toBe("BETA");

    await act(async () => {
      alphaResolvers[0]?.(result({
        kind: "git.status",
        status: {
          isRepository: false,
          root: "/alpha",
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
        },
      }));
      alphaResolvers[1]?.(result({
        kind: "git.workspace.status",
        status: {
          repositories: [],
          files: 0,
          insertions: 0,
          deletions: 0,
          scannedDirectories: 1,
          skippedDirectories: 0,
          discoveredRepositories: 0,
          repositoryLimit: 64,
          partial: false,
          truncated: false,
          issues: [],
        },
      }));
      await alphaLoad;
    });

    expect(hook.result.current.gitStatus?.root).toBe("/beta");
    expect(hook.result.current.gitDiff?.patch).toBe("BETA");
  });

  it("does not apply a delayed commit review after its project owner changes", async () => {
    let settleDiff!: (event: ServerEvent) => void;
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") {
        return Promise.resolve(result({
          kind: "git.status",
          status: {
            isRepository: true,
            authorityRef: "66666666-6666-4666-8666-666666666666",
            root: "/alpha",
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            hasRemote: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        }));
      }
      if (command.type === "git.diff") {
        return new Promise((resolve) => {
          settleDiff = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected ${command.type} command`));
    });
    const hook = renderHook((owner: {
      project: Project;
      conversation: Conversation;
    }) => useWorkspaceGit({
      ...owner,
      enabled: true,
      loadStatusOnMount: false,
      loadWorkspaceOnMount: false,
      online: true,
      ignoreWhitespace: true,
      refreshVersion: 0,
      request,
      run: async (_key, command) => await request(command),
      subscribe: noopSubscribe,
      setActionError: vi.fn(),
    }), {
      initialProps: { project: alpha, conversation: alphaChat },
    });

    let loaded!: Promise<unknown>;
    act(() => {
      loaded = hook.result.current.loadCommitReview();
    });
    await waitFor(() => expect(request).toHaveBeenCalledWith({
      type: "git.diff",
      payload: expect.objectContaining({
        projectId: alpha.id,
        conversationId: alphaChat.id,
        ignoreWhitespace: true,
        commitReview: true,
      }),
    }));
    hook.rerender({ project: beta, conversation: betaChat });
    await act(async () => {
      settleDiff(result({
        kind: "git.diff",
        diff: {
          patch: "ALPHA REVIEW",
          truncated: false,
          files: [],
          commitReview: {
            authorityRef: "77777777-7777-4777-8777-777777777777",
            fingerprint: "a".repeat(64),
          },
        },
      }));
      await expect(loaded).resolves.toBeNull();
    });

    expect(hook.result.current.gitDiff).toBeNull();
  });

  it("loads root Git status for shell actions without scanning nested repositories", async () => {
    const setActionError = vi.fn();
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type !== "git.refresh") {
        return Promise.reject(new Error(`Unexpected ${command.type} command`));
      }
      return Promise.resolve(result({
        kind: "git.status",
        status: {
          isRepository: true,
          authorityRef: "66666666-6666-4666-8666-666666666666",
          root: "/alpha",
          branch: "feature/status-ready",
          upstream: "origin/feature/status-ready",
          ahead: 0,
          behind: 0,
          hasRemote: true,
          files: [{
            path: "README.md",
            status: "modified",
            insertions: 1,
            deletions: 0,
            untracked: false,
            staged: false,
            unstaged: true,
            indexStatus: " ",
            worktreeStatus: "M",
          }],
          insertions: 1,
          deletions: 0,
        },
      }));
    });
    const run = async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => await request(command);
    const hook = renderHook(() => useWorkspaceGit({
      enabled: true,
      loadStatusOnMount: true,
      loadWorkspaceOnMount: false,
      project: alpha,
      conversation: alphaChat,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run,
      subscribe: noopSubscribe,
      setActionError,
    }));

    await waitFor(() => {
      expect(hook.result.current.gitStatus?.branch)
        .toBe("feature/status-ready");
      expect(hook.result.current.loading).toBe(false);
    });
    expect(hook.result.current.gitStatus?.files).toHaveLength(1);
    expect(request.mock.calls.filter(
      ([command]) => command.type === "git.workspace.refresh",
    )).toHaveLength(0);
    expect(request.mock.calls.filter(
      ([command]) => command.type === "git.diff",
    )).toHaveLength(0);
  });

  it("includes the chat checkout authority in branch reads and mutations", async () => {
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") {
        return Promise.resolve(result({
          kind: "git.status",
          status: {
            isRepository: true,
            authorityRef: "66666666-6666-4666-8666-666666666666",
            root: "/alpha-worktree",
            branch: "inertia/alpha-chat",
            upstream: null,
            ahead: 0,
            behind: 0,
            hasRemote: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        }));
      }
      if (command.type === "git.branches") {
        return Promise.resolve(result({
          kind: "git.branches",
          branches: [{
            name: "inertia/alpha-chat",
            current: true,
            remote: false,
            worktreePath: null,
          }],
        }));
      }
      return Promise.reject(new Error(`Unexpected ${command.type} command`));
    });
    const run = vi.fn(() => new Promise<ServerEvent>(() => undefined));
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      enabled: true,
      loadStatusOnMount: true,
      loadWorkspaceOnMount: false,
      project: alpha,
      conversation: alphaChat,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run,
      subscribe: noopSubscribe,
      setActionError,
    }));

    await waitFor(() => {
      expect(hook.result.current.gitStatus?.branch)
        .toBe("inertia/alpha-chat");
    });
    act(() => hook.result.current.loadBranches());
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith({
        type: "git.branches",
        payload: {
          projectId: alpha.id,
          conversationId: alphaChat.id,
        },
      });
    });

    act(() => hook.result.current.mutateBranch(
      "git.branch.switch",
      "feature/chat-checkout",
    ));
    expect(run).toHaveBeenCalledWith("git.branch.switch", {
      type: "git.branch.switch",
      payload: {
        projectId: alpha.id,
        conversationId: alphaChat.id,
        repositoryPath: ".",
        authorityRef: "66666666-6666-4666-8666-666666666666",
        name: "feature/chat-checkout",
      },
    });
  });

  it("pins reviewed root authority and refreshes separately before an optional push", async () => {
    const reviewedAuthority = "66666666-6666-4666-8666-666666666666";
    const pushAuthority = "77777777-7777-4777-8777-777777777777";
    let refreshes = 0;
    const status = (authorityRef: string): ServerEvent => result({
      kind: "git.status",
      status: {
        isRepository: true,
        authorityRef,
        root: "/alpha-worktree",
        branch: "inertia/alpha-chat",
        upstream: "origin/inertia/alpha-chat",
        ahead: 1,
        behind: 0,
        hasRemote: true,
        files: [],
        insertions: 0,
        deletions: 0,
      },
    });
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") {
        refreshes += 1;
        return Promise.resolve(status(
          refreshes === 1 ? reviewedAuthority : pushAuthority,
        ));
      }
      if (command.type === "git.diff") {
        return Promise.resolve(result({
          kind: "git.diff",
          diff: {
            patch: "",
            truncated: false,
            files: [],
            commitReview: {
              authorityRef: "88888888-8888-4888-8888-888888888888",
              fingerprint: "a".repeat(64),
            },
          },
        }));
      }
      return Promise.reject(new Error(`Unexpected ${command.type} command`));
    });
    const run = vi.fn(async (
      _key: string,
      _command: CommandWithoutId,
    ): Promise<ServerEvent> => result({
      kind: "git.action",
      message: "Done.",
    }));
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      enabled: false,
      loadStatusOnMount: false,
      loadWorkspaceOnMount: false,
      project: alpha,
      conversation: alphaChat,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run,
      subscribe: noopSubscribe,
      setActionError,
    }));

    await act(async () => {
      expect(await hook.result.current.loadCommitReview()).not.toBeNull();
      await hook.result.current.loadGit({ authoritative: true, scope: "status" });
      await hook.result.current.commit(
        "Commit then push",
        true,
        ["selected.txt"],
      );
    });

    expect(run.mock.calls.filter(([, command]) => command.type === "git.commit"))
      .toHaveLength(1);
    expect(run).toHaveBeenCalledWith("git.commit", {
      type: "git.commit",
      payload: {
        projectId: alpha.id,
        conversationId: alphaChat.id,
        repositoryPath: ".",
        authorityRef: reviewedAuthority,
        message: "Commit then push",
        paths: ["selected.txt"],
        reviewReceipt: {
          authorityRef: "88888888-8888-4888-8888-888888888888",
          fingerprint: "a".repeat(64),
        },
      },
    });
    expect(run).toHaveBeenCalledWith("git.push", {
      type: "git.push",
      payload: {
        projectId: alpha.id,
        conversationId: alphaChat.id,
        repositoryPath: ".",
        authorityRef: pushAuthority,
      },
    });
    expect(setActionError).not.toHaveBeenCalled();
  });

  it("keeps the last Git projection visible while reconnect refreshes it", async () => {
    let refreshes = 0;
    let settleReconnect: ((event: ServerEvent) => void) | null = null;
    const gitStatus = (branch: string): ServerEvent => result({
      kind: "git.status",
      status: {
        isRepository: true,
        authorityRef: "66666666-6666-4666-8666-666666666666",
        root: "/alpha",
        branch,
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [],
        insertions: 0,
        deletions: 0,
      },
    });
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type !== "git.refresh") {
        return Promise.reject(new Error(`Unexpected ${command.type} command`));
      }
      refreshes += 1;
      if (refreshes === 1) return Promise.resolve(gitStatus("main"));
      return new Promise((resolve) => {
        settleReconnect = resolve;
      });
    });
    const run = async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => await request(command);
    const setActionError = vi.fn();
    const hook = renderHook(
      ({ online }: { online: boolean }) => useWorkspaceGit({
        enabled: true,
        loadStatusOnMount: true,
        loadWorkspaceOnMount: false,
        project: alpha,
        conversation: alphaChat,
        online,
        ignoreWhitespace: false,
        refreshVersion: 0,
        request,
        run,
        subscribe: noopSubscribe,
        setActionError,
      }),
      { initialProps: { online: true } },
    );
    await waitFor(() => expect(hook.result.current.gitStatus?.branch)
      .toBe("main"));

    hook.rerender({ online: false });
    expect(hook.result.current.gitStatus?.branch).toBe("main");
    hook.rerender({ online: true });
    await waitFor(() => expect(refreshes).toBe(2));
    expect(hook.result.current.gitStatus?.branch).toBe("main");
    expect(hook.result.current.loading).toBe(true);

    await act(async () => {
      settleReconnect?.(gitStatus("feature/reconnected"));
      await Promise.resolve();
    });
    expect(hook.result.current.gitStatus?.branch)
      .toBe("feature/reconnected");
    expect(hook.result.current.loading).toBe(false);
  });

  it("coalesces duplicate Git loads for the same pane authority", async () => {
    let settleWorkspace!: (event: ServerEvent) => void;
    const workspaceRefresh = new Promise<ServerEvent>((resolve) => {
      settleWorkspace = resolve;
    });
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") {
        return Promise.resolve(result({
          kind: "git.status",
          status: {
            isRepository: false,
            root: "/alpha",
            branch: null,
            upstream: null,
            ahead: 0,
            behind: 0,
            hasRemote: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        }));
      }
      if (command.type === "git.workspace.refresh") return workspaceRefresh;
      return Promise.reject(new Error("Unexpected command"));
    });
    const run = async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => await request(command);
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      enabled: true,
      loadStatusOnMount: false,
      loadWorkspaceOnMount: false,
      project: alpha,
      conversation: alphaChat,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run,
      subscribe: noopSubscribe,
      setActionError,
    }));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.loadGit();
      second = hook.result.current.loadGit();
    });
    expect(first).toBe(second);
    expect(request.mock.calls.filter(
      ([command]) => command.type === "git.refresh",
    )).toHaveLength(1);
    expect(request.mock.calls.filter(
      ([command]) => command.type === "git.workspace.refresh",
    )).toHaveLength(1);
    await waitFor(() => {
      expect(hook.result.current.gitStatus?.root).toBe("/alpha");
    });
    expect(hook.result.current.workspaceGitStatus).toBeNull();

    await act(async () => {
      settleWorkspace(result({
        kind: "git.workspace.status",
        status: {
          repositories: [],
          files: 0,
          insertions: 0,
          deletions: 0,
          scannedDirectories: 1,
          skippedDirectories: 0,
          discoveredRepositories: 0,
          repositoryLimit: 64,
          partial: false,
          truncated: false,
          issues: [],
        },
      }));
      await first;
    });
    expect(hook.result.current.workspaceGitStatus?.scannedDirectories).toBe(1);
  });

  it("queues a fresh Git load when the Changes pane closes and reopens mid-scan", async () => {
    const deferred = deferredWorkspaceGitRequests();
    const run = async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => await deferred.request(command);
    const setActionError = vi.fn();
    const hook = renderHook(
      ({ loadOnMount }: { loadOnMount: boolean }) => useWorkspaceGit({
        enabled: true,
        loadStatusOnMount: false,
        loadWorkspaceOnMount: loadOnMount,
        project: alpha,
        conversation: alphaChat,
        online: true,
        ignoreWhitespace: false,
        refreshVersion: 0,
        request: deferred.request,
        run,
        subscribe: noopSubscribe,
        setActionError,
      }),
      { initialProps: { loadOnMount: true } },
    );

    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.workspace.refresh",
      )).toHaveLength(1);
    });
    hook.rerender({ loadOnMount: false });
    hook.rerender({ loadOnMount: true });
    expect(deferred.request.mock.calls.filter(
      ([command]) => command.type === "git.workspace.refresh",
    )).toHaveLength(1);

    act(() => deferred.settle(0, "/stale"));
    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.workspace.refresh",
      )).toHaveLength(2);
    });
    expect(hook.result.current.gitStatus).toBeNull();

    act(() => deferred.settle(1, "/fresh"));
    await waitFor(() => {
      expect(hook.result.current.gitStatus?.root).toBe("/fresh");
      expect(hook.result.current.workspaceGitStatus?.scannedDirectories).toBe(2);
      expect(hook.result.current.loading).toBe(false);
    });
  });

  it("loads fresh root status without waiting for a stale workspace scan", async () => {
    const deferred = deferredWorkspaceGitRequests();
    const run = async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => await deferred.request(command);
    const setActionError = vi.fn();
    const hook = renderHook(
      ({ workspaceOpen }: { workspaceOpen: boolean }) => useWorkspaceGit({
        enabled: true,
        loadStatusOnMount: true,
        loadWorkspaceOnMount: workspaceOpen,
        project: alpha,
        conversation: alphaChat,
        online: true,
        ignoreWhitespace: false,
        refreshVersion: 0,
        request: deferred.request,
        run,
        subscribe: noopSubscribe,
        setActionError,
      }),
      { initialProps: { workspaceOpen: true } },
    );

    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.workspace.refresh",
      )).toHaveLength(1);
    });
    hook.rerender({ workspaceOpen: false });

    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.refresh",
      )).toHaveLength(2);
    });
    expect(deferred.request.mock.calls.filter(
      ([command]) => command.type === "git.workspace.refresh",
    )).toHaveLength(1);

    act(() => deferred.settle(1, "/fresh-status"));
    await waitFor(() => {
      expect(hook.result.current.gitStatus?.root).toBe("/fresh-status");
      expect(hook.result.current.loading).toBe(false);
    });

    act(() => deferred.settle(0, "/stale-workspace"));
    expect(hook.result.current.gitStatus?.root).toBe("/fresh-status");
  });

  it("preserves a mounted Git load failure until a successful retry", async () => {
    let fail = true;
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (fail) return Promise.reject(new Error("Workspace scan timed out."));
      if (command.type === "git.refresh") {
        return Promise.resolve(result({
          kind: "git.status",
          status: {
            isRepository: false,
            root: "/alpha",
            branch: null,
            upstream: null,
            ahead: 0,
            behind: 0,
            hasRemote: false,
            files: [],
            insertions: 0,
            deletions: 0,
          },
        }));
      }
      if (command.type === "git.workspace.refresh") {
        return Promise.resolve(result({
          kind: "git.workspace.status",
          status: {
            repositories: [],
            files: 0,
            insertions: 0,
            deletions: 0,
            scannedDirectories: 1,
            skippedDirectories: 0,
            discoveredRepositories: 0,
            repositoryLimit: 64,
            partial: false,
            truncated: false,
            issues: [],
          },
        }));
      }
      return Promise.reject(new Error(`Unexpected ${command.type} command`));
    });
    const setActionError = vi.fn();
    const hook = renderHook(
      ({ refreshVersion }: { refreshVersion: number }) => useWorkspaceGit({
        enabled: true,
        loadStatusOnMount: true,
        loadWorkspaceOnMount: true,
        project: alpha,
        conversation: alphaChat,
        online: true,
        ignoreWhitespace: false,
        refreshVersion,
        request,
        run: async (_key, command) => await request(command),
        subscribe: noopSubscribe,
        setActionError,
      }),
      { initialProps: { refreshVersion: 0 } },
    );

    await waitFor(() => expect(hook.result.current.loadError)
      .toBe("Workspace scan timed out."));
    expect(setActionError).toHaveBeenCalledWith("Workspace scan timed out.");

    fail = false;
    await act(async () => {
      await hook.result.current.loadGit({ authoritative: true });
    });
    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.loadError).toBeNull();
      expect(hook.result.current.workspaceGitStatus?.scannedDirectories)
        .toBe(1);
    });
  });

  it("queues one authoritative trailing load for explicit refreshes during a scan", async () => {
    const deferred = deferredWorkspaceGitRequests();
    const run = async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => await deferred.request(command);
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      enabled: true,
      loadStatusOnMount: true,
      loadWorkspaceOnMount: true,
      project: alpha,
      conversation: alphaChat,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request: deferred.request,
      run,
      subscribe: noopSubscribe,
      setActionError,
    }));

    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.workspace.refresh",
      )).toHaveLength(1);
    });
    let firstRefresh!: Promise<void>;
    let secondRefresh!: Promise<void>;
    act(() => {
      firstRefresh = hook.result.current.loadGit({ authoritative: true });
      secondRefresh = hook.result.current.loadGit({ authoritative: true });
    });
    expect(firstRefresh).toBe(secondRefresh);
    expect(deferred.request.mock.calls.filter(
      ([command]) => command.type === "git.workspace.refresh",
    )).toHaveLength(1);

    act(() => deferred.settle(0, "/stale"));
    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.workspace.refresh",
      )).toHaveLength(2);
    });

    await act(async () => {
      deferred.settle(1, "/fresh");
      await secondRefresh;
    });
    await waitFor(() => {
      expect(hook.result.current.gitStatus?.root).toBe("/fresh");
      expect(hook.result.current.workspaceGitStatus?.scannedDirectories).toBe(2);
      expect(hook.result.current.loading).toBe(false);
    });
    expect(deferred.request.mock.calls.filter(
      ([command]) => command.type === "git.workspace.refresh",
    )).toHaveLength(2);
  });

  it("stays loading while an invalidation queues a trailing workspace scan", async () => {
    const deferred = deferredWorkspaceGitRequests();
    let publishEvent: ((event: ServerEvent) => void) | null = null;
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      enabled: true,
      loadStatusOnMount: true,
      loadWorkspaceOnMount: true,
      project: alpha,
      conversation: alphaChat,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request: deferred.request,
      run: async (_key, command) => await deferred.request(command),
      subscribe: (listener) => {
        publishEvent = listener;
        return () => undefined;
      },
      setActionError,
    }));

    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.workspace.refresh",
      )).toHaveLength(1);
    });
    act(() => publishEvent?.({
      type: "workspace.git.invalidated",
      requestId: "55555555-5555-4555-8555-555555555555",
      projectId: alpha.id,
      conversationId: alphaChat.id,
    }));

    act(() => deferred.settle(0, "/stale"));
    await waitFor(() => {
      expect(deferred.request.mock.calls.filter(
        ([command]) => command.type === "git.workspace.refresh",
      )).toHaveLength(2);
    });
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.gitStatus).toBeNull();

    act(() => deferred.settle(1, "/fresh"));
    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.gitStatus?.root).toBe("/fresh");
      expect(hook.result.current.workspaceGitStatus?.scannedDirectories).toBe(2);
    });
  });

  it("retains a completed reversal under its initiating pane authority", async () => {
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const structured = parseUnifiedDiff(patch);
    const file = structured.files[0]!;
    const hunk = file.hunks[0]!;
    const selectedLine = hunk.lines.find(({ kind }) => kind === "addition")!;
    const selection = {
      fingerprint: structured.fingerprint,
      file,
      hunk,
      lineIds: [selectedLine.id],
      reference: "src/value.ts",
      repositoryPath: ".",
    };
    const operation = {
      id: "55555555-5555-4555-8555-555555555555",
      authorityRef: "77777777-7777-4777-8777-777777777777",
      repositoryPath: ".",
      filePath: file.path,
      selectedLineCount: 1,
      affectedLayers: ["worktree"] as const,
      createdAt: "2026-07-28T12:01:00.000Z",
    };
    let settleReversal: ((event: ServerEvent) => void) | null = null;
    let settleUndo: ((event: ServerEvent) => void) | null = null;
    const run = vi.fn((
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "git.selection.inspect") {
        return Promise.resolve(result({
          kind: "git.reversal.plan",
          plan: {
            authorityRef: "66666666-6666-4666-8666-666666666666",
            filePath: file.path,
            hunkId: hunk.id,
            hunkHeader: hunk.header,
            selectedLineCount: 1,
            changedLineCount: 1,
            affectedLayers: ["worktree"],
            validation: {
              diffFingerprint: "a".repeat(64),
              fileFingerprint: "b".repeat(64),
              hunkFingerprint: "c".repeat(64),
              selectionFingerprint: "d".repeat(64),
              gitStateFingerprint: "e".repeat(64),
            },
          },
        }));
      }
      if (command.type === "git.selection.revert") {
        return new Promise((resolve) => {
          settleReversal = resolve;
        });
      }
      if (command.type === "git.selection.undo") {
        return new Promise((resolve) => {
          settleUndo = resolve;
        });
      }
      return Promise.reject(new Error("Unexpected command"));
    });
    const setGitDiff = vi.fn();
    const hook = renderHook((owner: {
      project: Project | null;
      conversation: Conversation | null;
    }) => useWorkspaceReview({
      ...owner,
      detail: null,
      gitDiff: { patch, truncated: false, files: [] },
      ignoreWhitespace: false,
      confirmDestructiveActions: false,
      request: vi.fn(),
      run,
      setGitDiff,
    }), {
      initialProps: { project: alpha, conversation: alphaChat },
    });

    let reversal!: Promise<void>;
    act(() => {
      reversal = hook.result.current.revertDiffSelection(selection, "");
    });
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith(
        "git.selection.revert",
        expect.objectContaining({ type: "git.selection.revert" }),
      );
    });

    hook.rerender({ project: beta, conversation: betaChat });
    await act(async () => {
      settleReversal?.(result({
        kind: "git.reversal",
        diff: { patch: "REVERSED", truncated: false, files: [] },
        operation: { ...operation, affectedLayers: [...operation.affectedLayers] },
      }));
      await reversal;
    });

    expect(hook.result.current.lastDiffReversal).toBeNull();
    expect(setGitDiff).not.toHaveBeenCalled();

    hook.rerender({ project: alpha, conversation: alphaChat });
    expect(hook.result.current.lastDiffReversal).toEqual(operation);

    let undo!: Promise<void>;
    act(() => {
      undo = hook.result.current.undoDiffReversal();
    });
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith("git.selection.undo", {
        type: "git.selection.undo",
        payload: {
          projectId: alpha.id,
          conversationId: alphaChat.id,
          repositoryPath: ".",
          operationId: operation.id,
          authorityRef: operation.authorityRef,
        },
      });
    });

    hook.rerender({ project: beta, conversation: betaChat });
    await act(async () => {
      settleUndo?.(result({
        kind: "git.diff",
        diff: { patch: "RESTORED", truncated: false, files: [] },
      }));
      await undo;
    });
    expect(setGitDiff).not.toHaveBeenCalled();

    hook.rerender({ project: alpha, conversation: alphaChat });
    expect(hook.result.current.lastDiffReversal).toBeNull();
  });

  it("clears a pending project action when the pane owner changes", () => {
    const action: ProjectAction = {
      id: "run",
      label: "Run",
      command: "npm run",
      preview: false,
    };
    const hook = renderHook((owner: {
      project: Project;
      conversationId: string;
    }) => useActivityActions({
      ...owner,
      run: vi.fn(),
      setActiveTool: vi.fn(),
      setActionError: vi.fn(),
    }), {
      initialProps: {
        project: alpha,
        conversationId: alphaChat.id,
      },
    });

    act(() => hook.result.current.runProjectAction(action));
    expect(hook.result.current.pendingActionId).toBe(action.id);
    hook.rerender({
      project: beta,
      conversationId: betaChat.id,
    });
    expect(hook.result.current.pendingActionId).toBeNull();
  });

  it("drops a pending provider resume instead of replaying it after a project switch", () => {
    const hook = renderHook((project: Project) => useActivityActions({
      project,
      conversationId: project.id === alpha.id ? alphaChat.id : betaChat.id,
      run: vi.fn(),
      setActiveTool: vi.fn(),
      setActionError: vi.fn(),
    }), { initialProps: alpha });

    act(() => hook.result.current.requestProviderResume(alphaChat.id));
    expect(hook.result.current.pendingResumeConversationId).toBe(alphaChat.id);
    hook.rerender(beta);
    expect(hook.result.current.pendingResumeConversationId).toBeNull();
    hook.rerender(alpha);
    expect(hook.result.current.pendingResumeConversationId).toBeNull();
  });

  it("stops the exact workspace run surfaced by the owning UI", async () => {
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const hook = renderHook(() => useActivityActions({
      project: alpha,
      conversationId: alphaChat.id,
      run,
      setActiveTool: vi.fn(),
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.stopWorkspaceRun({
      id: "55555555-5555-4555-8555-555555555555",
      label: "Preview service",
    }));

    await waitFor(() => expect(run).toHaveBeenCalledWith(
      "activity.stop:55555555-5555-4555-8555-555555555555",
      {
        type: "activity.stop",
        payload: { runId: "55555555-5555-4555-8555-555555555555" },
      },
    ));
  });

  it.each([
    ["acknowledgeActivity", "activity.acknowledge"],
    ["dismissActivity", "activity.dismiss"],
  ] as const)("routes %s to the exact failed run", async (
    action,
    commandType,
  ) => {
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.ok",
      requestId: crypto.randomUUID(),
    }));
    const hook = renderHook(() => useActivityActions({
      project: alpha,
      conversationId: alphaChat.id,
      run,
      setActiveTool: vi.fn(),
      setActionError: vi.fn(),
    }));
    const failedRun = {
      id: "77777777-7777-4777-8777-777777777777",
      label: "Typecheck",
    };

    act(() => hook.result.current[action](failedRun));

    await waitFor(() => expect(run).toHaveBeenCalledWith(
      `${commandType}:${failedRun.id}`,
      {
        type: commandType,
        payload: { runId: failedRun.id },
      },
    ));
  });

  it.each([
    [
      "acknowledgeActivity",
      new Error("The run was removed."),
      "Could not acknowledge Typecheck: The run was removed.",
    ],
    [
      "dismissActivity",
      "unknown failure",
      "Could not dismiss Typecheck: The run could not be dismissed.",
    ],
  ] as const)("reports %s failures without clearing the row", async (
    action,
    failure,
    message,
  ) => {
    const setActionError = vi.fn();
    const hook = renderHook(() => useActivityActions({
      project: alpha,
      conversationId: alphaChat.id,
      run: vi.fn(async () => {
        throw failure;
      }),
      setActiveTool: vi.fn(),
      setActionError,
    }));

    act(() => hook.result.current[action]({
      id: "88888888-8888-4888-8888-888888888888",
      label: "Typecheck",
    }));

    await waitFor(() => expect(setActionError).toHaveBeenCalledWith(message));
  });

  it("opens a service preview only after its exact pane context is active", async () => {
    const navigatePreview = vi.fn((
      _url: string,
      onSettled?: () => void,
    ) => onSettled?.());
    const focusPreview = vi.fn();
    const activateContext = vi.fn(() => true);
    const previewRun: WorkspaceRun = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "service",
      projectId: beta.id,
      conversationId: betaChat.id,
      actionId: "preview",
      label: "Docs preview",
      detail: "npm run preview",
      status: "running",
      attentionState: "acknowledged",
      canStop: true,
      port: 4173,
      startedAt: "2026-07-28T12:00:00.000Z",
      finishedAt: null,
    };
    const hook = renderHook((owner: {
      project: Project;
      conversationId: string;
    }) => useActivityActions({
      ...owner,
      run: vi.fn(),
      setActiveTool: vi.fn(),
      setActionError: vi.fn(),
      activateContext,
      navigatePreview,
      focusPreview,
    }), {
      initialProps: {
        project: alpha,
        conversationId: alphaChat.id,
      },
    });

    act(() => hook.result.current.openWorkspaceRunPreview(previewRun));
    expect(activateContext).toHaveBeenCalledWith(previewRun, "preview");
    expect(navigatePreview).not.toHaveBeenCalled();

    hook.rerender({ project: beta, conversationId: betaChat.id });
    await waitFor(() => expect(navigatePreview).toHaveBeenCalledWith(
      "http://127.0.0.1:4173",
      focusPreview,
    ));
    expect(focusPreview).toHaveBeenCalledOnce();
  });

  it("rejects stale or invalid service previews without changing context", () => {
    const activateContext = vi.fn(() => true);
    const navigatePreview = vi.fn();
    const setActionError = vi.fn();
    const hook = renderHook(() => useActivityActions({
      project: alpha,
      conversationId: alphaChat.id,
      run: vi.fn(),
      setActiveTool: vi.fn(),
      setActionError,
      activateContext,
      navigatePreview,
    }));

    act(() => hook.result.current.openWorkspaceRunPreview({
      id: "66666666-6666-4666-8666-666666666666",
      kind: "service",
      projectId: alpha.id,
      conversationId: alphaChat.id,
      label: "Expired preview",
      status: "succeeded",
      port: 4173,
    }));

    expect(activateContext).not.toHaveBeenCalled();
    expect(navigatePreview).not.toHaveBeenCalled();
    expect(setActionError).toHaveBeenCalledWith(
      "Could not open Expired preview: its preview is no longer available.",
    );
  });

  it("rejects a live preview when its exact workspace context is unavailable", () => {
    const activateContext = vi.fn(() => false);
    const navigatePreview = vi.fn();
    const setActionError = vi.fn();
    const hook = renderHook(() => useActivityActions({
      project: alpha,
      conversationId: alphaChat.id,
      run: vi.fn(),
      setActiveTool: vi.fn(),
      setActionError,
      activateContext,
      navigatePreview,
    }));
    const preview = {
      id: "99999999-9999-4999-8999-999999999999",
      kind: "service" as const,
      projectId: beta.id,
      conversationId: betaChat.id,
      label: "Unavailable preview",
      status: "running" as const,
      port: 4173,
    };

    act(() => hook.result.current.openWorkspaceRunPreview(preview));

    expect(activateContext).toHaveBeenCalledWith(preview, "preview");
    expect(navigatePreview).not.toHaveBeenCalled();
    expect(setActionError).toHaveBeenCalledWith(
      "Could not open Unavailable preview: its preview is no longer available.",
    );
  });

  it.each([
    {
      failure: new Error("The run already finished."),
      message: "Could not stop Review question: The run already finished.",
    },
    {
      failure: "unknown failure",
      message: "Could not stop Review question: The work could not be stopped.",
    },
  ])("surfaces an exact-run stop failure without hiding its owner", async ({
    failure,
    message,
  }) => {
    const setActionError = vi.fn();
    const hook = renderHook(() => useActivityActions({
      project: alpha,
      conversationId: alphaChat.id,
      run: vi.fn(async () => {
        throw failure;
      }),
      setActiveTool: vi.fn(),
      setActionError,
    }));

    act(() => hook.result.current.stopWorkspaceRun({
      id: "66666666-6666-4666-8666-666666666666",
      label: "Review question",
    }));

    await waitFor(() => expect(setActionError).toHaveBeenCalledWith(message));
  });

  it("closes and resets a native preview when its conversation changes", async () => {
    const previewClose = vi.fn(async () => undefined);
    let settleNavigation: ((state: {
      url: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }) => void) | null = null;
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        previewClose,
        onPreviewState: vi.fn(() => () => undefined),
        previewNavigate: vi.fn(({ url }: { url: string }) =>
          new Promise((resolve) => {
            settleNavigation = resolve;
          }).then(() => ({
            url,
            loading: false,
            canGoBack: false,
            canGoForward: false,
          }))),
      },
    });
    const hook = renderHook(
      ({ contextId }: { contextId: string }) => useDesktopTools({
        setActionError: vi.fn(),
        previewOwnerId: "primary",
        previewContextId: contextId,
      }),
      { initialProps: { contextId: alphaChat.id } },
    );
    act(() => hook.result.current.navigatePreview("http://localhost:3000"));
    expect(hook.result.current.previewUrl).toBe("http://localhost:3000");

    hook.rerender({ contextId: betaChat.id });
    act(() => {
      settleNavigation?.({
        url: "http://localhost:3000",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      });
    });

    await waitFor(() => {
      expect(hook.result.current.previewUrl).toBe("");
      expect(previewClose).toHaveBeenCalledWith({
        ownerId: "primary",
        contextId: alphaChat.id,
      });
    });
  });

});

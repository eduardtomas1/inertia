import { act, renderHook, waitFor } from "@testing-library/react";
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

describe("workspace pane authority", () => {
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
      loadOnMount: false,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run,
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
    const loadGit = vi.fn(async () => undefined);
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
      loadGit,
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
    expect(loadGit).not.toHaveBeenCalled();

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
    expect(loadGit).not.toHaveBeenCalled();

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
      snapshot: null,
      request: vi.fn(),
      run: vi.fn(),
      setActiveTool: vi.fn(),
      setActivityOpen: vi.fn(),
      setActionError: vi.fn(),
      activateContext: vi.fn(),
      openProjectPath: vi.fn(),
      navigatePreview: vi.fn(),
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

  it("waits for the target pane owner before navigating an activity preview", async () => {
    const activateContext = vi.fn();
    const navigateAlphaPreview = vi.fn();
    const navigateBetaPreview = vi.fn();
    const previewRun: WorkspaceRun = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "service",
      projectId: beta.id,
      conversationId: betaChat.id,
      actionId: "preview",
      label: "preview",
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
      navigatePreview: (url: string) => void;
    }) => useActivityActions({
      project: owner.project,
      conversationId: owner.conversationId,
      snapshot: null,
      request: vi.fn(),
      run: vi.fn(),
      setActiveTool: vi.fn(),
      setActivityOpen: vi.fn(),
      setActionError: vi.fn(),
      activateContext,
      openProjectPath: vi.fn(),
      navigatePreview: owner.navigatePreview,
    }), {
      initialProps: {
        project: alpha,
        conversationId: alphaChat.id,
        navigatePreview: navigateAlphaPreview,
      },
    });

    act(() => hook.result.current.openActivityPreview(previewRun));
    expect(activateContext).toHaveBeenCalledWith(previewRun, "preview");
    expect(navigateAlphaPreview).not.toHaveBeenCalled();

    hook.rerender({
      project: beta,
      conversationId: betaChat.id,
      navigatePreview: navigateBetaPreview,
    });
    await waitFor(() => {
      expect(navigateBetaPreview).toHaveBeenCalledWith(
        "http://127.0.0.1:4173",
      );
    });
    expect(navigateAlphaPreview).not.toHaveBeenCalled();
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

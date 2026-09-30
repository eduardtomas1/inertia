import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Conversation, Project, ServerEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { useWorkspaceGit } from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceGit";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

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
    modelSelection: providerNativeModelSelection({
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
describe("remote Git workspace scope", () => {
  it("loads bounded workspace status for the Files tree without requesting diffs or stale cross-project status", async () => {
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") return result({ kind: "git.status", status: {
        isRepository: true, root: alpha.path, branch: "main", upstream: null, ahead: 0, behind: 0,
        hasRemote: false, files: [], insertions: 0, deletions: 0,
      } });
      if (command.type === "git.workspace.refresh") return result({ kind: "git.workspace.status", status: {
        repositories: [], files: 0, insertions: 0, deletions: 0, scannedDirectories: 1, skippedDirectories: 0,
        discoveredRepositories: 0, repositoryLimit: 16, partial: false, truncated: false, issues: [],
      } });
      throw new Error(`Files must not request ${command.type}`);
    });
    const options = { enabled: true, online: true, loadStatusOnMount: true, loadWorkspaceOnMount: true,
      statusOnly: true, conversation: null, ignoreWhitespace: false, refreshVersion: 0, request,
      run: vi.fn(), subscribe: noopSubscribe, setActionError: vi.fn() };
    const hook = renderHook(({ owner, online }) => useWorkspaceGit({ ...options, project: owner, online }),
      { initialProps: { owner: alpha, online: true } });
    await waitFor(() => expect(hook.result.current.workspaceGitStatus).not.toBeNull());
    expect(request.mock.calls.map(([command]) => command.type).sort()).toEqual(["git.refresh", "git.workspace.refresh"]);
    hook.rerender({ owner: beta, online: false });
    expect(hook.result.current.workspaceGitStatus).toBeNull();
    expect(options.setActionError).not.toHaveBeenCalled();
  });
  it("marks the workspace snapshot stale from an invalidation until a later workspace refresh succeeds", async () => {
    const workspaceStatus = () => result({ kind: "git.workspace.status", status: {
      repositories: [], files: 0, insertions: 0, deletions: 0, scannedDirectories: 1, skippedDirectories: 0,
      discoveredRepositories: 0, repositoryLimit: 16, partial: false, truncated: false, issues: [],
    } });
    let holdWorkspace = false;
    const heldWorkspace: Array<() => void> = [];
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") return Promise.resolve(result({ kind: "git.status", status: {
        isRepository: true, root: alpha.path, branch: "main", upstream: null, ahead: 0, behind: 0,
        hasRemote: false, files: [], insertions: 0, deletions: 0,
      } }));
      if (command.type === "git.workspace.refresh") {
        if (!holdWorkspace) return Promise.resolve(workspaceStatus());
        return new Promise((resolve) => heldWorkspace.push(() => resolve(workspaceStatus())));
      }
      return Promise.reject(new Error(`Unexpected ${command.type}`));
    });
    const listeners = new Set<(event: ServerEvent) => void>();
    const subscribe = (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const invalidate = () => act(() => {
      for (const listener of listeners) {
        listener({ type: "workspace.git.invalidated", projectId: alpha.id, conversationId: alphaChat.id } as ServerEvent);
      }
    });
    const setActionError = vi.fn();
    const hook = renderHook(({ online }: { online: boolean }) => useWorkspaceGit({
      project: alpha, conversation: alphaChat, enabled: true, online, loadStatusOnMount: true,
      loadWorkspaceOnMount: true, statusOnly: true, ignoreWhitespace: false, refreshVersion: 0, request,
      run: vi.fn(), subscribe, setActionError,
    }), { initialProps: { online: true } });
    await waitFor(() => expect(hook.result.current.workspaceGitStatus).not.toBeNull());
    expect(hook.result.current.workspaceGitStale).toBe(false);

    hook.rerender({ online: false });
    invalidate();
    expect(hook.result.current.workspaceGitStale).toBe(true);
    expect(hook.result.current.loading).toBe(false);

    holdWorkspace = true;
    hook.rerender({ online: true });
    await waitFor(() => expect(heldWorkspace).toHaveLength(1));
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.workspaceGitStale).toBe(true);
    await act(async () => heldWorkspace[0]!());
    await waitFor(() => expect(hook.result.current.workspaceGitStale).toBe(false));

    holdWorkspace = false;
    invalidate();
    expect(hook.result.current.workspaceGitStale).toBe(true);
    await waitFor(() => expect(hook.result.current.workspaceGitStale).toBe(false));
  });

  it("loads review diffs passively and keeps the commit review user-initiated", async () => {
    const authorityRef = "66666666-6666-4666-8666-666666666666";
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") return result({ kind: "git.status", status: {
        isRepository: true, root: alpha.path, branch: "main", upstream: null, ahead: 0, behind: 0,
        hasRemote: false, files: [], insertions: 0, deletions: 0,
      } });
      if (command.type === "git.workspace.refresh") return result({ kind: "git.workspace.status", status: {
        repositories: [{
          repositoryPath: ".", authorityRef, state: "ready", error: null, branch: "main", upstream: null,
          ahead: 0, behind: 0, hasRemote: false, files: [], insertions: 0, deletions: 0, clean: true, truncated: false,
        }],
        files: 0, insertions: 0, deletions: 0, scannedDirectories: 1, skippedDirectories: 0,
        discoveredRepositories: 1, repositoryLimit: 16, partial: false, truncated: false, issues: [],
      } });
      throw new Error(`Unexpected ${command.type}`);
    });
    const run = vi.fn(async (): Promise<ServerEvent> => result({ kind: "git.workspace.diff", diff: {
      repositoryPath: ".", patch: "", truncated: false, files: [],
    } }));
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      project: alpha, conversation: alphaChat, enabled: true, online: true, loadStatusOnMount: true,
      loadWorkspaceOnMount: true, statusOnly: true, ignoreWhitespace: false, refreshVersion: 0, request, run,
      subscribe: noopSubscribe, setActionError,
    }));
    await waitFor(() => expect(hook.result.current.workspaceGitStatus).not.toBeNull());

    await act(async () => {
      await hook.result.current.loadWorkspaceRepositoryDiff(".", "README.md");
      await hook.result.current.loadWorkspaceRepositoryDiff(".");
      await hook.result.current.loadWorkspaceRepositoryDiff(".", undefined, true);
    });

    expect(run.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      { passive: true },
      { passive: true },
      { passive: false },
    ]);
  });

  it.each(["git.fetch", "git.pull", "git.push"] as const)("keeps %s in the loaded chat or draft workspace scope", async (type) => {
    const alphaAuthority = "66666666-6666-4666-8666-666666666666";
    const betaAuthority = "77777777-7777-4777-8777-777777777777";
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type !== "git.refresh") return Promise.reject(new Error(`Unexpected ${command.type}`));
      return Promise.resolve(result({ kind: "git.status", status: {
        isRepository: true,
        authorityRef: command.payload.projectId === alpha.id ? alphaAuthority : betaAuthority,
        root: command.payload.projectId === alpha.id ? alpha.path : beta.path,
        branch: command.payload.conversationId ? "chat" : "root",
        upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true,
        files: [], insertions: 0, deletions: 0,
      } }));
    });
    const run = vi.fn(() => new Promise<ServerEvent>(() => undefined));
    const setRemoteError = vi.fn();
    const hook = renderHook((scope: { project: Project; conversation: Conversation | null }) => useWorkspaceGit({
      ...scope, enabled: true, online: true, loadStatusOnMount: true, loadWorkspaceOnMount: false,
      ignoreWhitespace: false, refreshVersion: 0, request, run,
      subscribe: noopSubscribe, setActionError: setRemoteError,
    }), { initialProps: { project: alpha, conversation: alphaChat as Conversation | null } });
    for (const scope of [
      { project: alpha, conversation: alphaChat, authority: alphaAuthority },
      { project: alpha, conversation: null, authority: alphaAuthority },
      { project: beta, conversation: null, authority: betaAuthority },
    ]) {
      hook.rerender(scope);
      await waitFor(() => {
        expect(hook.result.current.gitStatus?.branch).toBe(scope.conversation ? "chat" : "root");
        expect(hook.result.current.gitStatus?.authorityRef).toBe(scope.authority);
      });
      act(() => { void hook.result.current.mutateRemote(type); });
      expect(run).toHaveBeenLastCalledWith(type, {
        type, payload: {
          projectId: scope.project.id, conversationId: scope.conversation?.id,
          repositoryPath: ".", authorityRef: scope.authority,
        },
      });
    }
  });

  it("reports only failures of the workspace status refresh as workspace status errors", async () => {
    let failWorkspace = false;
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "git.refresh") return result({ kind: "git.status", status: {
        isRepository: true, authorityRef: "66666666-6666-4666-8666-666666666666", root: alpha.path, branch: "main",
        upstream: null, ahead: 0, behind: 0, hasRemote: false, files: [], insertions: 0, deletions: 0,
      } });
      if (command.type === "git.workspace.refresh") {
        if (failWorkspace) throw new Error("The workspace scan timed out.");
        return result({ kind: "git.workspace.status", status: {
          repositories: [], files: 0, insertions: 0, deletions: 0, scannedDirectories: 1, skippedDirectories: 0,
          discoveredRepositories: 0, repositoryLimit: 16, partial: false, truncated: false, issues: [],
        } });
      }
      if (command.type === "git.diff") throw new Error("The root diff could not be loaded.");
      throw new Error(`Unexpected ${command.type}`);
    });
    const run = vi.fn();
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      project: alpha, conversation: alphaChat, enabled: true, online: true, loadStatusOnMount: true,
      loadWorkspaceOnMount: true, ignoreWhitespace: false, refreshVersion: 0, request, run,
      subscribe: noopSubscribe, setActionError,
    }));
    await waitFor(() => expect(hook.result.current.loadError).toBe("The root diff could not be loaded."));
    expect(hook.result.current.workspaceGitStatus).not.toBeNull();
    expect(hook.result.current.workspaceLoadError).toBeNull();

    failWorkspace = true;
    await act(async () => {
      await hook.result.current.loadGit({ authoritative: true }).catch(() => undefined);
    });
    expect(hook.result.current.loadError).toBe("The workspace scan timed out.");
    expect(hook.result.current.workspaceLoadError).toBe("The workspace scan timed out.");

    failWorkspace = false;
    await act(async () => {
      await hook.result.current.loadGit({ authoritative: true, scope: "workspace-status" });
    });
    expect(hook.result.current.workspaceLoadError).toBeNull();
  });
});

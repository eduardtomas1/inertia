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

});

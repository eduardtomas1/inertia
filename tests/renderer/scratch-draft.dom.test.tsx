import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { defaultSettings, type AppSnapshot, type Project } from "../../src/shared/contracts";
import { useDraftConversation } from "../../src/renderer/src/hooks/useDraftConversation";
import { buildNewConversationPayload } from "../../src/renderer/src/lib/newConversation";

it("keeps a scratch draft out of the shared root and preserves its identity when switching projects", () => {
  const managed: Project = {
    id: "11111111-1111-4111-8111-111111111111", name: "No project", workspaceKind: "scratch",
    path: "/data/scratch", normalizedPath: "/data/scratch", repositoryRoot: null, repositoryIdentity: null,
    repositoryRelativePath: ".", groupingMode: null, gitRepositoryLimit: 16, color: "#777777", status: "ready",
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  };
  const normal: Project = { ...managed, workspaceKind: undefined, id: "22222222-2222-4222-8222-222222222222", name: "Real project", path: "/projects/real" };
  const settings = { ...defaultSettings, newThreadMode: "worktree" as const };
  const snapshot: AppSnapshot = { projects: [managed, normal], conversations: [], runs: [], providers: [], settings, activeProjectId: null, activeConversationId: null };
  const run = vi.fn();
  const hook = renderHook(() => useDraftConversation({ snapshot, settings, run, sendMessage: vi.fn(), persistedConversationId: null, updatePersistedConversation: vi.fn() }));
  act(() => hook.result.current.start(managed.id, true));
  const id = hook.result.current.conversation!.id;
  expect(buildNewConversationPayload(managed, settings).useWorktree).toBe(false);
  expect(hook.result.current.requiresWorkspaceMaterialization).toBe(true);
  expect(hook.result.current.workspaceConversation).toBeNull();
  expect(run).not.toHaveBeenCalled();
  act(() => hook.result.current.changeProject(normal.id));
  expect(hook.result.current.conversation!.id).toBe(id);
  act(() => hook.result.current.changeProject(managed.id));
  expect(hook.result.current.conversation).toMatchObject({ id, projectId: managed.id, branch: null, worktreePath: null });
  expect(hook.result.current.requiresWorkspaceMaterialization).toBe(true);
});

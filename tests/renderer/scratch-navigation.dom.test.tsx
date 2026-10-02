import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ServerEvent } from "../../src/shared/contracts";
import { useProjectChatNavigation } from "../../src/renderer/src/hooks/useProjectChatNavigation";

const managed: Project = {
  id: "11111111-1111-4111-8111-111111111111", name: "No project", workspaceKind: "scratch",
  path: "/data/scratch", normalizedPath: "/data/scratch", repositoryRoot: null, repositoryIdentity: null,
  repositoryRelativePath: ".", groupingMode: null, gitRepositoryLimit: 16, color: "#777777", status: "ready",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => localStorage.clear());

function setup(projects: Project[] = []) {
  const draft = { changeProject: vi.fn(), discard: vi.fn(), clear: vi.fn(), importProject: vi.fn(), sendFromComposer: vi.fn(), start: vi.fn() };
  let resolve!: (event: ServerEvent) => void;
  const queue = vi.fn(() => new Promise<ServerEvent>((done) => { resolve = done; }));
  const setView = vi.fn();
  const setActionError = vi.fn();
  const generation = { current: 0 };
  const hook = renderHook(({ choices }) => useProjectChatNavigation({
    project: choices[0] ?? null, projects: choices, busyAction: null, draftConversation: draft,
    selectionCommandQueue: queue, conversationSelectionGenerationRef: generation,
    updateSplitConversationId: vi.fn(), setSidebarOpen: vi.fn(), setView, setActionError,
  }), { initialProps: { choices: projects } });
  const finish = async () => { await act(async () => resolve({ type: "request.result", requestId: "request", result: { kind: "project.created", projectId: managed.id } })); };
  return { hook, draft, queue, finish, setView, setActionError };
}

describe("No project navigation", () => {
  it("starts on an empty profile after the managed project reaches the snapshot", async () => {
    const { hook, queue, draft, finish } = setup();
    act(() => hook.result.current.openGlobalChat());
    expect(queue).toHaveBeenCalledWith("project.ensure-scratch", { type: "project.ensure-scratch", payload: {} });
    await finish();
    expect(draft.start).not.toHaveBeenCalled();
    hook.rerender({ choices: [managed] });
    expect(draft.start).toHaveBeenCalledExactlyOnceWith(managed.id, true);
    expect(hook.result.current.globalChatActive).toBe(true);
  });

  it("retargets the existing composer without discarding its draft", async () => {
    const { hook, draft, finish } = setup([managed]);
    act(() => hook.result.current.selectGlobalChatProject(null));
    await finish();
    expect(draft.changeProject).toHaveBeenCalledExactlyOnceWith(managed.id);
    expect(draft.discard).not.toHaveBeenCalled();
    expect(draft.start).not.toHaveBeenCalled();
  });

  it("does not navigate back after the user leaves while the folder is being prepared", async () => {
    const { hook, draft, finish, setView } = setup([managed]);
    act(() => hook.result.current.openNoProjectChat());
    act(() => hook.result.current.navigateToView("settings"));
    await finish();
    expect(draft.start).not.toHaveBeenCalled();
    expect(setView).toHaveBeenLastCalledWith("settings");
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Project, ServerEvent } from "../../src/shared/contracts";
import type { AppView } from "../../src/renderer/src/appView";
import { useProjectChatNavigation } from "../../src/renderer/src/hooks/useProjectChatNavigation";

const now = "2026-09-01T10:00:00.000Z";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/workspace/${id}`,
    normalizedPath: `/workspace/${id}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6558d3",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
}

function setup() {
  const first = project("first", "First");
  const second = project("second", "Second");
  const start = vi.fn();
  const discard = vi.fn();
  const sendFromComposer = vi.fn(async () => ({
    kind: "message.accepted" as const,
    conversationId: "draft",
    turnId: "turn",
    userMessageId: "message",
    disposition: "new-turn" as const,
  }));
  const selectionCommandQueue = vi.fn(async () => ({} as ServerEvent));
  const setView = vi.fn() as Dispatch<SetStateAction<AppView>>;
  const setSidebarOpen = vi.fn() as Dispatch<SetStateAction<boolean>>;
  const setActionError = vi.fn() as Dispatch<SetStateAction<string | null>>;
  const generation = { current: 0 };
  const hook = renderHook(() => useProjectChatNavigation({
    project: first,
    projects: [first, second],
    busyAction: null,
    draftConversation: {
      discard,
      importProject: async () => false,
      sendFromComposer,
      start,
    },
    selectionCommandQueue,
    conversationSelectionGenerationRef: generation,
    startupSurface: "summary",
    showStartupSurface: vi.fn(),
    updateSplitConversationId: vi.fn(),
    setActionError,
    setSidebarOpen,
    setView,
  }));
  return {
    discard,
    first,
    generation,
    hook,
    second,
    selectionCommandQueue,
    sendFromComposer,
    setSidebarOpen,
    setView,
    start,
  };
}

describe("project chat navigation", () => {
  it("opens the real draft chat for the active project", () => {
    const { first, hook, setSidebarOpen, setView, start } = setup();

    act(() => hook.result.current.openGlobalChat());

    expect(start).toHaveBeenCalledWith(first.id);
    expect(setView).toHaveBeenCalledWith("home");
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
    expect(hook.result.current.globalChatActive).toBe(true);
  });

  it("switches only the draft project from the in-chat selector", async () => {
    const { generation, hook, second, selectionCommandQueue, start } = setup();

    act(() => hook.result.current.openGlobalChat());
    act(() => hook.result.current.selectGlobalChatProject(second));

    expect(selectionCommandQueue).toHaveBeenCalledWith(
      "project.select:global-chat",
      { type: "project.select", payload: { projectId: second.id } },
    );
    expect(generation.current).toBe(2);
    await waitFor(() => expect(start).toHaveBeenLastCalledWith(second.id));
    expect(hook.result.current.globalProjectChangeId).toBeNull();
  });

  it("enters the workspace after the first accepted message", async () => {
    const { hook, sendFromComposer, setView } = setup();

    act(() => hook.result.current.openGlobalChat());
    await act(async () => {
      await hook.result.current.sendMessage("Build it", []);
    });

    expect(sendFromComposer).toHaveBeenCalledWith("Build it", []);
    expect(setView).toHaveBeenLastCalledWith("workspace");
    expect(hook.result.current.globalChatActive).toBe(false);
  });

  it("discards the global draft when navigating away", () => {
    const { discard, hook, setView } = setup();

    act(() => hook.result.current.openGlobalChat());
    act(() => hook.result.current.navigateToView("settings"));

    expect(discard).toHaveBeenCalledOnce();
    expect(setView).toHaveBeenLastCalledWith("settings");
    expect(hook.result.current.globalChatActive).toBe(false);
  });

  it("does not restore a draft after navigation overtakes its project change", async () => {
    const { hook, second, selectionCommandQueue, setView, start } = setup();
    let completeSelection: ((event: ServerEvent) => void) | undefined;
    selectionCommandQueue.mockImplementationOnce(() => new Promise(
      (resolve) => {
        completeSelection = resolve;
      },
    ));

    act(() => hook.result.current.openGlobalChat());
    act(() => hook.result.current.selectGlobalChatProject(second));
    act(() => hook.result.current.navigateToView("workspace"));
    await act(async () => {
      completeSelection?.({} as ServerEvent);
      await Promise.resolve();
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalledWith(second.id);
    expect(setView).toHaveBeenLastCalledWith("workspace");
    expect(hook.result.current.globalChatActive).toBe(false);
  });

  it("does not let an older project change replace a reopened draft", async () => {
    const { first, hook, second, selectionCommandQueue, setView, start } = setup();
    let completeSelection: ((event: ServerEvent) => void) | undefined;
    selectionCommandQueue.mockImplementationOnce(() => new Promise(
      (resolve) => {
        completeSelection = resolve;
      },
    ));

    act(() => hook.result.current.openGlobalChat());
    act(() => hook.result.current.selectGlobalChatProject(second));
    act(() => hook.result.current.openGlobalChat());
    await act(async () => {
      completeSelection?.({} as ServerEvent);
      await Promise.resolve();
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith(first.id);
    expect(start).not.toHaveBeenCalledWith(second.id);
    expect(setView).toHaveBeenLastCalledWith("home");
    expect(hook.result.current.globalChatActive).toBe(true);
  });
});

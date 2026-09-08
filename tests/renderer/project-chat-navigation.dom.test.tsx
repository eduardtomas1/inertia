import { act, renderHook } from "@testing-library/react";
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
  const changeProject = vi.fn();
  const discard = vi.fn();
  const clear = vi.fn();
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
  const generation = { current: 0 };
  const hook = renderHook(() => useProjectChatNavigation({
    project: first,
    projects: [first, second],
    busyAction: null,
    draftConversation: {
      changeProject,
      discard,
      clear,
      importProject: async () => false,
      sendFromComposer,
      start,
    },
    selectionCommandQueue,
    conversationSelectionGenerationRef: generation,
    startupSurface: "summary",
    showStartupSurface: vi.fn(),
    updateSplitConversationId: vi.fn(),
    setSidebarOpen,
    setView,
  }));
  return {
    changeProject,
    discard,
    clear,
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
  it("resumes a draft after search without deleting its persisted contents", () => {
    const { first, hook, clear, discard, start } = setup();
    act(() => hook.result.current.openGlobalChat());
    discard.mockClear();
    act(() => hook.result.current.exitGlobalChat(true));
    expect(hook.result.current.globalChatActive).toBe(false);
    expect(clear).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    act(() => hook.result.current.openGlobalChat());
    expect(start).toHaveBeenLastCalledWith(first.id, true, true);
  });

  it("retains a preserved draft across later chat and project navigation", () => {
    const { first, second, hook, discard, start } = setup();
    act(() => hook.result.current.openGlobalChat());
    act(() => hook.result.current.exitGlobalChat(true));
    act(() => hook.result.current.exitGlobalChat());
    act(() => hook.result.current.selectProject(second));
    act(() => hook.result.current.navigateToView("settings"));
    expect(discard).not.toHaveBeenCalled();
    act(() => hook.result.current.openGlobalChat());
    expect(start).toHaveBeenLastCalledWith(first.id, true, true);
    act(() => hook.result.current.exitGlobalChat());
    expect(discard).toHaveBeenCalledOnce();
  });

  it("opens the real draft chat for the active project", () => {
    const { first, hook, setSidebarOpen, setView, start } = setup();

    act(() => hook.result.current.openGlobalChat());

    expect(start).toHaveBeenCalledWith(first.id, true);
    expect(setView).toHaveBeenCalledWith("home");
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
    expect(hook.result.current.globalChatActive).toBe(true);
  });

  it("changes the draft target without navigating or creating a replacement draft", () => {
    const { changeProject, generation, hook, second, first, selectionCommandQueue, start } = setup();

    act(() => hook.result.current.openGlobalChat());
    act(() => hook.result.current.selectGlobalChatProject(second));

    expect(changeProject).toHaveBeenLastCalledWith(second.id);
    act(() => hook.result.current.selectGlobalChatProject(first));
    expect(changeProject).toHaveBeenLastCalledWith(first.id);
    expect(selectionCommandQueue).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(generation.current).toBe(1);
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

  it("does not redirect after navigation overtakes a draft send", async () => {
    const { hook, sendFromComposer, setView } = setup();
    let completeSend: ((event: Awaited<ReturnType<typeof sendFromComposer>>) => void) | undefined;
    const acceptance = await sendFromComposer();
    sendFromComposer.mockImplementationOnce(() => new Promise(
      (resolve) => {
        completeSend = resolve;
      },
    ));

    act(() => hook.result.current.openGlobalChat());
    let pending!: ReturnType<typeof hook.result.current.sendMessage>;
    act(() => { pending = hook.result.current.sendMessage("Build it", []); });
    act(() => hook.result.current.navigateToView("settings"));
    await act(async () => {
      completeSend?.(acceptance);
      await pending;
    });

    expect(setView).toHaveBeenLastCalledWith("settings");
    expect(hook.result.current.globalChatActive).toBe(false);
  });

  it("does not let an older send replace the draft reopened by the logo", async () => {
    const { first, hook, sendFromComposer, setView, start } = setup();
    let completeSend: ((event: Awaited<ReturnType<typeof sendFromComposer>>) => void) | undefined;
    const acceptance = await sendFromComposer();
    sendFromComposer.mockImplementationOnce(() => new Promise(
      (resolve) => {
        completeSend = resolve;
      },
    ));

    act(() => hook.result.current.openGlobalChat());
    let pending!: ReturnType<typeof hook.result.current.sendMessage>;
    act(() => { pending = hook.result.current.sendMessage("Build it", []); });
    act(() => hook.result.current.openGlobalChat());
    await act(async () => {
      completeSend?.(acceptance);
      await pending;
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith(first.id, true);
    expect(setView).toHaveBeenLastCalledWith("home");
    expect(hook.result.current.globalChatActive).toBe(true);
  });
});

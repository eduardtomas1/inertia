import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import { watcherEntryFor } from "../../src/renderer/src/components/watcher/watcherAvailability";
import { WatcherContext, type WatcherSurfaceModel } from "../../src/renderer/src/components/watcher/watcherContext";
import {
  consumeWatcherDockFocus,
  readWatcherDock,
  resetWatcherDockStore,
  takeWatcherDockError,
  watcherDockStorageKey,
} from "../../src/renderer/src/hooks/useWatcherDock";
import { useWatcherSurfaceController } from "../../src/renderer/src/hooks/useWatcherSurface";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import {
  OTHER_WATCHED_ID,
  WATCHED_ID,
  WATCHER_ID,
  link,
  project,
  shell,
  surfaceModel,
  watcherRuntime,
} from "./watcher-fixtures";

beforeEach(() => {
  window.localStorage.clear();
  resetWatcherDockStore();
});

function snapshot(conversations = [
  shell(WATCHED_ID, "Refactor parser"),
  shell(WATCHER_ID, "Watcher"),
  shell(OTHER_WATCHED_ID, "Docs sweep"),
]): AppSnapshot {
  return {
    projects: [project],
    conversations,
    runs: [],
    providers: [],
    settings: defaultSettings,
    activeProjectId: project.id,
    activeConversationId: WATCHED_ID,
    watchers: [link()],
  };
}

describe("watcher surface controller", () => {
  it("keeps the context value when an unrelated chat changes", () => {
    const initial = snapshot();
    const { result, rerender } = renderHook(
      ({ value }: { value: AppSnapshot }) => useWatcherSurfaceController({
        snapshot: value,
        surface: "main",
        online: true,
        request: null,
        primaryConversationId: WATCHED_ID,
      }),
      { initialProps: { value: initial } },
    );
    const before = result.current.surface;
    expect(before.conversations.map(({ id }) => id)).toEqual([WATCHED_ID, WATCHER_ID]);
    rerender({ value: {
      ...initial,
      conversations: [initial.conversations[0]!, initial.conversations[1]!, shell(OTHER_WATCHED_ID, "Docs sweep, renamed")],
    } });
    expect(result.current.surface).toBe(before);
    rerender({ value: {
      ...initial,
      conversations: [shell(WATCHED_ID, "Refactor parser", { status: "running" }), initial.conversations[1]!],
    } });
    expect(result.current.surface).not.toBe(before);
    expect(result.current.surface.conversations[0]?.status).toBe("running");
  });

  it("offers Open watcher as unavailable for a detached chat and leaves no focus request", () => {
    const selectConversation = vi.fn();
    const { result } = renderHook(() => useWatcherSurfaceController({
      snapshot: snapshot(),
      surface: "main",
      online: true,
      request: null,
      primaryConversationId: OTHER_WATCHED_ID,
      detachedConversationIds: new Set([WATCHED_ID]),
      selectConversation,
    }));
    const entry = watcherEntryFor(result.current.surface, shell(WATCHED_ID, "Refactor parser"));
    expect(entry).toMatchObject({ kind: "unavailable", reason: "Return this chat to the main window to see its watcher." });
    result.current.surface.showWatcher(WATCHED_ID);
    expect(selectConversation).not.toHaveBeenCalled();
    expect(consumeWatcherDockFocus(WATCHED_ID)).toBe(false);
  });

  it("names the existing watcher in a detached chat's thread actions", () => {
    const model = surfaceModel({ detachedConversationIds: new Set([WATCHED_ID]) });
    expect(watcherEntryFor(model, shell(WATCHED_ID, "Refactor parser"))).toMatchObject({ link: { id: link().id } });
  });
});

function renderPalette(model: WatcherSurfaceModel): void {
  render(
    <WatcherContext.Provider value={model}>
      <CommandPalette
        open
        projects={[project]}
        conversations={[shell(WATCHED_ID, "Refactor parser")]}
        newThreadShortcut="⌘N"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectConversation={vi.fn()}
        onNewThread={vi.fn()}
        onNewThreadIn={vi.fn()}
        currentProjectId={null}
        onAddProject={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    </WatcherContext.Provider>,
  );
}

describe("watcher actions in the command palette", () => {
  it("resumes a paused watcher", async () => {
    const paused = link({ status: "paused", pauseReason: "user" });
    const runtime = watcherRuntime({ link: () => paused });
    renderPalette(surfaceModel({ watchers: [paused], request: runtime.request }));
    expect(screen.queryByRole("option", { name: /Pause watcher/u })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: /^Resume watcher/u }));
    await waitFor(() => expect(runtime.commands.map(({ type }) => type)).toContain("watcher.resume"));
  });

  it("opens the dock to confirm a resume after unexplained changes", async () => {
    const paused = link({ status: "paused", pauseReason: "write-detected" });
    const runtime = watcherRuntime({ link: () => paused });
    const model = surfaceModel({ watchers: [paused], request: runtime.request });
    renderPalette(model);
    fireEvent.click(await screen.findByRole("option", { name: /^Resume watcher…/u }));
    expect(model.showWatcher).toHaveBeenCalledWith(WATCHED_ID);
    expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(false);
  });

  it("opens the dock with the error when the pause fails", async () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    const request = vi.fn(async (): Promise<ServerEvent> => {
      throw new RuntimeCommandError("The watcher changed meanwhile. Try again.", "rejected");
    });
    renderPalette(surfaceModel({ request }));
    fireEvent.click(await screen.findByRole("option", { name: /Pause watcher/u }));
    await waitFor(() => expect(readWatcherDock(WATCHED_ID).open).toBe(true));
    expect(takeWatcherDockError(WATCHED_ID)).toBe("The watcher changed meanwhile. Try again.");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WatchedByChip } from "../../src/renderer/src/components/watcher/WatchedByChip";
import { WatcherContext, type WatcherSurfaceModel } from "../../src/renderer/src/components/watcher/watcherContext";
import {
  readWatcherDock,
  resetWatcherDockStore,
  watcherDockStorageKey,
} from "../../src/renderer/src/hooks/useWatcherDock";
import { NOW, OTHER_WATCHED_ID, WATCHED_ID, link, surfaceModel } from "./watcher-fixtures";

function renderChip(model: WatcherSurfaceModel, conversationId = WATCHED_ID) {
  return render(
    <WatcherContext.Provider value={model}>
      <WatchedByChip conversationId={conversationId} />
    </WatcherContext.Provider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetWatcherDockStore();
});
afterEach(() => resetWatcherDockStore());

describe("WatchedByChip", () => {
  it("renders nothing for a chat without a watcher or outside a watcher surface", () => {
    const { container } = renderChip(surfaceModel(), OTHER_WATCHED_ID);
    expect(container).toBeEmptyDOMElement();
    const bare = render(<WatchedByChip conversationId={WATCHED_ID} />);
    expect(bare.container).toBeEmptyDOMElement();
  });

  it("names the watcher's agent and preset and toggles the dock it controls", () => {
    renderChip(surfaceModel());
    const chip = screen.getByRole("button", { name: /Watched by Team Codex fixture-model · Reviewer/u });
    expect(chip).toHaveAttribute("aria-controls", `watcher-dock-${WATCHED_ID}`);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(window.localStorage.getItem(watcherDockStorageKey(WATCHED_ID)) ?? "{}")).toMatchObject({ open: false });
    fireEvent.click(chip);
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
  });

  it("shows a badge only for a finding the user has not seen", () => {
    const latest = { outcome: "finding" as const, at: NOW, text: "The parser drops a token." };
    const first = renderChip(surfaceModel({ watchers: [link({ latest })] }));
    expect(screen.getByText("New finding")).toBeInTheDocument();
    first.unmount();
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: true, seenAt: NOW }));
    resetWatcherDockStore();
    renderChip(surfaceModel({ watchers: [link({ latest })] }));
    expect(screen.queryByText("New finding")).not.toBeInTheDocument();
  });

  it("says when the watcher is paused", () => {
    renderChip(surfaceModel({ watchers: [link({ status: "paused", pauseReason: "user" })] }));
    expect(screen.getByRole("button", { name: /Paused/u })).toBeInTheDocument();
  });

  it("offers only Open in main window in a detached chat window", () => {
    const openInMainWindow = vi.fn();
    renderChip(surfaceModel({ surface: "detached", openInMainWindow, openAttachDialog: null }));
    const chip = screen.getByRole("button", { name: /Watched by .*Open in main window/u });
    expect(chip).not.toHaveAttribute("aria-expanded");
    expect(chip).not.toHaveAttribute("aria-controls");
    fireEvent.click(chip);
    expect(openInMainWindow).toHaveBeenCalledOnce();
  });
});

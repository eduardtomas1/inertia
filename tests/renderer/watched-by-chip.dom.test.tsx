import { act, fireEvent, render, screen } from "@testing-library/react";
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
    const chip = screen.getByRole("button", { name: /^Watched by Team Codex · fixture-model · Reviewer$/u });
    expect(chip).toHaveAttribute("aria-controls", `watcher-dock-${WATCHED_ID}`);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(window.localStorage.getItem(watcherDockStorageKey(WATCHED_ID)) ?? "{}")).toMatchObject({ open: false });
    fireEvent.click(chip);
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
  });

  it("says new finding only for a finding the user has not seen", () => {
    const latest = { outcome: "finding" as const, at: NOW, text: "The parser drops a token." };
    const first = renderChip(surfaceModel({ watchers: [link({ latest, latestFindingAt: NOW })] }));
    expect(screen.getByRole("button", { name: /^Watched by .+ · Reviewer · new finding$/u })).toBeInTheDocument();
    first.unmount();
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: true, seenAt: NOW }));
    resetWatcherDockStore();
    renderChip(surfaceModel({ watchers: [link({ latest, latestFindingAt: NOW })] }));
    expect(document.querySelector(".watched-by-chip-new")).toBeNull();
  });

  it("keeps new finding when a quiet check follows an unseen finding", () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    const view = renderChip(surfaceModel({ watchers: [link({
      latest: { outcome: "finding", at: NOW, text: "A risk" },
      latestFindingAt: NOW,
    })] }));
    expect(document.querySelector(".watched-by-chip-new")).toHaveTextContent("· new finding");
    // 45 s later the next check answers SILENT: `latest` moves on, the finding stays unseen.
    view.rerender(
      <WatcherContext.Provider value={surfaceModel({ watchers: [link({
        latest: { outcome: "silent", at: "2026-10-19T10:42:45.000Z", text: "" },
        latestFindingAt: NOW,
      })] })}
      >
        <WatchedByChip conversationId={WATCHED_ID} />
      </WatcherContext.Provider>,
    );
    expect(document.querySelector(".watched-by-chip-new")).toHaveTextContent("· new finding");
  });

  it("announces a new finding next to the chip only while the dock is collapsed", () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    const region = () => document.querySelector<HTMLElement>('.watched-by-chip + [role="status"]')!;
    const model = (latestFindingAt: string | null) => surfaceModel({ watchers: [link({ latestFindingAt })] });
    const view = renderChip(model(null));
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveClass("visually-hidden");
    expect(region()).toBeEmptyDOMElement();
    const rerender = (latestFindingAt: string | null) => view.rerender(
      <WatcherContext.Provider value={model(latestFindingAt)}><WatchedByChip conversationId={WATCHED_ID} /></WatcherContext.Provider>,
    );
    rerender(NOW);
    expect(region()).toHaveTextContent(/^New finding$/u);
    rerender("2026-10-19T10:50:00.000Z");
    expect(region()).toHaveTextContent(/^New finding\.$/u);
    // With the dock open its own live region speaks; the chip stays quiet.
    fireEvent.click(screen.getByRole("button", { name: /Watched by/u }));
    expect(region()).toBeEmptyDOMElement();
    rerender("2026-10-19T10:55:00.000Z");
    expect(region()).toBeEmptyDOMElement();
  });

  it("drops new finding when another window marks the finding seen", () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    renderChip(surfaceModel({ watchers: [link({ latestFindingAt: NOW })] }));
    expect(document.querySelector(".watched-by-chip-new")).not.toBeNull();
    const key = watcherDockStorageKey(WATCHED_ID);
    const value = JSON.stringify({ open: true, seenAt: NOW });
    window.localStorage.setItem(key, value);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: value })); });
    expect(document.querySelector(".watched-by-chip-new")).toBeNull();
  });

  it("says when the watcher is paused", () => {
    renderChip(surfaceModel({ watchers: [link({ status: "paused", pauseReason: "user" })] }));
    expect(screen.getByRole("button", { name: /^Watched by .+ · Reviewer · Paused$/u })).toBeInTheDocument();
  });

  it("offers only Return to main window in a detached chat window", () => {
    const openInMainWindow = vi.fn();
    renderChip(surfaceModel({ surface: "detached", openInMainWindow, openAttachDialog: null }));
    const chip = screen.getByRole("button", { name: /^Watched by .+ · Reviewer · Return to main window$/u });
    expect(chip).not.toHaveAttribute("aria-expanded");
    expect(chip).not.toHaveAttribute("aria-controls");
    fireEvent.click(chip);
    expect(openInMainWindow).toHaveBeenCalledOnce();
  });
});

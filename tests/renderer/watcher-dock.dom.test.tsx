import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { WatcherLinkView } from "../../src/shared/watcher";
import { WatchedByChip } from "../../src/renderer/src/components/watcher/WatchedByChip";
import { WatcherDockHost } from "../../src/renderer/src/components/watcher/WatcherDockHost";
import { WatcherContext, type WatcherSurfaceModel } from "../../src/renderer/src/components/watcher/watcherContext";
import { loadWatcherDock } from "../../src/renderer/src/components/watcher/watcherLoaders";
import { WATCHER_DOCK_WIDTH_KEY } from "../../src/renderer/src/components/watcher/WatcherDock";
import {
  readWatcherDock,
  resetWatcherDockStore,
  watcherDockStorageKey,
} from "../../src/renderer/src/hooks/useWatcherDock";
import {
  OTHER_WATCHED_ID,
  WATCHED_ID,
  link,
  shell,
  surfaceModel,
  watcherRuntime,
} from "./watcher-fixtures";

const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

beforeAll(async () => {
  // Hosts declare their measured width; the dock reads it like a container query.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) { return Number(this.dataset.testWidth ?? 0); },
  });
  await loadWatcherDock();
});
afterAll(() => {
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
});
beforeEach(() => {
  window.localStorage.clear();
  resetWatcherDockStore();
});

function Dock({ model, watchedId = WATCHED_ID, width = 1200 }: { model: WatcherSurfaceModel; watchedId?: string; width?: number }) {
  return (
    <WatcherContext.Provider value={model}>
      <div className="workspace-body" data-test-width={width}>
        <div className="workspace-chat-column"><WatchedByChip conversationId={watchedId} /></div>
        <WatcherDockHost watchedId={watchedId} />
      </div>
    </WatcherContext.Provider>
  );
}

function setup(options: { link?: WatcherLinkView; width?: number } = {}) {
  let current = options.link ?? link();
  const runtime = watcherRuntime({ link: () => current });
  const model = (next: WatcherLinkView) => surfaceModel({ watchers: [next], request: runtime.request });
  const view = render(<Dock model={model(current)} width={options.width} />);
  return {
    runtime,
    view,
    update(next: WatcherLinkView) {
      current = next;
      view.rerender(<Dock model={model(next)} width={options.width} />);
    },
  };
}

const dock = () => screen.findByRole("complementary", { name: "Watching Refactor parser" });

describe("WatcherDock", () => {
  it("is an aside named by its heading and controlled by the chip", async () => {
    setup();
    const aside = await dock();
    const chip = screen.getByRole("button", { name: /Watched by/u });
    expect(chip).toHaveAttribute("aria-controls", aside.id);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(within(aside).getByRole("heading", { name: "Watching Refactor parser" })).toHaveAttribute("tabindex", "-1");
  });

  it("persists collapse per watched chat", async () => {
    setup();
    await dock();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(readWatcherDock(WATCHED_ID).open).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(watcherDockStorageKey(WATCHED_ID)) ?? "{}")).toMatchObject({ open: false });
    expect(window.localStorage.getItem(watcherDockStorageKey(OTHER_WATCHED_ID))).toBeNull();
    expect(readWatcherDock(OTHER_WATCHED_ID).open).toBe(true);
    await waitFor(() => expect(document.querySelector(".watcher-dock-frame")).toHaveAttribute("hidden"));
    expect(screen.getByRole("button", { name: /Watched by/u })).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses on Escape and returns focus to the chip", async () => {
    setup();
    const aside = await dock();
    const pause = within(aside).getByRole("button", { name: "Pause" });
    pause.focus();
    fireEvent.keyDown(pause, { key: "Escape" });
    const chip = screen.getByRole("button", { name: /Watched by/u });
    expect(chip).toHaveFocus();
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves Escape to an open menu before collapsing", async () => {
    setup();
    const aside = await dock();
    fireEvent.click(within(aside).getByRole("button", { name: "More watcher actions" }));
    const menu = await screen.findByRole("menu", { name: "More watcher actions" });
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Stop watching…" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
  });

  it("resizes from the keyboard within 280 to 520 pixels and remembers the width", async () => {
    setup();
    await dock();
    const handle = screen.getByRole("separator", { name: "Resize watcher dock" });
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "352");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "520");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    await waitFor(() => expect(window.localStorage.getItem(WATCHER_DOCK_WIDTH_KEY)).toBe("280"));
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(handle).toHaveAttribute("aria-valuenow", "340");
  });

  it.each([
    [500, "sheet"],
    [1200, "inline"],
  ])("presents the dock in a %i px host as %s", async (width, presentation) => {
    setup({ width });
    await dock();
    const frame = document.querySelector(".watcher-dock-frame")!;
    expect(frame).toHaveAttribute("data-presentation", presentation);
    expect(frame.classList.contains("is-sheet")).toBe(presentation === "sheet");
  });

  it("reads the feed by request and never takes a detail subscription", async () => {
    const { runtime, update } = setup();
    await dock();
    await waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.feed.get"]));
    update(link({ counters: { ...link().counters, eventsSeen: 10 } }));
    await act(async () => { await Promise.resolve(); });
    expect(runtime.commands.filter(({ type }) => type === "watcher.feed.get")).toHaveLength(1);
    update(link({ feedRevision: 2 }));
    await waitFor(() => expect(runtime.commands.filter(({ type }) => type === "watcher.feed.get")).toHaveLength(2));
    expect(runtime.commands.some(({ type }) => type === "conversation.detail.subscription")).toBe(false);
    expect(runtime.commands.every(({ type }) => type.startsWith("watcher."))).toBe(true);
  });

  it("asks before resuming after unexplained changes and lists the paths", async () => {
    let current = link({ status: "paused", pauseReason: "write-detected" });
    const runtime = watcherRuntime({
      link: () => current,
      feed: () => [{
        wakeId: "66666666-6666-4666-8666-000000000009",
        sequence: 9,
        watcherTurnId: "watcher-turn-9",
        watchedTurnId: "watched-turn",
        trigger: "activity",
        outcome: "write-detected",
        state: "settled",
        eventsCovered: 2,
        itemsTruncated: 0,
        itemsOmitted: 0,
        guardState: "changed",
        guardPaths: ["src/parser.ts"],
        finding: null,
        delivery: null,
        createdAt: "2026-10-19T10:40:00.000Z",
        settledAt: "2026-10-19T10:41:00.000Z",
      }],
    });
    render(<Dock model={surfaceModel({ watchers: [current], request: runtime.request, shells: [shell(WATCHED_ID, "Refactor parser"), shell(link().watcherConversationId, "Watcher")] })} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Files changed that no running agent accounts for");
    await waitFor(() => expect(within(alert).getByRole("list", { name: "Changed paths" })).toHaveTextContent("src/parser.ts"));
    fireEvent.click(within(alert).getByRole("button", { name: "Resume…" }));
    expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(false);
    const confirm = within(alert).getByRole("group", { name: "Confirm resume" });
    expect(confirm).toHaveTextContent("If you edited these files yourself, resume.");
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Resume" })).toHaveFocus());
    current = link();
    fireEvent.click(within(confirm).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(true));
  });
});

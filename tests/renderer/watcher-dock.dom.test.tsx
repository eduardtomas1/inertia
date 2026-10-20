import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WatcherFeedItem, WatcherLinkView } from "../../src/shared/watcher";
import { WatchedByChip } from "../../src/renderer/src/components/watcher/WatchedByChip";
import { WatcherDockHost } from "../../src/renderer/src/components/watcher/WatcherDockHost";
import { WatcherContext, type WatcherSurfaceModel } from "../../src/renderer/src/components/watcher/watcherContext";
import { loadWatcherDock } from "../../src/renderer/src/components/watcher/watcherLoaders";
import { WATCHER_DOCK_WIDTH_KEY } from "../../src/renderer/src/components/watcher/WatcherDock";
import { TOOLTIP_DELAY_MS } from "../../src/renderer/src/components/Tooltip";
import {
  readWatcherDock,
  reportWatcherDockError,
  resetWatcherDockStore,
  watcherDockStorageKey,
} from "../../src/renderer/src/hooks/useWatcherDock";
import {
  NOW,
  OTHER_WATCHED_ID,
  WATCHED_ID,
  WATCHER_ID,
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
afterEach(() => vi.useRealTimers());

function Dock({ model, watchedId = WATCHED_ID, width = 1200, attached = true }: {
  model: WatcherSurfaceModel;
  watchedId?: string;
  width?: number;
  attached?: boolean;
}) {
  return (
    <WatcherContext.Provider value={model}>
      <div className="workspace-body" data-test-width={width}>
        <div className="workspace-chat-column">
          <div className="composer-region">
            {attached && <WatchedByChip conversationId={watchedId} />}
            <textarea aria-label="Message" />
          </div>
        </div>
        <WatcherDockHost watchedId={watchedId} />
      </div>
    </WatcherContext.Provider>
  );
}

function setup(options: { link?: WatcherLinkView; width?: number; strict?: boolean; feed?: () => WatcherFeedItem[] } = {}) {
  let current = options.link ?? link();
  const runtime = watcherRuntime({ link: () => current, feed: options.feed });
  const model = (next: WatcherLinkView | null) => surfaceModel({ watchers: next ? [next] : [], request: runtime.request });
  const tree = (next: WatcherLinkView | null) => {
    const dockTree = <Dock model={model(next)} width={options.width} attached={next !== null} />;
    return options.strict ? <StrictMode>{dockTree}</StrictMode> : dockTree;
  };
  const view = render(tree(current));
  return {
    runtime,
    view,
    update(next: WatcherLinkView | null) {
      if (next) current = next;
      view.rerender(tree(next));
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

  it("animates open and close only on the user's action, never on mount", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      setup();
      await dock();
      const frame = document.querySelector(".watcher-dock-frame")!;
      expect(frame).not.toHaveAttribute("data-motion");
      const chip = screen.getByRole("button", { name: /Watched by/u });
      fireEvent.click(chip);
      expect(frame).toHaveAttribute("data-state", "closing");
      expect(frame).toHaveAttribute("data-motion", "animate");
      await waitFor(() => expect(frame).toHaveAttribute("hidden"));
      fireEvent.click(chip);
      expect(frame).toHaveAttribute("data-state", "open");
      expect(frame).toHaveAttribute("data-motion", "animate");
    } finally {
      vi.unstubAllGlobals();
    }
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
    [650, "sheet"],
    [700, "inline"],
    [1200, "inline"],
  ])("presents the dock in a %i px host as %s (the chat keeps at least 360 px inline)", async (width, presentation) => {
    setup({ width });
    await waitFor(() => expect(document.querySelector(".watcher-dock-frame")).toHaveAttribute("data-presentation", presentation));
    const frame = document.querySelector(".watcher-dock-frame")!;
    expect(frame.classList.contains("is-sheet")).toBe(presentation === "sheet");
  });

  it("starts a sheet collapsed, opens it over a scrim and collapses it on an outside press", async () => {
    setup({ width: 500 });
    await waitFor(() => expect(document.querySelector(".watcher-dock-frame")).toHaveAttribute("data-presentation", "sheet"));
    const frame = document.querySelector(".watcher-dock-frame")!;
    const chip = screen.getByRole("button", { name: /Watched by/u });
    expect(frame).toHaveAttribute("hidden");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    // The inline preference is untouched: a sheet's collapse is layout, not a choice.
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    fireEvent.click(chip);
    expect(await dock()).toBeVisible();
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".watcher-dock-scrim")).not.toBeNull();
    // Pressing inside the sheet or on its chip keeps it open.
    fireEvent.pointerDown(within(await dock()).getByRole("heading", { name: "Watching Refactor parser" }));
    expect(chip).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Message" }));
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(document.querySelector(".watcher-dock-scrim")!);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).toHaveFocus();
  });

  it("opens a sheet the user asks for before the dock has ever mounted", async () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    setup({ width: 500 });
    expect(document.querySelector(".watcher-dock-frame")).toBeNull();
    const chip = screen.getByRole("button", { name: /Watched by/u });
    fireEvent.click(chip);
    expect(await dock()).toBeVisible();
    expect(document.querySelector(".watcher-dock-frame")).toHaveAttribute("data-presentation", "sheet");
    expect(chip).toHaveAttribute("aria-expanded", "true");
  });

  it("stops a sheet above the composer, so the composer stays usable", async () => {
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 500, width: 500, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("workspace-body")) return rect(0, 800) as DOMRect;
      if (this.classList.contains("composer-region")) return rect(660, 800) as DOMRect;
      return original.call(this);
    };
    try {
      setup({ width: 500 });
      fireEvent.click(await screen.findByRole("button", { name: /Watched by/u, expanded: false }));
      await dock();
      const frame = document.querySelector<HTMLElement>(".watcher-dock-frame")!;
      await waitFor(() => expect(frame.style.bottom).toBe("148px"));
      expect(document.querySelector<HTMLElement>(".watcher-dock-scrim")!.style.bottom).toBe("148px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("keeps the dock open when Escape only closes a tooltip", async () => {
    setup();
    const aside = await dock();
    vi.useFakeTimers();
    const collapse = within(aside).getByRole("button", { name: "Collapse" });
    fireEvent.pointerEnter(collapse, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    fireEvent.keyDown(collapse, { key: "Escape" });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    fireEvent.keyDown(collapse, { key: "Escape" });
    expect(readWatcherDock(WATCHED_ID).open).toBe(false);
  });

  it("moves focus to the composer when Stop watching removes the dock and chip", async () => {
    const { update } = setup();
    const aside = await dock();
    fireEvent.click(within(aside).getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop watching…" }));
    const stop = within(aside).getByRole("button", { name: "Stop watching" });
    stop.focus();
    fireEvent.click(stop);
    // The link detaches: the shell drops it, so dock and chip unmount.
    update(null);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("shows an error reported from the command palette when it opens", async () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    setup();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    act(() => reportWatcherDockError(WATCHED_ID, "The watcher could not be paused."));
    const aside = await dock();
    expect(await within(aside).findByRole("alert")).toHaveTextContent("The watcher could not be paused.");
  });

  it("re-enables Resume after it settles under StrictMode", async () => {
    setup({ strict: true, link: link({ status: "paused", pauseReason: "wake-budget" }) });
    const aside = await dock();
    const notice = within(aside).getByText("Paused", { selector: ".watcher-notice-title" }).closest<HTMLElement>(".watcher-notice")!;
    fireEvent.click(within(notice).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(within(notice).getByRole("button", { name: "Resume" })).not.toHaveAttribute("aria-disabled"));
  });

  it("does not offer Resume for an archived watched chat, and says why", async () => {
    const paused = link({ status: "paused", pauseReason: "watched-archived" });
    const runtime = watcherRuntime({ link: () => paused });
    render(<Dock model={surfaceModel({
      watchers: [paused],
      request: runtime.request,
      shells: [shell(WATCHED_ID, "Refactor parser", { archivedAt: NOW }), shell(WATCHER_ID, "Watcher")],
    })}
    />);
    const aside = await dock();
    expect(within(aside).getByText("Unarchive the watched chat to resume its watcher.")).toBeInTheDocument();
    expect(within(aside).getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(aside).getByRole("button", { name: "Resume" }));
    expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(false);
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

  it("does not offer Resume after a route pause while the route is still not ready", async () => {
    setup({ link: link({ status: "paused", pauseReason: "route-unavailable" }) });
    const aside = await dock();
    const notice = within(aside).getByText("Paused", { selector: ".watcher-notice-title" }).closest<HTMLElement>(".watcher-notice")!;
    expect(within(notice).queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(within(notice).getByText(/^It can resume once its route is ready\./u)).toBeInTheDocument();
  });

  it("asks before resuming after unexplained changes, focusing Cancel, and keeps focus in the dock", async () => {
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
    const model = () => surfaceModel({ watchers: [current], request: runtime.request, shells: [shell(WATCHED_ID, "Refactor parser"), shell(link().watcherConversationId, "Watcher")] });
    const view = render(<Dock model={model()} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Files changed that no running agent accounts for");
    await waitFor(() => expect(within(alert).getByRole("list", { name: "Changed paths" })).toHaveTextContent("src/parser.ts"));
    fireEvent.click(within(alert).getByRole("button", { name: "Resume…" }));
    expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(false);
    let confirm = within(alert).getByRole("group", { name: "Confirm resume" });
    expect(confirm).toHaveTextContent("If you edited these files yourself, resume.");
    // The safe choice takes focus; cancelling returns it to "Resume…".
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(alert).getByRole("button", { name: "Resume…" })).toHaveFocus());
    fireEvent.click(within(alert).getByRole("button", { name: "Resume…" }));
    confirm = within(alert).getByRole("group", { name: "Confirm resume" });
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.keyDown(within(confirm).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    await waitFor(() => expect(within(alert).getByRole("button", { name: "Resume…" })).toHaveFocus());
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    fireEvent.click(within(alert).getByRole("button", { name: "Resume…" }));
    confirm = within(alert).getByRole("group", { name: "Confirm resume" });
    const resume = within(confirm).getByRole("button", { name: "Resume" });
    resume.focus();
    current = link();
    fireEvent.click(resume);
    await waitFor(() => expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(true));
    // The notice goes away with the pause; focus lands on the dock heading.
    view.rerender(<Dock model={model()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Watching Refactor parser" })).toHaveFocus());
  });
});

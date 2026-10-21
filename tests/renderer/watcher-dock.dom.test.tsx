import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WatcherFeedItem, WatcherLinkView } from "../../src/shared/watcher";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { WATCHER_USAGE_LIMIT_DETAIL, watcherRouteUnavailableDetail } from "../../src/server/runtime/watcher/watcher-wake-runner";
import { WatcherDockHost } from "../../src/renderer/src/components/watcher/WatcherDockHost";
import { WatcherContext, type WatcherSurfaceModel } from "../../src/renderer/src/components/watcher/watcherContext";
import { loadWatcherDock } from "../../src/renderer/src/components/watcher/watcherLoaders";
import { WATCHER_DOCK_WIDTH_KEY } from "../../src/renderer/src/components/watcher/WatcherDock";
import { TOOLTIP_DELAY_MS } from "../../src/renderer/src/components/Tooltip";
import {
  readWatcherDock,
  reportWatcherDockError,
  resetWatcherDockStore,
  setWatcherDockOpen,
  watcherDockStorageKey,
} from "../../src/renderer/src/hooks/useWatcherDock";
import {
  NOW,
  OTHER_WATCHED_ID,
  WATCHED_ID,
  WATCHER_ID,
  feedItem,
  link,
  shell,
  surfaceModel,
  watcherRuntime,
} from "./watcher-fixtures";

const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

beforeAll(async () => {
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

function Dock({ model, watchedId = WATCHED_ID, width = 1200, pane = false }: {
  model: WatcherSurfaceModel;
  watchedId?: string;
  width?: number;
  pane?: boolean;
}) {
  const composer = (
    <div className="chat-workspace">
      <div className="composer-region">
        <textarea aria-label="Message" />
      </div>
    </div>
  );
  return (
    <WatcherContext.Provider value={model}>
      {pane ? (
        <div className="conversation-pane-workspace has-tools" data-test-width={width}>
          <div className="conversation-pane-chat">{composer}</div>
          <WatcherDockHost watchedId={watchedId} />
          <div className="workspace-tools-resize-handle" />
          <div className="workspace-panel" />
        </div>
      ) : (
        <div className="workspace-body" data-test-width={width}>
          <div className="workspace-chat-column">{composer}</div>
          <WatcherDockHost watchedId={watchedId} />
        </div>
      )}
    </WatcherContext.Provider>
  );
}

function setup(options: { link?: WatcherLinkView; width?: number; strict?: boolean; pane?: boolean; feed?: () => WatcherFeedItem[] } = {}) {
  let current = options.link ?? link();
  const runtime = watcherRuntime({ link: () => current, feed: options.feed });
  const model = (next: WatcherLinkView | null) => surfaceModel({ watchers: next ? [next] : [], request: runtime.request });
  const tree = (next: WatcherLinkView | null) => {
    const dockTree = <Dock model={model(next)} width={options.width} pane={options.pane} />;
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
const handle = () => screen.getByRole("button", { name: /^Open watcher/u });

describe("watcher dock", () => {
  it("is an aside named by its heading, with no handle while it is open", async () => {
    setup();
    const aside = await dock();
    expect(screen.queryByRole("button", { name: /^Open watcher/u })).not.toBeInTheDocument();
    expect(within(aside).getByRole("heading", { name: "Watching Refactor parser" })).toHaveAttribute("tabindex", "-1");
  });

  it("leaves a handle in the dock's place when collapsed, which opens it again", async () => {
    setup();
    const aside = await dock();
    fireEvent.click(within(aside).getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse" }));
    expect(handle()).toHaveAttribute("aria-controls", aside.id);
    expect(handle()).toHaveAttribute("aria-expanded", "false");
    expect(handle().closest(".watcher-dock-handle")?.parentElement).toHaveClass("workspace-body");
    const user = userEvent.setup();
    handle().focus();
    await user.keyboard("{Enter}");
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    await waitFor(() => expect(within(aside).getByRole("heading", { name: "Watching Refactor parser" })).toHaveFocus());
  });

  it("shows unseen findings on the handle as plain text and announces a new one", async () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    const { update } = setup();
    expect(handle()).toHaveAccessibleName("Open watcher");
    expect(document.querySelector(".watcher-dock-handle-new")).toBeNull();
    update(link({ latestFindingAt: NOW }));
    expect(handle()).toHaveAccessibleName("Open watcher, new");
    expect(document.querySelector('.watcher-dock-handle [role="status"]')).toHaveTextContent(/^New finding$/u);
    update(link({
      latestFindingAt: "2026-10-19T10:50:00.000Z",
      counters: { ...link().counters, findingsTotal: 2 },
    }));
    expect(document.querySelector(".watcher-dock-handle-new")).toHaveTextContent(/^2 new$/u);
    expect(handle()).toHaveAccessibleName("Open watcher, 2 new");
    expect(document.querySelector('.watcher-dock-handle [role="status"]')).toHaveTextContent(/^New finding\.$/u);
  });

  it("persists collapse per watched chat", async () => {
    setup();
    await dock();
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse" }));
    expect(readWatcherDock(WATCHED_ID).open).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(watcherDockStorageKey(WATCHED_ID)) ?? "{}")).toMatchObject({ open: false });
    expect(window.localStorage.getItem(watcherDockStorageKey(OTHER_WATCHED_ID))).toBeNull();
    expect(readWatcherDock(OTHER_WATCHED_ID).open).toBe(true);
    await waitFor(() => expect(document.querySelector(".watcher-dock-frame")).toHaveAttribute("hidden"));
    expect(handle()).toHaveAttribute("aria-expanded", "false");
  });

  it("drops the Stop watching and resume prompts when the dock collapses", async () => {
    setup({ link: link({ status: "paused", pauseReason: "write-detected" }) });
    const aside = await dock();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Resume…" }));
    fireEvent.click(within(aside).getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop watching…" }));
    expect(within(aside).getByRole("group", { name: "Confirm resume" })).toBeInTheDocument();
    expect(within(aside).getByRole("group", { name: "Stop watching" })).toBeInTheDocument();
    act(() => setWatcherDockOpen(WATCHED_ID, false));
    await waitFor(() => expect(document.querySelector(".watcher-dock-frame")).toHaveAttribute("hidden"));
    act(() => setWatcherDockOpen(WATCHED_ID, true));
    await waitFor(() => expect(document.querySelector(".watcher-dock-frame")).not.toHaveAttribute("hidden"));
    expect(within(aside).queryByRole("group", { name: "Confirm resume" })).not.toBeInTheDocument();
    expect(within(aside).queryByRole("group", { name: "Stop watching" })).not.toBeInTheDocument();
  });

  it("collapses on Escape and returns focus to the handle", async () => {
    setup();
    const aside = await dock();
    const check = within(aside).getByRole("button", { name: "Check now" });
    check.focus();
    fireEvent.keyDown(check, { key: "Escape" });
    await waitFor(() => expect(handle()).toHaveFocus());
    expect(readWatcherDock(WATCHED_ID).open).toBe(false);
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

  it("closes the More menu on Escape from its trigger and keeps the dock open", async () => {
    setup();
    const aside = await dock();
    const more = within(aside).getByRole("button", { name: "More watcher actions" });
    fireEvent.click(more);
    await screen.findByRole("menu", { name: "More watcher actions" });
    more.focus();
    fireEvent.keyDown(more, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    expect(more).toHaveFocus();
  });

  it("animates open and close only on the user's action, never on mount", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      setup();
      await dock();
      const frame = document.querySelector(".watcher-dock-frame")!;
      expect(frame).not.toHaveAttribute("data-motion");
      act(() => setWatcherDockOpen(WATCHED_ID, false));
      expect(frame).toHaveAttribute("data-state", "closing");
      expect(frame).toHaveAttribute("data-motion", "animate");
      await waitFor(() => expect(frame).toHaveAttribute("hidden"));
      fireEvent.click(handle());
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
    expect(frame).toHaveAttribute("hidden");
    expect(handle()).toHaveAttribute("aria-expanded", "false");
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    fireEvent.click(handle());
    expect(await dock()).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Open watcher/u })).not.toBeInTheDocument();
    expect(document.querySelector(".watcher-dock-scrim")).not.toBeNull();
    fireEvent.pointerDown(within(await dock()).getByRole("heading", { name: "Watching Refactor parser" }));
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Message" }));
    expect(handle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(handle());
    expect(screen.queryByRole("button", { name: /^Open watcher/u })).not.toBeInTheDocument();
    fireEvent.pointerDown(document.querySelector(".watcher-dock-scrim")!);
    await waitFor(() => expect(handle()).toHaveFocus());
  });

  it("opens a sheet the user asks for before the dock has ever mounted", async () => {
    window.localStorage.setItem(watcherDockStorageKey(WATCHED_ID), JSON.stringify({ open: false, seenAt: null }));
    setup({ width: 500 });
    expect(document.querySelector(".watcher-dock-frame")).toBeNull();
    fireEvent.click(handle());
    expect(await dock()).toBeVisible();
    expect(document.querySelector(".watcher-dock-frame")).toHaveAttribute("data-presentation", "sheet");
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
  });

  it("stops a sheet above the composer, so the composer stays usable", async () => {
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 500, width: 500, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("workspace-body")) return rect(0, 800) as DOMRect;
      if (this.classList.contains("workspace-chat-column")) return rect(0, 800) as DOMRect;
      if (this.classList.contains("composer-region")) return rect(660, 800) as DOMRect;
      return original.call(this);
    };
    try {
      setup({ width: 500 });
      fireEvent.click(await screen.findByRole("button", { name: /^Open watcher/u, expanded: false }));
      await dock();
      const frame = document.querySelector<HTMLElement>(".watcher-dock-frame")!;
      await waitFor(() => expect(frame.style.bottom).toBe("148px"));
      expect(document.querySelector<HTMLElement>(".watcher-dock-scrim")!.style.bottom).toBe("148px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("keeps a sheet above the composer when a terminal opens under the chat", async () => {
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 500, width: 500, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
    let composerTop = 660;
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("workspace-chat-column")) return rect(0, 800) as DOMRect;
      if (this.classList.contains("composer-region")) return rect(composerTop, composerTop + 140) as DOMRect;
      return original.call(this);
    };
    const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve() {}
      disconnect() { this.entry.targets = []; }
    } as unknown as typeof ResizeObserver;
    try {
      setup({ width: 500 });
      fireEvent.click(await screen.findByRole("button", { name: /^Open watcher/u, expanded: false }));
      await dock();
      const frame = document.querySelector<HTMLElement>(".watcher-dock-frame")!;
      await waitFor(() => expect(frame.style.bottom).toBe("148px"));
      composerTop = 400;
      const workspace = document.querySelector(".chat-workspace")!;
      act(() => {
        for (const { callback, targets } of observers) {
          if (targets.includes(workspace)) callback([], {} as ResizeObserver);
        }
      });
      await waitFor(() => expect(frame.style.bottom).toBe("408px"));
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver;
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("stops a split pane's sheet above the composer when the tools panel is open below the chat", async () => {
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 500, width: 500, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("conversation-pane-workspace")) return rect(0, 800) as DOMRect;
      if (this.classList.contains("conversation-pane-chat")) return rect(0, 533) as DOMRect;
      if (this.classList.contains("composer-region")) return rect(383, 533) as DOMRect;
      return original.call(this);
    };
    try {
      setup({ width: 500, pane: true });
      fireEvent.click(await screen.findByRole("button", { name: /^Open watcher/u, expanded: false }));
      await dock();
      const frame = document.querySelector<HTMLElement>(".watcher-dock-frame")!;
      await waitFor(() => expect(frame.style.bottom).toBe("158px"));
      expect(document.querySelector<HTMLElement>(".watcher-dock-scrim")!.style.bottom).toBe("158px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("loads the feed once the connection returns, without waiting for Retry", async () => {
    const runtime = watcherRuntime({ feed: () => [] });
    let reconnecting = true;
    const request = vi.fn(async (command: Parameters<typeof runtime.request>[0]) => {
      if (command.type === "watcher.feed.get" && reconnecting) throw new Error("The local service is reconnecting.");
      return runtime.request(command);
    });
    const tree = (online: boolean) => (
      <Dock model={surfaceModel({ watchers: [link()], request, online })} />
    );
    const view = render(tree(false));
    await dock();
    await act(async () => undefined);
    reconnecting = false;
    view.rerender(tree(true));
    await waitFor(() => expect(screen.getByText(/^No checks yet/u)).toBeInTheDocument());
    expect(screen.queryByText("The local service is reconnecting.")).not.toBeInTheDocument();
  });

  it("keeps the dock open when Escape only closes a tooltip", async () => {
    setup({ link: link({ status: "paused", pauseReason: "route-unavailable" }) });
    const aside = await dock();
    vi.useFakeTimers();
    const check = within(aside.querySelector<HTMLElement>(".watcher-bar-actions")!).getByRole("button", { name: "Resume" });
    fireEvent.pointerEnter(check, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    fireEvent.keyDown(check, { key: "Escape" });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(readWatcherDock(WATCHED_ID).open).toBe(true);
    fireEvent.keyDown(check, { key: "Escape" });
    expect(readWatcherDock(WATCHED_ID).open).toBe(false);
  });

  it("moves focus to the composer when Stop watching removes the dock", async () => {
    const { update } = setup();
    const aside = await dock();
    fireEvent.click(within(aside).getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop watching…" }));
    const stop = within(aside).getByRole("button", { name: "Stop watching" });
    stop.focus();
    fireEvent.click(stop);
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
    const bar = aside.querySelector<HTMLElement>(".watcher-bar")!;
    fireEvent.click(within(bar).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Resume" })).not.toHaveAttribute("aria-disabled"));
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
    expect(within(aside.querySelector<HTMLElement>(".watcher-notices")!).getByText("Unarchive the main chat to resume its watcher.")).toBeInTheDocument();
    expect(within(aside).getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(aside).getByRole("button", { name: "Resume" }));
    expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(false);
  });

  it("explains an archived watcher chat once and keeps Resume unavailable", async () => {
    const detail = "The watcher's own chat was archived. Unarchive it to resume the watcher.";
    const watching = link();
    const paused = link({ status: "paused", pauseReason: "watcher-archived", pauseDetail: detail });
    const runtime = watcherRuntime({ link: () => paused });
    const model = (current: WatcherLinkView) => surfaceModel({
      watchers: [current],
      request: runtime.request,
      shells: [shell(WATCHED_ID, "Refactor parser"), shell(WATCHER_ID, "Watcher", { archivedAt: NOW })],
    });
    const view = render(<Dock model={model(watching)} />);
    const aside = await dock();
    view.rerender(<Dock model={model(paused)} />);
    expect(within(aside.querySelector<HTMLElement>(".watcher-notices")!).getAllByText(detail)).toHaveLength(1);
    expect(aside.querySelector(".watcher-notice-blocked")).toBeNull();
    const resume = within(aside).getByRole("button", { name: "Resume" });
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(resume).toHaveAccessibleDescription(detail);
    fireEvent.click(resume);
    expect(runtime.commands.some(({ type }) => type === "watcher.resume")).toBe(false);
    const announced = aside.querySelector('.watcher-bar [role="status"]')!.textContent ?? "";
    expect(announced).toMatch(/^Paused\. /u);
    expect(announced).not.toContain("You paused it.");
  });

  it("keeps Resume unavailable while the watched chat is archived, whatever the pause reason", async () => {
    const paused = link({ status: "paused", pauseReason: "user" });
    const runtime = watcherRuntime({ link: () => paused });
    render(<Dock model={surfaceModel({
      watchers: [paused],
      request: runtime.request,
      shells: [shell(WATCHED_ID, "Refactor parser", { archivedAt: NOW }), shell(WATCHER_ID, "Watcher")],
    })}
    />);
    const aside = await dock();
    expect(within(aside.querySelector<HTMLElement>(".watcher-notices")!).getByText("Unarchive the main chat to resume its watcher.")).toBeInTheDocument();
    const resume = within(aside).getByRole("button", { name: "Resume" });
    expect(resume).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(resume);
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
    const notice = aside.querySelector<HTMLElement>(".watcher-notice")!;
    expect(within(notice).queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(notice.querySelector(".watcher-notice-blocked")).not.toBeNull();
    expect(within(aside.querySelector<HTMLElement>(".watcher-bar")!).getByRole("button", { name: "Resume" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  for (const [reason, detail] of [
    ["usage-limit", WATCHER_USAGE_LIMIT_DETAIL],
    ["route-unavailable", watcherRouteUnavailableDetail(providerNativeModelSelection({ providerId: "codex" }), "Codex is not signed in.")],
  ] as const) {
    it(`says once when a ${reason} pause can resume`, async () => {
      setup({ link: link({ status: "paused", pauseReason: reason, pauseDetail: detail }) });
      const notice = (await dock()).querySelector<HTMLElement>(".watcher-notice")!;
      expect(notice).toHaveTextContent(detail);
      expect(notice.textContent?.match(/resume once (?:its|the) route is ready/giu)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(notice.querySelector(".watcher-notice-blocked")?.textContent).not.toMatch(/resume/iu);
    });
  }

  it("says a custom backend sees only what each check sends, and only for a custom backend", async () => {
    const runtime = watcherRuntime();
    const watcherShell = shell(WATCHER_ID, "Watcher", {
      modelSelection: { ...shell(WATCHER_ID, "Watcher").modelSelection, backendProfileId: "custom-profile" },
    });
    const profile = { id: "custom-profile", source: "custom" } as WatcherSurfaceModel["backendProfiles"][number];
    const model = (source: "custom" | "built-in") => surfaceModel({
      request: runtime.request,
      shells: [shell(WATCHED_ID, "Refactor parser"), watcherShell],
      backendProfiles: [{ ...profile, source } as WatcherSurfaceModel["backendProfiles"][number]],
    });
    const view = render(<Dock model={model("custom")} />);
    const notice = (await dock()).querySelector(".watcher-notice.is-quiet");
    expect(notice).toHaveTextContent(/^Custom backend: it sees only what each check sends\.$/u);
    view.rerender(<Dock model={model("built-in")} />);
    expect(document.querySelector(".watcher-notice.is-quiet")).toBeNull();
  });

  it("names each unexplained path once in the write-detected banner", async () => {
    setup({
      link: link({
        status: "paused",
        pauseReason: "write-detected",
        pauseDetail: "Files changed during a check, and no running agent accounts for them: src/parser.ts.",
      }),
      feed: () => [feedItem(9, { outcome: "write-detected", guardState: "changed", guardPaths: ["src/parser.ts"] })],
    });
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(within(alert).getByRole("list", { name: "Changed paths" })).toHaveTextContent("src/parser.ts"));
    expect(alert.textContent?.match(/src\/parser\.ts/gu)).toHaveLength(1);
    expect(alert.textContent?.match(/no running agent accounts for/gu)).toHaveLength(1);
  });

  it("keeps the runtime's explanation when no changed path is listed", async () => {
    const detail = "Files changed during a check, and no running agent accounts for them.";
    setup({ link: link({ status: "paused", pauseReason: "write-detected", pauseDetail: detail }) });
    expect(await screen.findByRole("alert")).toHaveTextContent(detail);
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
        resolvedBySequence: null,
        commandsDeclined: 0,
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
    view.rerender(<Dock model={model()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Watching Refactor parser" })).toHaveFocus());
  });
});

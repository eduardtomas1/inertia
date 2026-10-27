import { afterEach, describe, expect, it, vi } from "vitest";

const { electronState, pageTools } = await vi.hoisted(async () => {
  const support = await import("./support/preview-broker-harness");
  return {
    electronState: support.createPreviewBrokerElectronState(),
    pageTools: support.createPreviewBrokerPageTools(),
  };
});

vi.mock("electron", async () => (
  (await import("./support/preview-broker-harness")).createPreviewBrokerElectronMock(electronState)
));
vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewAgentApprovalRegistry } from "../../src/main/preview-agent-approvals";
import { PreviewBroker } from "../../src/main/preview-broker";
import type { PreviewTab } from "../../src/main/preview-tab";
import {
  agentDeviceMetricsOverride,
  agentEmulatedMedia,
  agentPageViewPoint,
  agentViewportActivityLabel,
  agentViewportLayout,
  agentViewportState,
  nextAgentViewport,
} from "../../src/main/preview-agent-viewport";
import {
  MAX_AGENT_BROWSER_IMAGE_EDGE,
  parseAgentBrowserResult,
  type AgentBrowserCommand,
} from "../../src/shared/agent-browser";
import { parseAgentBrowserApproval } from "../../src/shared/agent-browser-approval";
import {
  connectionId,
  conversationId,
  createPreviewBrokerHarness,
  runIdentity,
  SCREENSHOT_PNG_BASE64,
} from "./support/preview-broker-harness";

const owner = { ownerId: "primary", contextId: conversationId, connectionId };
const desktop = { width: 1_280, height: 800, mobile: false };
const outsideMessage = "That control is outside the visible part of the page. Scroll it into view with inertia_browser_scroll and its ref, then try again.";
const changedMessage = "The Browser page layout changed during this action. Take a new inertia_browser_snapshot for current refs.";
const defaultTarget = {
  found: true, blocked: false, disabled: false, editable: true, label: "Run checks", x: 42, y: 28,
};

afterEach(() => {
  pageTools.locateAgentPageRef.mockResolvedValue(defaultTarget);
  electronState.visualViewport = {
    pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, clientWidth: 1_280, clientHeight: 800, scale: 1, zoom: 1,
  };
  electronState.screenshotData = SCREENSHOT_PNG_BASE64;
});

async function shownBrowser(bounds = { x: 100, y: 50, width: 600, height: 500 }) {
  const contentsOffset = electronState.contents.length;
  const emulationOffset = electronState.emulation.length;
  const created = createPreviewBrokerHarness(PreviewBroker);
  created.broker.connect(owner);
  created.broker.setBounds({ ...owner, bounds });
  await created.broker.navigate({ ...owner, url: "http://127.0.0.1:3000/" });
  const contents = electronState.contents[contentsOffset]!;
  return {
    ...created,
    contents,
    view: () => Reflect.get(created.children.at(-1)!, "bounds") as Record<string, number>,
    emulation: () => electronState.emulation.slice(emulationOffset),
  };
}

function lastPublished(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return send.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe("agent Browser viewport geometry", () => {
  it("keeps today's stage-sized page in fit mode and the parked size without a panel", () => {
    const stage = { x: 10, y: 20, width: 600, height: 500 };
    expect(agentViewportLayout(stage, null)).toEqual({ bounds: stage, scale: 1 });
    expect(agentViewportLayout(null, null)).toEqual({ bounds: { x: 0, y: 0, width: 1_280, height: 800 }, scale: 1 });
    expect(agentViewportLayout(null, { width: 375, height: 812, mobile: true }))
      .toEqual({ bounds: { x: 0, y: 0, width: 375, height: 812 }, scale: 1 });
  });

  it("fits a fixed viewport into the stage, centred, and never enlarges it", () => {
    expect(agentViewportLayout({ x: 100, y: 50, width: 600, height: 500 }, desktop))
      .toEqual({ bounds: { x: 100, y: 112, width: 600, height: 375 }, scale: 0.46875 });
    expect(agentViewportLayout({ x: 0, y: 0, width: 600, height: 500 }, { width: 375, height: 812, mobile: true }))
      .toEqual({ bounds: { x: 184, y: 0, width: 231, height: 500 }, scale: 231 / 375 });
    expect(agentViewportLayout({ x: 0, y: 0, width: 1_600, height: 1_000 }, desktop))
      .toEqual({ bounds: { x: 160, y: 100, width: 1_280, height: 800 }, scale: 1 });
    const tiny = agentViewportLayout({ x: 0, y: 0, width: 600, height: 1 }, { width: 375, height: 812, mobile: true });
    expect(tiny.bounds.width).toBeGreaterThanOrEqual(1);
    expect(tiny.bounds.height).toBe(1);
  });

  it("applies presets, custom sizes and colour schemes as one setting", () => {
    const fit = { viewport: null, colorScheme: "system" as const };
    expect(nextAgentViewport(fit, { preset: "desktop" })).toEqual({ viewport: desktop, colorScheme: "system" });
    expect(nextAgentViewport(fit, { preset: "tablet" })).toEqual({ viewport: { width: 768, height: 1_024, mobile: true }, colorScheme: "system" });
    expect(nextAgentViewport(fit, { preset: "mobile", colorScheme: "dark" }))
      .toEqual({ viewport: { width: 375, height: 812, mobile: true }, colorScheme: "dark" });
    expect(nextAgentViewport(fit, { width: 1_024, height: 640 })).toEqual({ viewport: { width: 1_024, height: 640, mobile: false }, colorScheme: "system" });
    expect(nextAgentViewport({ viewport: desktop, colorScheme: "light" }, { colorScheme: "dark" }))
      .toEqual({ viewport: desktop, colorScheme: "dark" });
    expect(nextAgentViewport({ viewport: desktop, colorScheme: "dark" }, { preset: "fit" }))
      .toEqual({ viewport: null, colorScheme: "dark" });
  });

  it("reports the stage size in fit mode and the chosen size otherwise", () => {
    expect(agentViewportState({ viewport: null, colorScheme: "system", bounds: { x: 4, y: 5, width: 640, height: 480 } }))
      .toEqual({ width: 640, height: 480, fit: true, mobile: false, colorScheme: "system" });
    expect(agentViewportState({ viewport: null, colorScheme: "dark", bounds: null }))
      .toEqual({ width: 1_280, height: 800, fit: true, mobile: false, colorScheme: "dark" });
    expect(agentViewportState({ viewport: { width: 375, height: 812, mobile: true }, colorScheme: "light", bounds: null }))
      .toEqual({ width: 375, height: 812, fit: false, mobile: true, colorScheme: "light" });
  });

  it("builds the CDP emulation without touch, zoom or a resized widget", () => {
    expect(agentDeviceMetricsOverride({ width: 375, height: 812, mobile: true }, 0.5)).toEqual({
      width: 375, height: 812, deviceScaleFactor: 0, mobile: true, scale: 0.5,
      screenWidth: 375, screenHeight: 812, dontSetVisibleSize: true,
    });
    expect(agentEmulatedMedia("dark")).toEqual({ features: [{ name: "prefers-color-scheme", value: "dark" }] });
    expect(agentEmulatedMedia("system")).toEqual({ features: [] });
  });

  it("maps CSS points through the page scale and refuses points outside the view", () => {
    const map = { scale: 0.5, offsetX: 10, offsetY: 20, width: 300, height: 200 };
    expect(agentPageViewPoint(map, 50, 60)).toEqual({ x: 20, y: 20 });
    expect(agentPageViewPoint(map, 9, 60)).toBeNull();
    expect(agentPageViewPoint(map, 610, 60)).toBeNull();
    expect(agentPageViewPoint(map, 50, 420)).toBeNull();
    expect(agentPageViewPoint(map, Number.NaN, 60)).toBeNull();
  });

  it("labels viewport activity without page text", () => {
    const state = (fit: boolean) => ({ width: 1_280, height: 800, fit, mobile: false, colorScheme: "dark" as const });
    expect(agentViewportActivityLabel({ preset: "desktop" }, state(false))).toBe("Agent set the viewport to 1280×800");
    expect(agentViewportActivityLabel({ preset: "fit" }, state(true))).toBe("Agent fitted the viewport to the panel");
    expect(agentViewportActivityLabel({ colorScheme: "dark" }, state(true))).toBe("Agent set the dark colour scheme");
    expect(agentViewportActivityLabel({ colorScheme: "system" }, { ...state(true), colorScheme: "system" }))
      .toBe("Agent restored the system colour scheme");
  });
});

describe("agent Browser viewport in the broker", () => {
  it("sets a desktop viewport inside a narrow panel and reports it in every result and published state", async () => {
    const { broker, contents, view, emulation, window } = await shownBrowser();
    const resized = await broker.perform(runIdentity, { action: "resize", preset: "desktop" });

    expect(resized).toMatchObject({
      ok: true,
      state: {
        viewport: { width: 1_280, height: 800, fit: false, mobile: false, colorScheme: "system" },
        activity: { action: "resize", label: "Agent set the viewport to 1280×800" },
      },
    });
    expect(parseAgentBrowserResult(resized)).toEqual(resized);
    if (resized.ok) expect(JSON.parse(resized.text)).toMatchObject({ note: expect.stringContaining("snapshot") });
    expect(view()).toEqual({ x: 100, y: 112, width: 600, height: 375 });
    expect(emulation()).toEqual([{
      contentsId: contents.id,
      method: "Emulation.setDeviceMetricsOverride",
      params: agentDeviceMetricsOverride(desktop, 0.46875),
    }]);
    expect(lastPublished(window.webContents.send)).toMatchObject({
      viewport: { width: 1_280, height: 800, fit: false },
    });
    expect(broker.connect(owner).viewport).toEqual({ width: 1_280, height: 800, fit: false, mobile: false, colorScheme: "system" });
    await expect(broker.perform(runIdentity, { action: "tabs" }))
      .resolves.toMatchObject({ state: { viewport: { width: 1_280, fit: false } } });
  });

  it("reports the panel size while the viewport fits the panel", async () => {
    const { broker, emulation } = await shownBrowser({ x: 0, y: 0, width: 640, height: 480 });
    await expect(broker.perform(runIdentity, { action: "tabs" })).resolves.toMatchObject({
      state: { viewport: { width: 640, height: 480, fit: true, mobile: false, colorScheme: "system" } },
    });
    expect(emulation()).toEqual([]);
  });

  it("re-sends the override with the new scale when the panel resizes and invalidates in-flight clicks", async () => {
    const { broker, contents, children, view, emulation } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop" });

    let cursorStarted = (): void => undefined;
    let releaseCursor = (): void => undefined;
    const started = new Promise<void>((resolve) => { cursorStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCursor = resolve; });
    pageTools.showAgentPageCursor.mockImplementationOnce(async () => {
      cursorStarted();
      await blocked;
    });
    const click = broker.perform(runIdentity, { action: "click", ref: "e1" });
    await started;
    broker.setBounds({ ...owner, bounds: { x: 100, y: 50, width: 300, height: 500 } });
    releaseCursor();

    await expect(click).resolves.toEqual({ ok: false, code: "not-found", message: changedMessage });
    expect(children.at(-1)!.webContents.sentInputs).toEqual([]);
    expect(view()).toEqual({ x: 100, y: 206, width: 300, height: 188 });
    await vi.waitFor(() => expect(emulation().at(-1)).toEqual({
      contentsId: contents.id,
      method: "Emulation.setDeviceMetricsOverride",
      params: agentDeviceMetricsOverride(desktop, 300 / 1_280),
    }));
  });

  it("invalidates an in-flight click when the viewport changes even if the panel does not", async () => {
    const { broker, children } = await shownBrowser();
    let cursorStarted = (): void => undefined;
    let releaseCursor = (): void => undefined;
    const started = new Promise<void>((resolve) => { cursorStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCursor = resolve; });
    pageTools.showAgentPageCursor.mockImplementationOnce(async () => {
      cursorStarted();
      await blocked;
    });
    const click = broker.perform(runIdentity, { action: "click", ref: "e1" });
    await started;
    await broker.command({ ...owner, action: "viewport", viewport: { preset: "mobile" } });
    releaseCursor();

    await expect(click).resolves.toEqual({ ok: false, code: "not-found", message: changedMessage });
    expect(children.at(-1)!.webContents.sentInputs).toEqual([]);
  });

  it("sends clicks and hover in view coordinates and keeps them attributed to the agent", async () => {
    const { broker, contents } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop" });
    pageTools.locateAgentPageRef.mockResolvedValue({ ...defaultTarget, x: 1_230, y: 720 });

    await expect(broker.perform(runIdentity, { action: "click", ref: "e1" })).resolves.toMatchObject({
      ok: true,
      state: { activity: { action: "click", x: 1_230, y: 720 } },
    });
    expect(contents.sentInputs).toEqual([
      { type: "mouseMove", x: 576.5625, y: 337.5 },
      { type: "mouseDown", x: 576.5625, y: 337.5, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 576.5625, y: 337.5, button: "left", clickCount: 1 },
    ]);
    expect(pageTools.showAgentPageCursor).toHaveBeenLastCalledWith(expect.anything(), 1_230, 720, "Agent click");
    await expect(broker.perform(runIdentity, { action: "tabs" })).resolves.not.toHaveProperty("state.controller");
  });

  it("follows the page's own zoom when it maps a click", async () => {
    const { broker, contents } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "mobile" });
    electronState.visualViewport = {
      pageX: 0, pageY: 0, offsetX: 20, offsetY: 10, clientWidth: 1_260, clientHeight: 2_728, scale: 0.5, zoom: 1,
    };
    pageTools.locateAgentPageRef.mockResolvedValue({ ...defaultTarget, x: 330, y: 320 });

    await expect(broker.perform(runIdentity, { action: "click", ref: "e1" })).resolves.toMatchObject({ ok: true });
    const scale = 231 / 375 * 0.5;
    expect(contents.sentInputs[1]).toEqual({
      type: "mouseDown", x: (330 - 20) * scale, y: (320 - 10) * scale, button: "left", clickCount: 1,
    });
  });

  it("refuses a click outside the visible viewport before any input reaches the page", async () => {
    const { broker, contents } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop" });
    pageTools.locateAgentPageRef.mockResolvedValue({ ...defaultTarget, x: 1_290, y: 720 });

    await expect(broker.perform(runIdentity, { action: "click", ref: "e1" }))
      .resolves.toEqual({ ok: false, code: "not-found", message: outsideMessage });
    expect(contents.sentInputs).toEqual([]);
  });

  it("wheels at the centre of the fitted view", async () => {
    const { broker, contents } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop" });
    await expect(broker.perform(runIdentity, { action: "scroll", deltaY: 300 })).resolves.toMatchObject({ ok: true });
    expect(contents.sentInputs).toEqual([{ type: "mouseWheel", x: 300, y: 187, deltaX: 0, deltaY: 300 }]);
  });

  it("lays a parked chat's page out at the chosen size with no scaling", async () => {
    const contentsOffset = electronState.contents.length;
    const emulationOffset = electronState.emulation.length;
    const { broker, children } = createPreviewBrokerHarness(PreviewBroker);
    await broker.perform(runIdentity, { action: "navigate", url: "http://127.0.0.1:3000/headless" });
    await expect(broker.perform(runIdentity, { action: "resize", preset: "mobile" })).resolves.toMatchObject({
      ok: true,
      state: { viewport: { width: 375, height: 812, fit: false, mobile: true } },
    });
    expect(Reflect.get(children[0]!, "bounds")).toEqual({ x: 0, y: 0, width: 375, height: 812 });
    expect(Reflect.get(children[0]!, "visible")).toBe(false);
    expect(electronState.emulation.slice(emulationOffset)).toEqual([{
      contentsId: electronState.contents[contentsOffset]!.id,
      method: "Emulation.setDeviceMetricsOverride",
      params: agentDeviceMetricsOverride({ width: 375, height: 812, mobile: true }, 1),
    }]);
  });

  it("re-applies the viewport after a debugger re-attach and to tabs opened later", async () => {
    const { broker, contents, emulation } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop", colorScheme: "dark" });
    const applied = [
      { method: "Emulation.setDeviceMetricsOverride", params: agentDeviceMetricsOverride(desktop, 0.46875) },
      { method: "Emulation.setEmulatedMedia", params: agentEmulatedMedia("dark") },
    ];
    expect(emulation()).toEqual(applied.map((call) => ({ contentsId: contents.id, ...call })));

    contents.debugger.attached = false;
    await expect(broker.perform(runIdentity, { action: "click", ref: "e1" })).resolves.toMatchObject({ ok: true });
    expect(emulation().slice(2)).toEqual(applied.map((call) => ({ contentsId: contents.id, ...call })));

    const opened = await broker.perform(runIdentity, { action: "tab-open", url: "http://127.0.0.1:3000/later" });
    expect(opened).toMatchObject({ ok: true });
    const later = electronState.contents.at(-1)!;
    expect(later).not.toBe(contents);
    expect(emulation().filter((call) => call.contentsId === later.id))
      .toEqual(applied.map((call) => ({ contentsId: later.id, ...call })));
  });

  it("attaches a loaded tab that lost its debugger so the user sees the agent's layout", async () => {
    const { broker, contents, emulation } = await shownBrowser();
    contents.debugger.attached = false;
    await broker.perform(runIdentity, { action: "resize", preset: "tablet" });
    expect(contents.debugger.attached).toBe(true);
    expect(emulation()).toEqual([{
      contentsId: contents.id,
      method: "Emulation.setDeviceMetricsOverride",
      params: agentDeviceMetricsOverride({ width: 768, height: 1_024, mobile: true }, 375 / 768),
    }]);
  });

  it("re-attaches a tab that lost its debugger when the user navigates it under a fixed viewport", async () => {
    const { broker, contents, emulation } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop" });
    const applied = emulation().length;
    contents.debugger.attached = false;

    contents.setURL("http://127.0.0.1:3000/#section");
    contents.emit("did-navigate-in-page", {}, "http://127.0.0.1:3000/#section", true);
    contents.setURL("https://example.com/");
    contents.emit("did-navigate", {}, "https://example.com/");
    contents.setURL("about:blank");
    contents.emit("did-navigate", {}, "about:blank");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(contents.debugger.attached).toBe(false);
    expect(emulation()).toHaveLength(applied);

    contents.setURL("http://127.0.0.1:3000/next");
    contents.emit("did-navigate", {}, "http://127.0.0.1:3000/next");
    await vi.waitFor(() => expect(emulation().slice(applied)).toEqual([{
      contentsId: contents.id,
      method: "Emulation.setDeviceMetricsOverride",
      params: agentDeviceMetricsOverride(desktop, 0.46875),
    }]));
    expect(contents.debugger.attached).toBe(true);
  });

  it("leaves a fit-mode tab's debugger alone when the user navigates it", async () => {
    const { contents, emulation } = await shownBrowser();
    contents.debugger.attached = false;
    contents.setURL("http://127.0.0.1:3000/next");
    contents.emit("did-navigate", {}, "http://127.0.0.1:3000/next");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(contents.debugger.attached).toBe(false);
    expect(emulation()).toEqual([]);
  });

  it("clears the override and media when the viewport returns to fit and the system scheme", async () => {
    const { broker, contents, view, emulation } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop", colorScheme: "light" });
    await expect(broker.perform(runIdentity, { action: "resize", preset: "fit", colorScheme: "system" }))
      .resolves.toMatchObject({ state: { viewport: { width: 600, height: 500, fit: true, colorScheme: "system" } } });
    expect(view()).toEqual({ x: 100, y: 50, width: 600, height: 500 });
    expect(emulation().slice(2)).toEqual([
      { contentsId: contents.id, method: "Emulation.clearDeviceMetricsOverride" },
      { contentsId: contents.id, method: "Emulation.setEmulatedMedia", params: { features: [] } },
    ]);
  });

  it("changes only the colour scheme when asked for a scheme alone", async () => {
    const { broker, contents, emulation } = await shownBrowser();
    await expect(broker.perform(runIdentity, { action: "resize", colorScheme: "dark" })).resolves.toMatchObject({
      ok: true,
      state: {
        viewport: { width: 600, height: 500, fit: true, colorScheme: "dark" },
        activity: { label: "Agent set the dark colour scheme" },
      },
    });
    expect(emulation()).toEqual([
      { contentsId: contents.id, method: "Emulation.setEmulatedMedia", params: agentEmulatedMedia("dark") },
    ]);
  });

  it("lets the user choose the viewport through the validated preview command", async () => {
    const { broker, contents, view, emulation, window } = await shownBrowser();
    const chosen = await broker.command({ ...owner, action: "viewport", viewport: { width: 1_024, height: 768 } });
    expect(chosen.viewport).toEqual({ width: 1_024, height: 768, fit: false, mobile: false, colorScheme: "system" });
    expect(lastPublished(window.webContents.send)).toMatchObject({ viewport: { width: 1_024, height: 768 } });
    expect(view()).toEqual({ x: 100, y: 75, width: 600, height: 450 });
    await vi.waitFor(() => expect(emulation()).toEqual([{
      contentsId: contents.id,
      method: "Emulation.setDeviceMetricsOverride",
      params: agentDeviceMetricsOverride({ width: 1_024, height: 768, mobile: false }, 600 / 1_024),
    }]));

    for (const viewport of [
      { preset: "huge" },
      { width: 100, height: 768 },
      { width: 1_024, height: 768, mobile: true },
      { preset: "fit", width: 1_024 },
      undefined,
    ]) {
      expect((await broker.command({ ...owner, action: "viewport", viewport })).viewport)
        .toEqual({ width: 1_024, height: 768, fit: false, mobile: false, colorScheme: "system" });
    }
    expect(emulation()).toHaveLength(1);
    await expect(broker.perform(runIdentity, { action: "tabs" }))
      .resolves.toMatchObject({ state: { viewport: { width: 1_024, height: 768 } } });
  });
});

describe("agent Browser screenshots", () => {
  it("captures the visible page through CDP at CSS resolution and returns the bounded PNG", async () => {
    const { broker, contents } = await shownBrowser();
    await broker.perform(runIdentity, { action: "resize", preset: "desktop" });
    electronState.visualViewport = {
      pageX: 0, pageY: 300, offsetX: 0, offsetY: 0, clientWidth: 1_280, clientHeight: 800, scale: 1, zoom: 1,
    };
    const screenshot = await broker.perform(runIdentity, { action: "screenshot" });

    expect(screenshot).toMatchObject({
      ok: true,
      image: { mimeType: "image/png", data: SCREENSHOT_PNG_BASE64, width: 4, height: 3 },
      state: { activity: { action: "screenshot" }, viewport: { width: 1_280 } },
    });
    expect(parseAgentBrowserResult(screenshot)).toEqual(screenshot);
    if (screenshot.ok) {
      expect(JSON.parse(screenshot.text)).toEqual({
        captured: true, tabId: screenshot.state.activeTabId, url: "http://127.0.0.1:3000", width: 4, height: 3,
      });
    }
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 300, width: 1_280, height: 800, scale: 0.5 },
    });
    expect(contents.capturePage).not.toHaveBeenCalled();
    const methods = contents.debugger.sendCommand.mock.calls.map(([method, params]) => (
      method === "Page.setWebLifecycleState" ? `${method}:${String(params?.state)}` : method
    ));
    const capture = methods.lastIndexOf("Page.captureScreenshot");
    expect(methods.lastIndexOf("Page.setWebLifecycleState:frozen")).toBeLessThan(capture);
    expect(methods.lastIndexOf("Page.setWebLifecycleState:active")).toBeGreaterThan(capture);
  });

  it("caps the long edge of large pages and captures zoomed-out pages at their shown size", async () => {
    const { broker, contents } = await shownBrowser();
    electronState.visualViewport = {
      pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, clientWidth: 2_560, clientHeight: 1_600, scale: 1, zoom: 1,
    };
    await broker.perform(runIdentity, { action: "screenshot" });
    const captures = () => contents.debugger.sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot");
    expect(captures().at(-1)?.[1]).toEqual({
      format: "png",
      clip: { x: 0, y: 0, width: 2_560, height: 1_600, scale: (MAX_AGENT_BROWSER_IMAGE_EDGE / 2_560) / 2 },
    });
    electronState.visualViewport = {
      pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, clientWidth: 1_260, clientHeight: 2_728, scale: 375 / 1_260, zoom: 1,
    };
    await broker.perform(runIdentity, { action: "screenshot" });
    expect(captures().at(-1)?.[1]).toEqual({
      format: "png",
      clip: { x: 0, y: 0, width: 1_260, height: 2_728, scale: (375 / 1_260) / 2 },
    });
  });

  it("shrinks a capture that is still larger than the image bounds", async () => {
    const { broker } = await shownBrowser();
    const oversized = Buffer.from(SCREENSHOT_PNG_BASE64, "base64");
    oversized.writeUInt32BE(3_000, 16);
    oversized.writeUInt32BE(2_000, 20);
    electronState.screenshotData = oversized.toString("base64");

    const screenshot = await broker.perform(runIdentity, { action: "screenshot" });
    expect(screenshot).toMatchObject({
      ok: true,
      image: {
        data: Buffer.from("bounded-png").toString("base64"),
        width: MAX_AGENT_BROWSER_IMAGE_EDGE,
        height: Math.floor(2_000 * (MAX_AGENT_BROWSER_IMAGE_EDGE / 3_000)),
      },
    });
    expect(parseAgentBrowserResult(screenshot)).toEqual(screenshot);
  });

  it("still withholds the image when the page shows a secret", async () => {
    const { broker } = await shownBrowser();
    pageTools.agentPageHasSensitiveScreenshotEvidence.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const screenshot = await broker.perform(runIdentity, { action: "screenshot" });
    expect(screenshot).toMatchObject({ ok: false, code: "sensitive" });
    expect(screenshot).not.toHaveProperty("image");
  });
});

describe("agent Browser viewport approvals", () => {
  function approvalFixture() {
    const tab = {
      id: crypto.randomUUID(), documentSequence: 1, pageNumber: 3,
      view: { webContents: {
        getURL: () => "http://localhost:3000/", isDestroyed: () => false, isLoadingMainFrame: () => false,
      } },
    } as unknown as PreviewTab;
    const scope = { activeTabId: tab.id, tabs: new Map([[tab.id, tab]]) };
    const registry = new PreviewAgentApprovalRegistry();
    return async (command: AgentBrowserCommand) => {
      const text = await registry.resolve(
        { action: "prepare-approval", command },
        runIdentity,
        scope,
        async () => ({ found: true }),
      );
      return typeof text === "string" ? parseAgentBrowserApproval(text)?.detail : null;
    };
  }

  it.each([
    [{ action: "resize", preset: "desktop" }, "Set the Browser viewport to 1280×800 desktop"],
    [{ action: "resize", preset: "tablet" }, "Set the Browser viewport to 768×1024 tablet"],
    [{ action: "resize", width: 1_440, height: 900 }, "Set the Browser viewport to 1440×900 desktop"],
    [{ action: "resize", preset: "fit" }, "Fit the Browser viewport to the panel"],
    [{ action: "resize", colorScheme: "dark" }, "Use the dark colour scheme"],
    [{ action: "resize", preset: "mobile", colorScheme: "light" }, "Set the Browser viewport to 375×812 mobile\nUse the light colour scheme"],
    [{ action: "screenshot" }, "Browser tab 3\nSend a screenshot of the Browser page to the agent"],
  ] as const)("describes %j in its approval", async (command, detail) => {
    await expect(approvalFixture()(command as AgentBrowserCommand)).resolves.toBe(detail);
  });

  it("prepares and performs approved resize and screenshot commands through the broker", async () => {
    const { broker } = await shownBrowser();
    for (const command of [{ action: "resize", preset: "desktop" }, { action: "screenshot" }] as const) {
      const prepared = await broker.perform(runIdentity, { action: "prepare-approval", command });
      expect(prepared.ok).toBe(true);
      const approval = prepared.ok ? parseAgentBrowserApproval(prepared.text) : null;
      expect(approval).not.toBeNull();
      await expect(broker.perform(runIdentity, { action: "perform-approved", token: approval!.token }))
        .resolves.toMatchObject({ ok: true, state: { viewport: { width: 1_280, fit: false } } });
    }
  });
});

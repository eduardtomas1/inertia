import { runInNewContext } from "node:vm";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_AGENT_BROWSER_TEXT_BYTES, parseAgentBrowserResult } from "../../src/shared/agent-browser";

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
vi.mock("../../src/main/preview-agent-page", async (importOriginal) => ({
  ...pageTools,
  PRIVACY_RUNTIME: (await importOriginal<typeof import("../../src/main/preview-agent-page")>()).PRIVACY_RUNTIME,
}));

import { PreviewBroker } from "../../src/main/preview-broker";
import {
  connectionId,
  conversationId,
  createPreviewBrokerHarness,
  runIdentity,
} from "./support/preview-broker-harness";

const shippingTarget = {
  found: true, blocked: false, disabled: false, editable: false,
  sensitive: false, role: "select", label: "Shipping", x: 120, y: 64,
};

async function loadedHarness() {
  const contentsOffset = electronState.contents.length;
  const sessionOffset = electronState.sessions.length;
  const created = createPreviewBrokerHarness(PreviewBroker);
  await created.broker.navigate({
    ownerId: "primary",
    contextId: conversationId,
    url: "http://127.0.0.1:3000/",
  });
  return {
    ...created,
    contents: electronState.contents[contentsOffset]!,
    browserSession: electronState.sessions[sessionOffset]!,
  };
}

interface FakeOption { value: string; label: string; disabled?: boolean; parentElement?: unknown }

function selectPage(
  contents: object,
  options: FakeOption[],
  overrides: Record<string, unknown> = {},
  passwordValues: string[] = [],
) {
  const events: Array<{ type: string; bubbles: boolean }> = [];
  const document = {};
  const select: Record<string, unknown> = {
    tagName: "SELECT",
    isConnected: true,
    multiple: false,
    disabled: false,
    ownerDocument: document,
    getRootNode: () => document,
    parentElement: null,
    getAttribute: () => null,
    matches: () => false,
    options: options.map((option) => ({ disabled: false, parentElement: null, ...option })),
    selectedIndex: 0,
    dispatchEvent: (event: Event) => {
      events.push({ type: event.type, bubbles: event.bubbles });
      return true;
    },
    ...overrides,
  };
  const context = {
    document,
    Event,
    __inertiaAgentBrowser: {
      privacyGuardInstalled: true,
      refs: new Map([["e4", select]]),
      passwordValues: new Set(passwordValues),
      passwordNodes: new WeakSet(),
    },
  };
  const page = contents as unknown as {
    executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>): Promise<unknown>;
  };
  const original = page.executeJavaScriptInIsolatedWorld.bind(page);
  const scripts: string[] = [];
  vi.spyOn(page, "executeJavaScriptInIsolatedWorld").mockImplementation(async (world, code) => {
    if (!code[0]?.code.includes("element.selectedIndex = index")) return await original(world, code);
    scripts.push(code[0].code);
    return runInNewContext(code[0].code, context);
  });
  return { select, events, scripts };
}

function detail(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { text: string }).text) as Record<string, unknown>;
}

beforeEach(() => {
  pageTools.locateAgentPageRef.mockReset();
  pageTools.locateAgentPageRef.mockResolvedValue({
    found: true, blocked: false, disabled: false, editable: true,
    label: "Run checks", x: 42, y: 28,
  });
  pageTools.waitForAgentPageHover.mockReset();
  pageTools.waitForAgentPageHover.mockResolvedValue(undefined);
  pageTools.showAgentPageCursor.mockClear();
  pageTools.setAgentPageInputGuard.mockClear();
});

describe("Browser hover", () => {
  it("moves the pointer to the element without pressing it and reports the element", async () => {
    const { broker, contents } = await loadedHarness();
    pageTools.locateAgentPageRef.mockResolvedValue({ ...shippingTarget, role: "button", label: "Help" });
    const result = await broker.perform(runIdentity, { action: "hover", ref: "e2" });
    expect(result).toMatchObject({
      ok: true,
      state: { activity: { action: "hover", label: "Agent hovered a page element", x: 120, y: 64 } },
    });
    expect(parseAgentBrowserResult(result)).not.toBeNull();
    expect(detail(result)).toMatchObject({ hovered: "e2", element: { role: "button", label: "Help" } });
    expect(contents.sentInputs).toEqual([{ type: "mouseMove", x: 120, y: 64 }]);
    expect(pageTools.showAgentPageCursor).toHaveBeenCalledWith(contents, 120, 64, "Agent hover");
    expect(pageTools.setAgentPageInputGuard.mock.calls.map(([, active]) => active)).toEqual([true, false]);
  });

  it("follows a target that moves under the pointer and reports where it ended", async () => {
    const { broker, contents } = await loadedHarness();
    pageTools.locateAgentPageRef
      .mockResolvedValueOnce({ ...shippingTarget })
      .mockResolvedValueOnce({ ...shippingTarget })
      .mockResolvedValueOnce({ ...shippingTarget, x: 300 })
      .mockResolvedValue({ ...shippingTarget, x: 300 });
    await expect(broker.perform(runIdentity, { action: "hover", ref: "e2" }))
      .resolves.toMatchObject({ ok: true, state: { activity: { action: "hover", x: 300, y: 64 } } });
    expect(contents.sentInputs).toEqual([
      { type: "mouseMove", x: 120, y: 64 },
      { type: "mouseMove", x: 300, y: 64 },
    ]);
  });

  it.each([
    ["a stale", { found: false }, "not-found", "That page element is stale. Take a new inertia_browser_snapshot for current refs."],
    ["a disabled", { ...shippingTarget, disabled: true }, "invalid", "That page element is disabled."],
    ["a blocked", { ...shippingTarget, blocked: true }, "invalid", "That page element cannot be controlled by the Browser agent."],
  ])("refuses %s target without moving the pointer", async (_name, target, code, message) => {
    const { broker, contents } = await loadedHarness();
    pageTools.locateAgentPageRef.mockResolvedValue(target);
    await expect(broker.perform(runIdentity, { action: "hover", ref: "e2" }))
      .resolves.toEqual({ ok: false, code, message });
    expect(contents.sentInputs).toEqual([]);
    expect(pageTools.showAgentPageCursor).not.toHaveBeenCalled();
  });

  it("refuses a hover in a blank tab", async () => {
    const { broker } = createPreviewBrokerHarness(PreviewBroker);
    await expect(broker.perform(runIdentity, { action: "hover", ref: "e2" }))
      .resolves.toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("This tab is blank") });
  });

  it("stops before moving the pointer when the Browser geometry changes", async () => {
    const { broker, children } = await loadedHarness();
    broker.connect({ ownerId: "primary", contextId: conversationId, connectionId });
    broker.setBounds({
      ownerId: "primary", contextId: conversationId, connectionId,
      bounds: { x: 10, y: 20, width: 600, height: 400 },
    });
    let started = (): void => undefined;
    let release = (): void => undefined;
    const cursorShown = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    pageTools.showAgentPageCursor.mockImplementationOnce(async () => {
      started();
      await blocked;
    });
    const hover = broker.perform(runIdentity, { action: "hover", ref: "e2" });
    await cursorShown;
    broker.setBounds({
      ownerId: "primary", contextId: conversationId, connectionId,
      bounds: { x: 30, y: 40, width: 420, height: 280 },
    });
    release();
    await expect(hover).resolves.toMatchObject({
      ok: false,
      code: "not-found",
      message: "The Browser page layout changed during this action. Take a new inertia_browser_snapshot for current refs.",
    });
    expect(children[0]!.webContents.sentInputs).toEqual([]);
  });

  it("hands the page back when the user clicks during the hover", async () => {
    const { broker, contents } = await loadedHarness();
    let moved = (): void => undefined;
    const pointerMoved = new Promise<void>((resolve) => { moved = resolve; });
    pageTools.waitForAgentPageHover.mockImplementationOnce(async () => {
      moved();
      await new Promise<never>(() => undefined);
    });
    const hover = broker.perform(runIdentity, { action: "hover", ref: "e2" });
    await pointerMoved;
    contents.emit("input-event", {}, { type: "mouseDown", x: 5, y: 5 });
    await expect(hover).resolves.toMatchObject({ ok: false, code: "interrupted", reachedPage: true });
    expect(contents.sentInputs).toEqual([{ type: "mouseMove", x: 42, y: 28 }]);
    await expect(broker.perform(runIdentity, { action: "tabs" }))
      .resolves.toMatchObject({ ok: true, state: { controller: "user" } });
  });

  it("moves the pointer in view coordinates under a fixed viewport and refuses targets outside it", async () => {
    const { broker, contents } = await loadedHarness();
    broker.connect({ ownerId: "primary", contextId: conversationId, connectionId });
    broker.setBounds({
      ownerId: "primary", contextId: conversationId, connectionId,
      bounds: { x: 100, y: 50, width: 600, height: 500 },
    });
    await broker.perform(runIdentity, { action: "resize", preset: "desktop" });
    pageTools.locateAgentPageRef.mockResolvedValue({ ...shippingTarget, role: "button", label: "Help", x: 1_230, y: 720 });

    await expect(broker.perform(runIdentity, { action: "hover", ref: "e2" })).resolves.toMatchObject({
      ok: true,
      state: { activity: { action: "hover", x: 1_230, y: 720 } },
    });
    expect(contents.sentInputs).toEqual([{ type: "mouseMove", x: 576.5625, y: 337.5 }]);
    expect(pageTools.showAgentPageCursor).toHaveBeenLastCalledWith(contents, 1_230, 720, "Agent hover");

    pageTools.locateAgentPageRef.mockResolvedValue({ ...shippingTarget, x: 1_300, y: 720 });
    await expect(broker.perform(runIdentity, { action: "hover", ref: "e2" })).resolves.toEqual({
      ok: false,
      code: "not-found",
      message: "That control is outside the visible part of the page. Scroll it into view with inertia_browser_scroll and its ref, then try again.",
    });
    expect(contents.sentInputs).toHaveLength(1);
  });

  it("binds a Supervised hover approval to the inspected element", async () => {
    const { broker, contents } = await loadedHarness();
    pageTools.locateAgentPageRef.mockResolvedValue({ ...shippingTarget, role: "button", label: "Help" });
    const command = { action: "hover", ref: "e2" } as const;
    const prepared = await broker.perform(runIdentity, { action: "prepare-approval", command });
    const { token, detail: approval } = JSON.parse((prepared as { text: string }).text) as {
      token: string; detail: string;
    };
    expect(approval).toBe("Browser tab 1\nHover over button: Help");
    await expect(broker.perform(runIdentity, { action: "perform-approved", token }))
      .resolves.toMatchObject({ ok: true, state: { activity: { action: "hover" } } });
    expect(contents.sentInputs).toEqual([{ type: "mouseMove", x: 120, y: 64 }]);
  });
});

describe("Browser select", () => {
  const shipping = [
    { value: "standard", label: "Standard" },
    { value: "express", label: "Express" },
    { value: "Fast", label: "Overnight" },
  ];

  beforeEach(() => {
    pageTools.locateAgentPageRef.mockResolvedValue({ ...shippingTarget });
  });

  it("chooses an option by its value, dispatches input and change, and reports the choice", async () => {
    const { broker, contents } = await loadedHarness();
    const page = selectPage(contents, shipping);
    const result = await broker.perform(runIdentity, { action: "select", ref: "e4", value: "express" });
    expect(result).toMatchObject({
      ok: true,
      state: { activity: { action: "select", label: "Agent chose an option", x: 120, y: 64 } },
    });
    expect(parseAgentBrowserResult(result)).not.toBeNull();
    expect(detail(result)).toMatchObject({
      selected: "e4",
      element: { role: "select", label: "Shipping" },
      option: { value: "express", label: "Express" },
    });
    expect(page.select.selectedIndex).toBe(1);
    expect(page.events).toEqual([{ type: "input", bubbles: true }, { type: "change", bubbles: true }]);
    expect(contents.sentInputs).toEqual([]);
    expect(pageTools.showAgentPageCursor).toHaveBeenCalledWith(contents, 120, 64, "Agent choosing");
    expect(pageTools.setAgentPageInputGuard.mock.calls.map(([, active]) => active)).toEqual([true, false]);
  });

  it("falls back to the option label when no value matches", async () => {
    const { broker, contents } = await loadedHarness();
    const page = selectPage(contents, shipping);
    const result = await broker.perform(runIdentity, { action: "select", ref: "e4", value: "Overnight" });
    expect(detail(result)).toMatchObject({ option: { value: "Fast", label: "Overnight" } });
    expect(page.select.selectedIndex).toBe(2);
  });

  it("prefers an exact value, then an exact label, before matching case-insensitively", async () => {
    const { broker, contents } = await loadedHarness();
    const page = selectPage(contents, [
      { value: "overnight", label: "Slow" },
      { value: "fast-label", label: "Fast" },
      { value: "fast", label: "Also fast" },
    ]);
    await broker.perform(runIdentity, { action: "select", ref: "e4", value: "fast" });
    expect(page.select.selectedIndex).toBe(2);
    await broker.perform(runIdentity, { action: "select", ref: "e4", value: "Fast" });
    expect(page.select.selectedIndex).toBe(1);
    await broker.perform(runIdentity, { action: "select", ref: "e4", value: "OVERNIGHT" });
    expect(page.select.selectedIndex).toBe(0);
    await broker.perform(runIdentity, { action: "select", ref: "e4", value: "ALSO FAST" });
    expect(page.select.selectedIndex).toBe(2);
  });

  it("lists up to twenty redacted option labels when nothing matches and changes nothing", async () => {
    const { broker, contents } = await loadedHarness();
    const options = Array.from({ length: 25 }, (_, index) => ({
      value: `plan-${index}`,
      label: index === 0 ? "hunter2-secret plan" : `Plan ${index} ${"x".repeat(60)}`,
    }));
    const page = selectPage(contents, options, {}, ["hunter2-secret"]);
    const result = await broker.perform(runIdentity, { action: "select", ref: "e4", value: "Gold" });
    expect(result).toMatchObject({ ok: false, code: "not-found" });
    const message = (result as { message: string }).message;
    expect(parseAgentBrowserResult(result)).toEqual(result);
    expect(message).toContain("\"[redacted] plan\"");
    expect(message).not.toContain("hunter2-secret");
    expect(message).toContain("Plan 19");
    expect(message).not.toContain("Plan 20");
    expect(message).toContain("(25 options in total)");
    expect(page.select.selectedIndex).toBe(0);
    expect(page.events).toEqual([]);
  });

  it("keeps the listed options within the failure message limit", async () => {
    const { broker, contents } = await loadedHarness();
    selectPage(contents, Array.from({ length: 20 }, (_, index) => ({
      value: `quoted-${index}`, label: "\"".repeat(40),
    })));
    const result = await broker.perform(runIdentity, { action: "select", ref: "e4", value: "Gold" });
    expect(result).toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("(20 options in total)") });
    expect((result as { message: string }).message.length).toBeLessThanOrEqual(1_000);
    expect(parseAgentBrowserResult(result)).toEqual(result);
  });

  it.each([
    ["not a select", { tagName: "INPUT" }, "That page element is not a <select> list. Click custom menus open and choose an option with inertia_browser_click."],
    ["disabled", { disabled: true }, "That page element is disabled."],
    ["inside an aria-disabled group", { parentElement: { getAttribute: (name: string) => name === "aria-disabled" ? "true" : null, parentElement: null } }, "That page element is disabled."],
    ["a multiple-choice list", { multiple: true }, "That list allows several choices. Click its options with inertia_browser_click instead."],
    ["inside a shadow root", { getRootNode: () => ({}) }, "That list is inside a frame or shadow root that Inertia cannot inspect."],
  ])("refuses a control that is %s", async (_name, overrides, message) => {
    const { broker, contents } = await loadedHarness();
    const page = selectPage(contents, shipping, overrides);
    await expect(broker.perform(runIdentity, { action: "select", ref: "e4", value: "express" }))
      .resolves.toEqual({ ok: false, code: "invalid", message });
    expect(page.select.selectedIndex).toBe(0);
    expect(page.events).toEqual([]);
  });

  it("refuses a disabled option or one inside a disabled group", async () => {
    const { broker, contents } = await loadedHarness();
    const page = selectPage(contents, [
      { value: "standard", label: "Standard" },
      { value: "express", label: "Express", disabled: true },
      { value: "pickup", label: "Pickup", parentElement: { tagName: "OPTGROUP", disabled: true } },
    ]);
    for (const value of ["express", "pickup"]) {
      await expect(broker.perform(runIdentity, { action: "select", ref: "e4", value }))
        .resolves.toEqual({ ok: false, code: "invalid", message: "That option is disabled." });
    }
    expect(page.select.selectedIndex).toBe(0);
    expect(page.events).toEqual([]);
  });

  it("refuses a disabled or stale ref before running anything in the page", async () => {
    const { broker, contents } = await loadedHarness();
    const page = selectPage(contents, shipping);
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ ...shippingTarget, disabled: true });
    await expect(broker.perform(runIdentity, { action: "select", ref: "e4", value: "express" }))
      .resolves.toEqual({ ok: false, code: "invalid", message: "That page element is disabled." });
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ found: false });
    await expect(broker.perform(runIdentity, { action: "select", ref: "e4", value: "express" }))
      .resolves.toMatchObject({ ok: false, code: "not-found" });
    expect(page.scripts).toEqual([]);
  });

  it("binds a Supervised select approval to the inspected list and option", async () => {
    const { broker, contents } = await loadedHarness();
    const page = selectPage(contents, shipping);
    const command = { action: "select", ref: "e4", value: "Express" } as const;
    const prepared = await broker.perform(runIdentity, { action: "prepare-approval", command });
    const { token, detail: approval } = JSON.parse((prepared as { text: string }).text) as {
      token: string; detail: string;
    };
    expect(approval).toBe("Browser tab 1\nChoose an option in select: Shipping\nOption: \"Express\"");
    await expect(broker.perform(runIdentity, { action: "perform-approved", token }))
      .resolves.toMatchObject({ ok: true, state: { activity: { action: "select" } } });
    expect(page.select.selectedIndex).toBe(1);

    const again = await broker.perform(runIdentity, { action: "prepare-approval", command });
    const second = (JSON.parse((again as { text: string }).text) as { token: string }).token;
    pageTools.locateAgentPageRef.mockResolvedValue({ ...shippingTarget, label: "Billing country" });
    await expect(broker.perform(runIdentity, { action: "perform-approved", token: second }))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining("changed after inspection") });
    expect(page.scripts).toHaveLength(1);
  });
});

describe("Browser logs", () => {
  it("returns the evidence ledger newest last without touching the page or recording activity", async () => {
    const { broker, contents, browserSession } = await loadedHarness();
    const preventDefault = vi.fn();
    contents.emit("console-message", { level: "error", message: "TypeError: boom", preventDefault });
    contents.emit("console-message", { level: "error", message: "TypeError: boom", preventDefault });
    await vi.waitFor(() => expect(pageTools.agentPageEvidencePrivacy).toHaveBeenCalled());
    browserSession.emitBeforeRequest({
      id: 9, url: "http://127.0.0.1:3000/api/items?token=never", method: "GET",
      resourceType: "xhr", webContentsId: contents.id,
    });
    browserSession.emitCompleted({
      id: 9, url: "http://127.0.0.1:3000/api/items?token=never", method: "GET",
      resourceType: "xhr", statusCode: 500,
    });
    const before = await broker.perform(runIdentity, { action: "tabs" });
    const inputsBefore = contents.sentInputs.length;
    const commandsBefore = contents.debugger.sendCommand.mock.calls.length;
    await vi.waitFor(async () => {
      const entries = detail(await broker.perform(runIdentity, { action: "logs" })).entries as unknown[];
      expect(entries.length).toBeGreaterThanOrEqual(4);
    });
    const result = await broker.perform(runIdentity, { action: "logs" });
    expect(parseAgentBrowserResult(result)).not.toBeNull();
    const text = (result as { text: string }).text;
    expect(text).not.toContain("never");
    expect(text).not.toContain("/api/items");
    const logs = detail(result);
    expect(logs).not.toHaveProperty("omitted");
    const entries = logs.entries as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry.kind))
      .toEqual(["navigation", "navigation", "console-error", "network-failure"]);
    expect(entries[1]).toMatchObject({ summary: "Page navigated", detail: "Destination http://127.0.0.1:3000" });
    expect(entries[2]).toMatchObject({ summary: "Console error", detail: "TypeError: boom", occurrences: 2 });
    expect(entries[3]).toMatchObject({ summary: "GET xhr failed", detail: "HTTP 500 · http://127.0.0.1:3000" });
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(["at", "kind", "summary", "tabId"]));
      expect(Number.isNaN(Date.parse(entry.at as string))).toBe(false);
    }
    expect((result as { state: { activity: unknown } }).state.activity)
      .toEqual((before as { state: { activity: unknown } }).state.activity);
    expect(contents.sentInputs).toHaveLength(inputsBefore);
    expect(contents.debugger.sendCommand.mock.calls).toHaveLength(commandsBefore);
  });

  it("keeps the newest entries within the shared text budget and says when entries were left out", async () => {
    const { broker, contents } = await loadedHarness();
    for (let index = 0; index < 120; index += 1) {
      contents.emit("console-message", {
        level: "error",
        message: `Render failure ${index} ${"detail ".repeat(80)}`,
        preventDefault: vi.fn(),
      });
    }
    await vi.waitFor(async () => {
      expect((await broker.perform(runIdentity, { action: "logs" }) as { text: string }).text)
        .toContain("Render failure 119");
    });
    const result = await broker.perform(runIdentity, { action: "logs" });
    const text = (result as { text: string }).text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_AGENT_BROWSER_TEXT_BYTES);
    const logs = detail(result);
    expect(logs.omitted).toBe(true);
    const entries = logs.entries as Array<{ detail: string }>;
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.length).toBeLessThan(100);
    expect(entries.at(-1)!.detail).toContain("Render failure 119");
  });

  it("reports an empty ledger for a new Browser", async () => {
    const { broker } = createPreviewBrokerHarness(PreviewBroker);
    const result = await broker.perform(runIdentity, { action: "logs" });
    expect(result).toMatchObject({ ok: true });
    expect(detail(result)).toMatchObject({ entries: [] });
  });
});

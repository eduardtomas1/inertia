import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_APP_TOOL_RESULT_BYTES, MAX_APP_WINDOWS } from "../../src/shared/app-under-test";
import {
  CdpWindowTransport,
  appWindowOrigin,
  createCdpTransportFactory,
  type CdpWindowTransportOptions,
} from "../../src/server/runtime/app-under-test/cdp-window-transport";
import {
  APP_FOCUSED_DESCRIBE_EXPRESSION,
  APP_NEXT_FRAME_EXPRESSION,
  APP_PRESS_BEGIN_EXPRESSION,
  APP_PRESS_CONTINUE_EXPRESSION,
  APP_READY_STATE_EXPRESSION,
  APP_SNAPSHOT_EXPRESSION,
  APP_WAIT_READ_EXPRESSION,
  APP_VIEWPORT_EXPRESSION,
  appDescribeExpression,
  appLocateExpression,
  appRefHasFocusExpression,
  appRefOutsideViewportExpression,
  appScrollRefExpression,
} from "../../src/server/runtime/app-under-test/snapshot-script";
import type {
  AppUnderTestCdpTransportContext,
  AppUnderTestWindowCommand,
  AppUnderTestWindowFailure,
} from "../../src/server/runtime/app-under-test/window-transport";

const launchId = "44444444-4444-4444-8444-444444444444";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface Control {
  role: string;
  label: string;
  x: number;
  y: number;
  editable?: boolean;
  sensitive?: boolean;
  disabled?: boolean;
  blocked?: boolean;
  outside?: boolean;
  /** Hit test fails: another element covers the centre. */
  covered?: boolean;
}

interface Page {
  title: string;
  text: string;
  controls: Record<string, Control>;
  withheld: string | null;
  remembered: number;
  readyState: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  pressBlocked: string | null;
  pressContinue: string | null;
  focused: boolean;
  /** The ref of the control that has keyboard focus, or null for the document. */
  focusedRef: string | null;
  /** Secret values the isolated world reports with the next read. */
  remember: string[];
}

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => unknown;

function page(overrides: Partial<Page> = {}): Page {
  return {
    title: "Fixture",
    text: "Hello from the fixture",
    controls: {
      e1: { role: "button", label: "Change text", x: 50, y: 40 },
      e2: { role: "textbox", label: "Name", x: 50, y: 80, editable: true },
      e3: { role: "input", label: "Password", x: 50, y: 120, editable: true, sensitive: true },
    },
    withheld: null,
    remembered: 0,
    readyState: "complete",
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    pressBlocked: null,
    pressContinue: null,
    focused: true,
    focusedRef: "e2",
    remember: [],
    ...overrides,
  };
}

function snapshotValue(model: Page): Record<string, unknown> {
  return {
    title: model.title,
    url: "http://ignored.example/path",
    viewport: model.viewport,
    text: model.text,
    elements: Object.entries(model.controls).map(([ref, control]) => ({
      ref,
      role: control.role,
      name: control.label,
      actionable: true,
      editable: control.editable === true,
      disabled: control.disabled === true,
      ...(control.sensitive ? { value: "[redacted]" } : {}),
      rect: { x: control.x - 10, y: control.y - 10, width: 20, height: 20 },
    })),
    truncated: false,
    omittedTextChars: 0,
    omittedElements: 0,
    readLimitReached: false,
    notInspected: [],
    errorPage: false,
  };
}

function fakePng(width: number, height: number, padding = 0): string {
  const bytes = Buffer.alloc(33 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

/** A scripted Chromium on the far side of the debugging pipe. */
class FakePeer {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  readonly handlers = new Map<string, Handler>();
  readonly targets: Array<{ targetId: string; type: string; url: string; title: string }> = [];
  model = page();
  /** Which read expression each page read used. */
  readonly reads: Array<"snapshot" | "wait"> = [];
  private buffer = "";
  private worlds = 0;

  constructor() {
    this.input.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (let end = this.buffer.indexOf("\0"); end !== -1; end = this.buffer.indexOf("\0")) {
        const frame = JSON.parse(this.buffer.slice(0, end)) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
        this.buffer = this.buffer.slice(end + 1);
        void this.handle(frame);
      }
    });
    this.on("Target.setDiscoverTargets", () => {
      queueMicrotask(() => {
        for (const target of this.targets) this.emit("Target.targetCreated", { targetInfo: { ...target, attached: false } });
      });
      return {};
    });
    this.on("Target.attachToTarget", (params) => ({ sessionId: `S-${String(params.targetId)}` }));
    for (const method of ["Page.enable", "Runtime.enable", "Log.enable", "Page.handleJavaScriptDialog", "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent"]) {
      this.on(method, () => ({}));
    }
    this.on("Page.getFrameTree", (_params, sessionId) => {
      const targetId = String(sessionId).slice(2);
      const target = this.targets.find((candidate) => candidate.targetId === targetId);
      return { frameTree: { frame: { id: `F-${targetId}`, url: target?.url ?? "about:blank" } } };
    });
    this.on("Page.createIsolatedWorld", () => ({ executionContextId: 100 + ++this.worlds }));
    this.on("Runtime.evaluate", (params) => {
      const expression = String(params.expression);
      const value = this.evaluate(expression);
      return { result: { type: "string", value: JSON.stringify(value) } };
    });
    this.on("Page.getLayoutMetrics", () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1024, clientHeight: 640 } }));
    this.on("Page.captureScreenshot", (params) => {
      const clip = params.clip as { width: number; height: number; scale: number };
      return { data: fakePng(Math.round(clip.width * clip.scale), Math.round(clip.height * clip.scale)) };
    });
  }

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.output.write(`${JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  }

  addTarget(targetId: string, url = "http://localhost:5173/app?secret=1", type = "page", title = "Fixture"): void {
    this.targets.push({ targetId, type, url, title });
  }

  callsOf(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  inputTypes(): string[] {
    return this.calls.filter((call) => call.method.startsWith("Input.")).map((call) => String(call.params.type ?? call.method));
  }

  private async handle(frame: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }): Promise<void> {
    this.calls.push({ method: frame.method, params: frame.params, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}) });
    const handler = this.handlers.get(frame.method);
    if (!handler) {
      this.output.write(`${JSON.stringify({ id: frame.id, error: { code: -32601, message: "unknown" } })}\0`);
      return;
    }
    const result = await handler(frame.params, frame.sessionId);
    if (result === undefined) return;
    if (typeof result === "object" && result !== null && "failWith" in result) {
      this.output.write(`${JSON.stringify({ id: frame.id, error: { code: -32000, message: String(result.failWith) }, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}) })}\0`);
      return;
    }
    this.output.write(`${JSON.stringify({ id: frame.id, result, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}) })}\0`);
  }

  private evaluate(expression: string): unknown {
    const model = this.model;
    if (expression === APP_SNAPSHOT_EXPRESSION || expression === APP_WAIT_READ_EXPRESSION) {
      this.reads.push(expression === APP_SNAPSHOT_EXPRESSION ? "snapshot" : "wait");
      const remember = model.remember;
      model.remember = [];
      return { value: snapshotValue(model), withheld: model.withheld, remembered: model.remembered, readyState: model.readyState, remember };
    }
    if (expression === APP_FOCUSED_DESCRIBE_EXPRESSION) {
      const control = model.focusedRef === null ? undefined : model.controls[model.focusedRef];
      return control
        ? { found: true, role: control.role, label: control.sensitive ? "Sensitive field" : control.label, sensitive: control.sensitive === true }
        : { found: false };
    }
    if (expression === APP_NEXT_FRAME_EXPRESSION) return true;
    if (expression === APP_VIEWPORT_EXPRESSION) return model.viewport;
    if (expression === APP_READY_STATE_EXPRESSION) return model.readyState;
    if (expression === APP_PRESS_BEGIN_EXPRESSION) return model.pressBlocked;
    if (expression === APP_PRESS_CONTINUE_EXPRESSION) return model.pressContinue;
    if (expression.includes("privacy.remember(state")) {
      return Object.entries(model.controls).some(([ref, control]) => control.sensitive && expression.includes(JSON.stringify(ref)));
    }
    const dialogs = /const messages = (\[.*?\]);/su.exec(expression);
    if (dialogs) return (JSON.parse(dialogs[1]!) as Array<{ message: string }>).map(({ message }) => message);
    for (const [ref, control] of Object.entries(model.controls)) {
      if (expression === appRefOutsideViewportExpression(ref)) return control.outside === true;
      if (expression === appScrollRefExpression(ref)) {
        control.outside = false;
        model.viewport = { ...model.viewport, scrollY: 300 };
        return { found: true, viewport: model.viewport };
      }
      if (expression === appRefHasFocusExpression(ref)) return model.focused;
      if (expression === appDescribeExpression(ref)) {
        return { found: true, role: control.role, label: control.sensitive ? "Sensitive field" : control.label, sensitive: control.sensitive === true };
      }
      for (const [focus, replace] of [[false, false], [true, false], [true, true]] as const) {
        if (expression === appLocateExpression(ref, focus, replace)) {
          if (control.outside || control.covered) return { found: false };
          return {
            found: true, blocked: control.blocked === true, disabled: control.disabled === true,
            editable: control.editable === true, sensitive: control.sensitive === true,
            role: control.role, label: control.label, x: control.x, y: control.y,
          };
        }
      }
    }
    if (/refs\?\.get\(/u.test(expression)) return { found: false };
    throw new Error(`Unscripted expression: ${expression.slice(0, 120)}`);
  }
}

const transports: CdpWindowTransport[] = [];

afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  vi.useRealTimers();
});

function context(peer: FakePeer) {
  return {
    launchId,
    conversationId: "11111111-1111-4111-8111-111111111111",
    pid: 4242,
    input: peer.input,
    output: peer.output,
    log: vi.fn<AppUnderTestCdpTransportContext["log"]>(),
    evidence: vi.fn<AppUnderTestCdpTransportContext["evidence"]>(() => "55555555-5555-4555-8555-555555555555"),
    windowsChanged: vi.fn(),
  };
}

async function start(peer = new FakePeer(), options: CdpWindowTransportOptions = {}) {
  if (peer.targets.length === 0) peer.addTarget("T1");
  const ctx = context(peer);
  const transport = new CdpWindowTransport(ctx, { navigationGraceMs: 0, waitPollMs: 10, ...options });
  transports.push(transport);
  const controller = new AbortController();
  expect(await transport.waitForWindow(controller.signal, 2_000)).toBe(true);
  const window = transport.windows()[0]!;
  return { peer, ctx, transport, windowId: window.windowId };
}

function perform(
  transport: CdpWindowTransport,
  command: AppUnderTestWindowCommand,
  expected?: Parameters<CdpWindowTransport["perform"]>[1]["expected"],
) {
  return transport.perform(command, { signal: new AbortController().signal, ...(expected ? { expected } : {}) });
}

function value(result: Awaited<ReturnType<CdpWindowTransport["perform"]>>): Record<string, unknown> {
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  return result.value;
}

function failed(result: Awaited<ReturnType<CdpWindowTransport["perform"]>>): AppUnderTestWindowFailure {
  if (result.ok) throw new Error(`Expected failure, got ${JSON.stringify(result.value)}`);
  return result;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("App under test CDP window transport: windows", () => {
  it("attaches page targets only, with Inertia-minted ids, origin-only URLs and sanitized titles", async () => {
    const peer = new FakePeer();
    peer.addTarget("T1", "http://localhost:5173/settings?token=abc#x", "page", "A".repeat(300));
    peer.addTarget("T2", "devtools://devtools/bundled/inspector.html");
    peer.addTarget("T3", "http://localhost:5173/sw.js", "service_worker");
    peer.addTarget("T4", "chrome-extension://abc/background.html", "background_page");
    const { ctx, transport } = await start(peer);
    const windows = transport.windows();
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      windowId: expect.stringMatching(UUID),
      launchId,
      title: expect.any(String),
      origin: "http://localhost:5173",
      active: true,
      loading: true,
    });
    expect(windows[0]!.windowId).not.toContain("T1");
    expect(windows[0]!.title.length).toBeLessThanOrEqual(120);
    expect(peer.callsOf("Target.attachToTarget")).toEqual([{ targetId: "T1", flatten: true }]);
    for (const method of ["Page.enable", "Runtime.enable", "Log.enable"]) {
      expect(peer.calls.some((call) => call.method === method && call.sessionId === "S-T1")).toBe(true);
    }
    expect(ctx.windowsChanged).toHaveBeenCalled();
  });

  it("reports title, loading and removal changes, and keeps window numbers stable", async () => {
    const peer = new FakePeer();
    peer.addTarget("T1");
    peer.addTarget("T2", "file:///home/user/app/index.html", "page", "Second");
    const { ctx, transport } = await start(peer);
    await until(() => transport.windows().length === 2);
    const [first, second] = transport.windows();
    expect(second!.origin).toBe("file://");
    ctx.windowsChanged.mockClear();
    peer.emit("Target.targetInfoChanged", { targetInfo: { targetId: "T2", type: "page", url: "file:///home/user/app/index.html", title: "Renamed" } });
    await until(() => transport.windows()[1]?.title === "Renamed");
    expect(ctx.windowsChanged).toHaveBeenCalled();
    peer.emit("Page.frameStoppedLoading", { frameId: "F-T1" }, "S-T1");
    await until(() => transport.windows()[0]?.loading === false);
    peer.emit("Target.targetDestroyed", { targetId: "T1" });
    await until(() => transport.windows().length === 1);
    expect(transport.windows()[0]!.windowId).toBe(second!.windowId);
    const inspection = await transport.inspect({ action: "press", windowId: second!.windowId, key: "Tab" }, new AbortController().signal);
    expect(inspection).toMatchObject({
      ok: true,
      inspection: { windowNumber: 2, documentSequence: 1, target: { role: "textbox", label: "Name", sensitive: false }, dialog: null },
    });
    expect(first!.windowId).not.toBe(second!.windowId);
  });

  it("removes a window whose target turns into DevTools or another internal page", async () => {
    const peer = new FakePeer();
    peer.addTarget("T1");
    peer.addTarget("T2", "http://localhost:5173/second");
    const { ctx, transport } = await start(peer);
    await until(() => transport.windows().length === 2);
    ctx.windowsChanged.mockClear();
    peer.emit("Target.targetInfoChanged", { targetInfo: { targetId: "T2", type: "page", url: "devtools://devtools/bundled/inspector.html", title: "DevTools" } });
    await until(() => transport.windows().length === 1);
    expect(ctx.windowsChanged).toHaveBeenCalled();
    expect(transport.windows()[0]!.origin).toBe("http://localhost:5173");
    expect(peer.callsOf("Target.detachFromTarget")).toEqual([{ sessionId: "S-T2" }]);
    peer.emit("Target.targetInfoChanged", { targetInfo: { targetId: "T1", type: "page", url: "chrome://gpu", title: "GPU" } });
    await until(() => transport.windows().length === 0);
  });

  it("lists at most eight windows and attaches a waiting one when a window closes", async () => {
    const peer = new FakePeer();
    for (let index = 1; index <= MAX_APP_WINDOWS + 2; index += 1) peer.addTarget(`T${index}`);
    const { transport } = await start(peer);
    await until(() => transport.windows().length === MAX_APP_WINDOWS);
    expect(peer.callsOf("Target.attachToTarget")).toHaveLength(MAX_APP_WINDOWS);
    peer.emit("Target.targetDestroyed", { targetId: "T1" });
    await until(() => peer.callsOf("Target.attachToTarget").length === MAX_APP_WINDOWS + 1);
    await until(() => transport.windows().length === MAX_APP_WINDOWS);
  });

  it("waits for the first window and gives up on timeout, abort or close", async () => {
    const peer = new FakePeer();
    const ctx = context(peer);
    const transport = new CdpWindowTransport(ctx);
    transports.push(transport);
    expect(await transport.waitForWindow(new AbortController().signal, 30)).toBe(false);
    const controller = new AbortController();
    const aborted = transport.waitForWindow(controller.signal, 5_000);
    controller.abort();
    expect(await aborted).toBe(false);
    const waiting = transport.waitForWindow(new AbortController().signal, 5_000);
    peer.addTarget("T9");
    peer.emit("Target.targetCreated", { targetInfo: { targetId: "T9", type: "page", url: "http://localhost:3000/", title: "" } });
    expect(await waiting).toBe(true);
    const closed = new CdpWindowTransport(context(new FakePeer()));
    const pending = closed.waitForWindow(new AbortController().signal, 5_000);
    closed.close();
    expect(await pending).toBe(false);
    expect(closed.windows()).toEqual([]);
  });

  it("forwards console, exception, log and crash events to the launch log", async () => {
    const { peer, ctx } = await start();
    peer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "ready" }, { type: "number", value: 3 }] }, "S-T1");
    peer.emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "object", description: "Error: boom" }] }, "S-T1");
    peer.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is undefined" } } }, "S-T1");
    peer.emit("Log.entryAdded", { entry: { level: "warning", text: "Deprecated API" } }, "S-T1");
    peer.emit("Inspector.targetCrashed", {}, "S-T1");
    await until(() => ctx.log.mock.calls.length === 5);
    expect(ctx.log.mock.calls).toEqual([
      ["console", "ready 3"],
      ["console", "error: Error: boom"],
      ["exception", "TypeError: x is undefined"],
      ["console", "warning: Deprecated API"],
      ["crash", "App window 1 crashed."],
    ]);
  });

  it("is created by the factory and closes the pipe once", async () => {
    const peer = new FakePeer();
    peer.addTarget("T1");
    const transport = createCdpTransportFactory().create(context(peer));
    expect(transport).not.toBeNull();
    transport!.close();
    transport!.close();
    expect(peer.input.destroyed).toBe(true);
  });

  it("reports origins only", () => {
    expect(appWindowOrigin("https://user:pass@example.com:8443/a?b#c")).toBe("https://example.com:8443");
    expect(appWindowOrigin("app://bundle/index.html")).toBe("app://bundle");
    expect(appWindowOrigin("about:blank")).toBeNull();
    expect(appWindowOrigin("data:text/html,<h1>x</h1>")).toBeNull();
    expect(appWindowOrigin("not a url")).toBeNull();
  });
});

describe("App under test CDP window transport: reading", () => {
  it("returns a Browser-shaped snapshot in the isolated world, with the origin as url", async () => {
    const { peer, transport, windowId } = await start();
    const snapshot = value(await perform(transport, { action: "snapshot", windowId }));
    expect(snapshot).toMatchObject({
      title: "Fixture",
      url: "http://localhost:5173",
      viewport: { width: 800, height: 600 },
      text: "Hello from the fixture",
      elements: [
        expect.objectContaining({ ref: "e1", role: "button", name: "Change text" }),
        expect.objectContaining({ ref: "e2", role: "textbox", editable: true }),
        expect.objectContaining({ ref: "e3", value: "[redacted]" }),
      ],
    });
    expect(snapshot).not.toHaveProperty("omitted");
    const world = peer.callsOf("Page.createIsolatedWorld");
    expect(world).toEqual([{ frameId: "F-T1", worldName: "inertia-app-under-test", grantUniveralAccess: false }]);
    expect(peer.callsOf("Runtime.evaluate")[0]).toMatchObject({ contextId: 101, returnByValue: true });
    // The world is reused for the same document and re-created after a navigation.
    value(await perform(transport, { action: "snapshot", windowId }));
    expect(peer.callsOf("Page.createIsolatedWorld")).toHaveLength(1);
    peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/next" } }, "S-T1");
    await until(() => transport.windows()[0] !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    value(await perform(transport, { action: "snapshot", windowId }));
    expect(peer.callsOf("Page.createIsolatedWorld")).toHaveLength(2);
  });

  it("reports blank windows and withheld documents", async () => {
    const peer = new FakePeer();
    peer.addTarget("T1", "about:blank", "page", "");
    const { transport, windowId } = await start(peer);
    expect(value(await perform(transport, { action: "snapshot", windowId }))).toMatchObject({ blank: true, nextStep: expect.stringContaining("inertia_app_wait_for") });
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" }))).toMatchObject({ code: "not-found", dispatched: false });
    peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/" } }, "S-T1");
    await until(() => transport.windows()[0]?.origin === "http://localhost:5173");
    peer.model.withheld = "redaction-limit";
    expect(failed(await perform(transport, { action: "snapshot", windowId }))).toMatchObject({ code: "sensitive", dispatched: false });
  });

  it("structurally reduces an oversized snapshot within the result bound", async () => {
    const { peer, transport, windowId } = await start();
    const controls: Record<string, Control> = {};
    for (let index = 1; index <= 200; index += 1) {
      controls[`e${index}`] = { role: "button", label: `${"Long label ".repeat(27)}${index}`, x: 10, y: index * 30 };
    }
    peer.model = page({ controls, text: "word ".repeat(2_400) });
    const snapshot = value(await perform(transport, { action: "snapshot", windowId }));
    const bytes = Buffer.byteLength(JSON.stringify({ ...snapshot, windowId, launchId }), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_APP_TOOL_RESULT_BYTES);
    expect(snapshot.omitted).toMatchObject({ elements: expect.any(Number) });
    expect((snapshot.omitted as { elements: number }).elements).toBeGreaterThan(0);
    expect(snapshot.nextStep).toContain("inertia_app_scroll");
    expect(snapshot.nextStep).not.toContain("inertia_browser");
  });

  it("waits for visible, hidden and loaded states by polling the guarded snapshot", async () => {
    const { peer, transport, windowId } = await start();
    peer.model.text = "Loading";
    setTimeout(() => { peer.model.text = "Saved!"; }, 40);
    expect(value(await perform(transport, { action: "wait", windowId, text: "saved!", state: "visible", timeoutMs: 2_000 })))
      .toMatchObject({ matched: true });
    expect(value(await perform(transport, { action: "wait", windowId, text: "Loading", state: "hidden", timeoutMs: 500 })))
      .toMatchObject({ matched: true });
    expect(value(await perform(transport, { action: "wait", windowId, text: "never", state: "visible", timeoutMs: 100 })))
      .toMatchObject({ matched: false, nextStep: expect.stringContaining("inertia_app_snapshot") });
    peer.emit("Page.frameStoppedLoading", { frameId: "F-T1" }, "S-T1");
    await until(() => transport.windows()[0]?.loading === false);
    expect(value(await perform(transport, { action: "wait", windowId, state: "loaded", timeoutMs: 500 })))
      .toMatchObject({ matched: true });
    // Wait polls read through the scratch-ref expression: they never mint or clear the agent's refs.
    expect(peer.reads.length).toBeGreaterThan(2);
    expect(peer.reads.every((kind) => kind === "wait")).toBe(true);
  });

  it("captures a bounded local thumbnail and returns metadata only", async () => {
    const { peer, ctx, transport, windowId } = await start();
    let attempts = 0;
    peer.on("Page.captureScreenshot", (params) => {
      attempts += 1;
      const clip = params.clip as { width: number; height: number; scale: number };
      // The first capture is too large in bytes; the transport asks for a smaller one.
      return { data: fakePng(Math.round(clip.width * clip.scale), Math.round(clip.height * clip.scale), attempts === 1 ? 300 * 1024 : 0) };
    });
    const result = value(await perform(transport, { action: "screenshot", windowId }));
    expect(result).toEqual({ captured: true, evidenceId: "55555555-5555-4555-8555-555555555555", width: 1024, height: 640 });
    expect(attempts).toBe(2);
    const [entry] = ctx.evidence.mock.calls[0]!;
    expect(entry).toMatchObject({ kind: "screenshot" });
    const shot = entry as { width: number; height: number; png: Uint8Array };
    expect(shot.width).toBeLessThanOrEqual(512);
    expect(shot.height).toBeLessThanOrEqual(320);
    expect(shot.png.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.stringify(result)).not.toContain("iVBOR");
  });

  it("refuses screenshots while the document holds a secret", async () => {
    const { peer, ctx, transport, windowId } = await start();
    peer.model.remembered = 1;
    expect(failed(await perform(transport, { action: "screenshot", windowId }))).toMatchObject({ code: "sensitive" });
    peer.model.remembered = 0;
    peer.model.text = "api_key=sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(failed(await perform(transport, { action: "screenshot", windowId }))).toMatchObject({ code: "sensitive" });
    expect(ctx.evidence).not.toHaveBeenCalled();
    expect(peer.callsOf("Page.captureScreenshot")).toHaveLength(0);
  });

  it("renders a model-visible copy within 1,536 pixels and a pixel budget that fits one debugging frame", async () => {
    const { peer, ctx, transport, windowId } = await start();
    // A Retina-like window: two image pixels per CSS pixel.
    peer.on("Page.getLayoutMetrics", () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1_600, clientHeight: 1_000 } }));
    peer.on("Page.captureScreenshot", (params) => {
      const clip = params.clip as { width: number; height: number; scale: number };
      return { data: fakePng(Math.round(clip.width * clip.scale * 2), Math.round(clip.height * clip.scale * 2)) };
    });
    const shot = await transport.perform({ action: "screenshot", windowId, agentImage: true }, { signal: new AbortController().signal });
    if (!shot.ok) throw new Error(shot.message);
    // The host tool records the evidence once it knows whether the image was sent.
    expect(shot.value).toEqual({ captured: true, width: 1_600, height: 1_000 });
    expect(shot.thumbnail).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(shot.thumbnail!.width).toBeLessThanOrEqual(512);
    const image = shot.image!;
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1_536);
    // Even an incompressible PNG of this many pixels stays below the 4 MiB frame bound in base64.
    expect(image.width * image.height).toBeLessThanOrEqual(720_000);
    expect(image.width * image.height).toBeGreaterThan(600_000);
    expect(image.png.byteLength).toBeLessThanOrEqual(3_750_000);
    expect([...image.png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // The thumbnail needs a second, smaller render on a two-pixel display; the model's copy,
    // sized from what the thumbnail showed, needs one.
    expect(peer.callsOf("Page.captureScreenshot")).toHaveLength(3);
    expect(ctx.evidence).not.toHaveBeenCalled();
    // Without the opt-in only the thumbnail is rendered, and recorded here.
    const local = await transport.perform({ action: "screenshot", windowId }, { signal: new AbortController().signal });
    expect(local).toMatchObject({ ok: true, value: { evidenceId: "55555555-5555-4555-8555-555555555555" } });
    expect(local).not.toHaveProperty("image");
    expect(local).not.toHaveProperty("thumbnail");
    expect(peer.callsOf("Page.captureScreenshot")).toHaveLength(5);
    expect(ctx.evidence.mock.calls[0]![0]).not.toHaveProperty("sentToAgent");
  });

  it("keeps the local thumbnail when the model-visible capture fails", async () => {
    const { peer, transport, windowId } = await start();
    let captures = 0;
    peer.on("Page.captureScreenshot", (params) => {
      captures += 1;
      if (captures === 2) return { failWith: "Unable to capture screenshot" };
      const clip = params.clip as { width: number; height: number; scale: number };
      return { data: fakePng(Math.round(clip.width * clip.scale), Math.round(clip.height * clip.scale)) };
    });
    const shot = await transport.perform({ action: "screenshot", windowId, agentImage: true }, { signal: new AbortController().signal });
    expect(shot).toMatchObject({ ok: true, image: null, value: { captured: true }, thumbnail: { width: 512, height: 320 } });
  });

  it("never renders a model-visible copy while the launch holds a secret another document revealed", async () => {
    const { peer, ctx, transport, windowId } = await start();
    peer.model.remember = ["s3cret-from-page"];
    value(await perform(transport, { action: "snapshot", windowId }));
    // A new document: the window's own memory is empty, the launch's is not.
    peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/next" } }, "S-T1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = peer.callsOf("Page.captureScreenshot").length;
    expect(failed(await perform(transport, { action: "screenshot", windowId, agentImage: true }))).toMatchObject({
      code: "sensitive", message: expect.stringContaining("not sent to you while this app holds a secret"),
    });
    expect(peer.callsOf("Page.captureScreenshot")).toHaveLength(before);
    // The local thumbnail of the new document stays available.
    expect(value(await perform(transport, { action: "screenshot", windowId }))).toMatchObject({ captured: true });
    expect(ctx.evidence).toHaveBeenCalledOnce();
  });

  it("withholds the model-visible copy with the local one while the document holds a secret", async () => {
    const { peer, ctx, transport, windowId } = await start();
    peer.model.remembered = 1;
    expect(failed(await perform(transport, { action: "screenshot", windowId, agentImage: true }))).toMatchObject({ code: "sensitive" });
    expect(peer.callsOf("Page.captureScreenshot")).toHaveLength(0);
    expect(ctx.evidence).not.toHaveBeenCalled();
  });

  it("refuses inertia_app_activate: Electron windows never need the foreground", async () => {
    const { peer, transport, windowId } = await start();
    const before = peer.callsOf("Runtime.evaluate").length;
    expect(await transport.inspect({ action: "activate", windowId }, new AbortController().signal))
      .toMatchObject({ ok: false, code: "invalid", dispatched: false, message: expect.stringContaining("only for native windows") });
    expect(failed(await perform(transport, { action: "activate", windowId }))).toMatchObject({ code: "invalid", dispatched: false });
    expect(peer.callsOf("Runtime.evaluate")).toHaveLength(before);
    expect(transport.documentSequence(windowId)).toBe(1);
    expect(transport.documentSequence("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("App under test CDP window transport: input", () => {
  it("clicks the hit-tested centre with move, press and release", async () => {
    const { peer, transport, windowId } = await start();
    const result = value(await perform(transport, { action: "click", windowId, ref: "e1" }));
    expect(result).toMatchObject({ clicked: "e1", origin: "http://localhost:5173" });
    expect(peer.callsOf("Input.dispatchMouseEvent")).toEqual([
      expect.objectContaining({ type: "mouseMoved", x: 50, y: 40 }),
      expect.objectContaining({ type: "mousePressed", x: 50, y: 40, button: "left", clickCount: 1 }),
      expect.objectContaining({ type: "mouseReleased", x: 50, y: 40, button: "left", clickCount: 1 }),
    ]);
  });

  it("refuses a covered, disabled or embedded target without pressing", async () => {
    const { peer, transport, windowId } = await start();
    peer.model.controls.e1!.covered = true;
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" })))
      .toMatchObject({ code: "not-found", dispatched: false, message: expect.stringContaining("inertia_app_snapshot") });
    peer.model.controls.e1!.covered = false;
    peer.model.controls.e1!.disabled = true;
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" }))).toMatchObject({ code: "invalid", dispatched: false });
    peer.model.controls.e1!.disabled = false;
    peer.model.controls.e1!.blocked = true;
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" }))).toMatchObject({ code: "invalid" });
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e99" }))).toMatchObject({ code: "not-found" });
    expect(peer.inputTypes().filter((type) => type === "mousePressed")).toEqual([]);
  });

  it("scrolls an off-screen ref into view before clicking, but not for an approved action", async () => {
    const { peer, transport, windowId } = await start();
    peer.model.controls.e1!.outside = true;
    const inspection = await transport.inspect({ action: "click", windowId, ref: "e1" }, new AbortController().signal);
    expect(inspection).toMatchObject({ ok: false, code: "not-found", message: expect.stringContaining("inertia_app_scroll") });
    const expected = { documentSequence: 1, target: { role: "button", label: "Change text", sensitive: false }, dialog: null };
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" }, expected))).toMatchObject({ code: "not-found", dispatched: false });
    value(await perform(transport, { action: "click", windowId, ref: "e1" }));
    expect(peer.callsOf("Runtime.evaluate").some((call) => call.expression === appScrollRefExpression("e1"))).toBe(true);
    expect(peer.inputTypes()).toContain("mousePressed");
  });

  it("types with focus, select-all for replace, and insertText", async () => {
    const { peer, transport, windowId } = await start();
    expect(value(await perform(transport, { action: "type", windowId, ref: "e2", text: "Ada", replace: true })))
      .toMatchObject({ typed: "e2", characters: 3 });
    expect(peer.callsOf("Runtime.evaluate").map((call) => call.expression)).toContain(appLocateExpression("e2", true, true));
    expect(peer.callsOf("Input.insertText")).toEqual([{ text: "Ada" }]);
    value(await perform(transport, { action: "type", windowId, ref: "e2", text: " Lovelace", replace: false }));
    expect(peer.callsOf("Runtime.evaluate").map((call) => call.expression)).toContain(appLocateExpression("e2", true, false));
    expect(failed(await perform(transport, { action: "type", windowId, ref: "e1", text: "x", replace: true }))).toMatchObject({ code: "invalid" });
    peer.model.focused = false;
    expect(failed(await perform(transport, { action: "type", windowId, ref: "e2", text: "x", replace: true }))).toMatchObject({ code: "not-found", dispatched: false });
    expect(peer.callsOf("Input.insertText")).toHaveLength(2);
  });

  it("counts typed characters in code points", async () => {
    const { transport, windowId } = await start();
    expect(value(await perform(transport, { action: "type", windowId, ref: "e2", text: "\u{1F600}a\u{1F600}", replace: true })))
      .toMatchObject({ characters: 3 });
  });

  it("binds a press to the focused control and refuses it when focus moved", async () => {
    const { peer, transport, windowId } = await start();
    const inspected = await transport.inspect({ action: "press", windowId, key: "Enter" }, new AbortController().signal);
    expect(inspected).toMatchObject({ ok: true, inspection: { target: { role: "textbox", label: "Name", sensitive: false } } });
    const expected = { documentSequence: 1, target: { role: "textbox", label: "Name", sensitive: false }, dialog: null };
    peer.model.focusedRef = "e1";
    expect(failed(await perform(transport, { action: "press", windowId, key: "Enter" }, expected)))
      .toMatchObject({ code: "not-found", dispatched: false, message: expect.stringContaining("nothing was sent") });
    expect(peer.callsOf("Input.dispatchKeyEvent")).toEqual([]);
    peer.model.focusedRef = "e2";
    value(await perform(transport, { action: "press", windowId, key: "Enter" }, expected));
    peer.model.focusedRef = null;
    expect(await transport.inspect({ action: "press", windowId, key: "Tab" }, new AbortController().signal))
      .toMatchObject({ ok: true, inspection: { target: { role: "document", label: "No focused control" } } });
  });

  it("presses allowlisted keys with the Browser's Enter and Space phases", async () => {
    const { peer, transport, windowId } = await start();
    value(await perform(transport, { action: "press", windowId, key: "Enter" }));
    expect(peer.callsOf("Input.dispatchKeyEvent")).toEqual([
      expect.objectContaining({ type: "rawKeyDown", key: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 }),
      expect.objectContaining({ type: "char", text: "\r" }),
      expect.objectContaining({ type: "keyUp", key: "Enter" }),
    ]);
    expect(peer.callsOf("Runtime.evaluate").map((call) => call.expression))
      .toEqual(expect.arrayContaining([APP_PRESS_BEGIN_EXPRESSION, APP_PRESS_CONTINUE_EXPRESSION]));
    peer.calls.length = 0;
    value(await perform(transport, { action: "press", windowId, key: "Control+Enter" }));
    expect(peer.callsOf("Input.dispatchKeyEvent").map((call) => [call.type, call.modifiers])).toEqual([["rawKeyDown", 2], ["keyUp", 2]]);
    peer.calls.length = 0;
    value(await perform(transport, { action: "press", windowId, key: "Shift+Tab" }));
    expect(peer.callsOf("Input.dispatchKeyEvent").map((call) => [call.type, call.key, call.modifiers])).toEqual([["rawKeyDown", "Tab", 8], ["keyUp", "Tab", 8]]);
    peer.calls.length = 0;
    value(await perform(transport, { action: "press", windowId, key: "Space" }));
    expect(peer.callsOf("Input.dispatchKeyEvent").map((call) => call.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    expect(failed(await perform(transport, { action: "press", windowId, key: "F5" as never }))).toMatchObject({ code: "invalid", dispatched: false });
  });

  it("refuses activation into a hidden or changed target", async () => {
    const { peer, transport, windowId } = await start();
    peer.model.pressBlocked = "nested";
    expect(failed(await perform(transport, { action: "press", windowId, key: "Enter" }))).toMatchObject({ code: "invalid", dispatched: false });
    expect(peer.callsOf("Input.dispatchKeyEvent")).toEqual([]);
    peer.model.pressBlocked = null;
    peer.model.pressContinue = "retargeted";
    expect(failed(await perform(transport, { action: "press", windowId, key: "Space" }))).toMatchObject({ code: "not-found", dispatched: true });
    expect(peer.callsOf("Input.dispatchKeyEvent").map((call) => call.type)).toEqual(["rawKeyDown", "keyUp"]);
  });

  it("scrolls by wheel at the viewport centre or a ref to the centre, returning the viewport", async () => {
    const { peer, transport, windowId } = await start();
    let scrolled = 0;
    peer.on("Input.dispatchMouseEvent", (params) => {
      if (params.type === "mouseWheel") scrolled = Number(params.deltaY);
      peer.model.viewport = { ...peer.model.viewport, scrollY: scrolled };
      return {};
    });
    expect(value(await perform(transport, { action: "scroll", windowId, deltaY: 400 })))
      .toMatchObject({ scrolled: 400, viewport: { scrollY: 400, width: 800, height: 600 } });
    expect(peer.callsOf("Input.dispatchMouseEvent")).toEqual([expect.objectContaining({ type: "mouseWheel", x: 400, y: 300, deltaY: 400 })]);
    expect(value(await perform(transport, { action: "scroll", windowId, ref: "e2" }))).toMatchObject({ scrolled: "e2", viewport: { scrollY: 300 } });
    const inspection = await transport.inspect({ action: "scroll", windowId, ref: "e3" }, new AbortController().signal);
    expect(inspection).toMatchObject({ ok: true, inspection: { target: { role: "input", label: "Sensitive field", sensitive: true } } });
  });
});

describe("App under test CDP window transport: approvals, dialogs and privacy", () => {
  it("inspects without input and refuses an approved action whose document or target changed", async () => {
    const { peer, transport, windowId } = await start();
    const inspected = await transport.inspect({ action: "click", windowId, ref: "e1" }, new AbortController().signal);
    expect(inspected).toEqual({
      ok: true,
      inspection: { windowId, windowNumber: 1, documentSequence: 1, target: { role: "button", label: "Change text", sensitive: false }, dialog: null },
    });
    expect(peer.inputTypes()).toEqual([]);
    const expected = { documentSequence: 1, target: { role: "button", label: "Change text", sensitive: false }, dialog: null };
    peer.model.controls.e1!.label = "Delete everything";
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" }, expected)))
      .toMatchObject({ code: "not-found", dispatched: false, message: expect.stringContaining("nothing was sent") });
    peer.model.controls.e1!.label = "Change text";
    peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/other" } }, "S-T1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" }, expected))).toMatchObject({ code: "not-found", dispatched: false });
    expect(failed(await perform(transport, { action: "press", windowId, key: "Enter" }, { documentSequence: 1, target: null, dialog: null })))
      .toMatchObject({ code: "not-found", dispatched: false });
    expect(peer.inputTypes()).toEqual([]);
    value(await perform(transport, { action: "click", windowId, ref: "e1" }, { ...expected, documentSequence: 2 }));
  });

  it("accepts one armed confirm, dismisses the rest, and reports dialogs once", async () => {
    const { peer, transport, windowId } = await start();
    peer.on("Input.dispatchMouseEvent", (params) => {
      if (params.type === "mouseReleased") {
        peer.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Delete it?", hasBrowserHandler: true }, "S-T1");
        peer.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Really?", hasBrowserHandler: true }, "S-T1");
      }
      return {};
    });
    const result = value(await perform(transport, { action: "click", windowId, ref: "e1", dialog: "accept" }));
    expect(peer.callsOf("Page.handleJavaScriptDialog")).toEqual([{ accept: true }, { accept: false }]);
    expect(result.dialogs).toEqual([
      { kind: "confirm", message: "Delete it?", answer: "accept" },
      { kind: "confirm", message: "Really?", answer: "dismiss" },
    ]);
    const next = value(await perform(transport, { action: "snapshot", windowId }));
    expect(next).not.toHaveProperty("dialogs");
    value(await perform(transport, { action: "click", windowId, ref: "e1" }));
    expect(peer.callsOf("Page.handleJavaScriptDialog").at(-1)).toEqual({ accept: false });
  });

  it("leaves the app's own dialog open: read-only commands fail fast and never answer it", async () => {
    const { peer, transport, windowId } = await start();
    peer.emit("Page.javascriptDialogOpening", { type: "confirm", message: "User dialog", hasBrowserHandler: true }, "S-T1");
    await until(() => transport.pendingDialog() !== null);
    expect(transport.pendingDialog()).toEqual({ windowId, windowNumber: 1, documentSequence: 1, kind: "confirm" });
    const evaluations = peer.callsOf("Runtime.evaluate").length;
    for (const command of [
      { action: "snapshot", windowId },
      { action: "screenshot", windowId },
      { action: "wait", windowId, state: "loaded", timeoutMs: 500 },
    ] as const) {
      const failure = failed(await perform(transport, command));
      expect(failure, command.action).toMatchObject({
        code: "unavailable",
        dispatched: false,
        message: "App window 1 is showing a confirm dialog, so nothing was read. Answer it with the next click, type or press using dialog: accept or dismiss.",
        pendingDialog: { windowId, kind: "confirm" },
      });
      expect(failure.message).not.toContain("User dialog");
    }
    expect(await transport.inspect({ action: "click", windowId, ref: "e1" }, new AbortController().signal))
      .toMatchObject({ ok: false, code: "unavailable", dispatched: false, pendingDialog: { kind: "confirm", documentSequence: 1 } });
    expect(peer.callsOf("Page.handleJavaScriptDialog")).toEqual([]);
    expect(peer.callsOf("Runtime.evaluate")).toHaveLength(evaluations);
    // The user answered it in the app; a dialog with no app UI would block
    // the window forever, so it is answered at once.
    peer.emit("Page.javascriptDialogClosed", {}, "S-T1");
    await until(() => transport.pendingDialog() === null);
    peer.emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "ignored", hasBrowserHandler: false }, "S-T1");
    await until(() => peer.callsOf("Page.handleJavaScriptDialog").length === 1);
    expect(peer.callsOf("Page.handleJavaScriptDialog")).toEqual([{ accept: false }]);
    await until(() => transport.pendingDialog() === null);
  });

  it("fails a read-only command when a dialog opens while it runs, and leaves the dialog open", async () => {
    const { peer, transport, windowId } = await start();
    peer.model.text = "Loading";
    setTimeout(() => {
      peer.emit("Page.javascriptDialogOpening", { type: "alert", message: "Session expired", hasBrowserHandler: true }, "S-T1");
    }, 30);
    const failure = failed(await perform(transport, { action: "wait", windowId, text: "Saved", state: "visible", timeoutMs: 2_000 }));
    expect(failure).toMatchObject({ code: "unavailable", dispatched: false, message: expect.stringContaining("showing a alert dialog") });
    expect(peer.callsOf("Page.handleJavaScriptDialog")).toEqual([]);
    expect(transport.pendingDialog()).toMatchObject({ kind: "alert" });
  });

  it("answers an open dialog as the input's dialog argument says before dispatch, and reports it once", async () => {
    const { peer, transport, windowId } = await start();
    peer.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Discard changes?", hasBrowserHandler: true }, "S-T1");
    await until(() => transport.pendingDialog() !== null);
    peer.on("Input.dispatchMouseEvent", (params) => {
      // The click raises a second confirm: the one accept was spent on the open dialog.
      if (params.type === "mouseReleased") peer.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Really?", hasBrowserHandler: true }, "S-T1");
      return {};
    });
    const result = value(await perform(transport, { action: "click", windowId, ref: "e1", dialog: "accept" }));
    const order = peer.calls.filter((call) => call.method === "Page.handleJavaScriptDialog" || call.params.type === "mousePressed")
      .map((call) => call.method === "Page.handleJavaScriptDialog" ? `dialog:${String(call.params.accept)}` : "pressed");
    expect(order).toEqual(["dialog:true", "pressed", "dialog:false"]);
    expect(result.dialogs).toEqual([
      { kind: "confirm", message: "Discard changes?", answer: "accept" },
      { kind: "confirm", message: "Really?", answer: "dismiss" },
    ]);
    expect(value(await perform(transport, { action: "snapshot", windowId }))).not.toHaveProperty("dialogs");
    // Without a dialog argument the open dialog is dismissed.
    peer.emit("Page.javascriptDialogOpening", { type: "prompt", message: "Name?", hasBrowserHandler: true }, "S-T1");
    await until(() => transport.pendingDialog() !== null);
    value(await perform(transport, { action: "type", windowId, ref: "e2", text: "Ada", replace: true }));
    expect(peer.callsOf("Page.handleJavaScriptDialog").at(-1)).toEqual({ accept: false });
  });

  it("awaits the dialog answer with one retry and keeps the dialog open until it is acknowledged", async () => {
    const { peer, transport, windowId } = await start();
    let attempts = 0;
    let acknowledge: (() => void) | null = null;
    peer.on("Page.handleJavaScriptDialog", () => {
      attempts += 1;
      if (attempts === 1) return { failWith: "busy" };
      return new Promise((resolve) => { acknowledge = () => resolve({}); });
    });
    peer.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Leave?", hasBrowserHandler: true }, "S-T1");
    await until(() => transport.pendingDialog() !== null);
    const pending = perform(transport, { action: "press", windowId, key: "Tab" });
    await until(() => acknowledge !== null);
    expect(attempts).toBe(2);
    expect(transport.pendingDialog()).toMatchObject({ kind: "confirm" });
    expect(peer.callsOf("Input.dispatchKeyEvent")).toEqual([]);
    acknowledge!();
    expect(value(await pending)).toMatchObject({ pressed: "Tab", dialogs: [{ kind: "confirm", answer: "dismiss" }] });
    expect(transport.pendingDialog()).toBeNull();
    // Two failed answers send nothing else.
    peer.on("Page.handleJavaScriptDialog", () => ({ failWith: "gone" }));
    peer.emit("Page.javascriptDialogOpening", { type: "alert", message: "Again", hasBrowserHandler: true }, "S-T1");
    await until(() => transport.pendingDialog() !== null);
    peer.calls.length = 0;
    expect(failed(await perform(transport, { action: "press", windowId, key: "Tab" }))).toMatchObject({ code: "unavailable", dispatched: false });
    expect(peer.callsOf("Page.handleJavaScriptDialog")).toHaveLength(2);
    expect(peer.inputTypes()).toEqual([]);
  });

  it("answers only the bound dialog for a dialog-only approval, and refuses a changed one", async () => {
    const { peer, transport, windowId } = await start();
    peer.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Delete?", hasBrowserHandler: true }, "S-T1");
    await until(() => transport.pendingDialog() !== null);
    const command = { action: "click", windowId, ref: "e1", dialog: "accept" } as const;
    expect(failed(await transport.perform(command, {
      signal: new AbortController().signal, expected: { documentSequence: 1, target: null, dialog: "alert" }, dialogOnly: true,
    }))).toMatchObject({ code: "not-found", dispatched: false });
    const answered = value(await transport.perform(command, {
      signal: new AbortController().signal, expected: { documentSequence: 1, target: null, dialog: "confirm" }, dialogOnly: true,
    }));
    expect(answered).toMatchObject({ answeredDialog: { kind: "confirm", answer: "accept" }, sent: false, nextStep: expect.stringContaining("inertia_app_snapshot") });
    expect(peer.callsOf("Page.handleJavaScriptDialog")).toEqual([{ accept: true }]);
    expect(peer.inputTypes()).toEqual([]);
    // An approval made while no dialog was open is refused once one opens.
    peer.emit("Page.javascriptDialogOpening", { type: "alert", message: "Hi", hasBrowserHandler: true }, "S-T1");
    await until(() => transport.pendingDialog() !== null);
    expect(failed(await perform(transport, { action: "press", windowId, key: "Tab" }, {
      documentSequence: 1, target: { role: "textbox", label: "Name", sensitive: false }, dialog: null,
    }))).toMatchObject({ code: "not-found", dispatched: false });
    expect(peer.inputTypes()).toEqual([]);
  });

  it("bounds dialog reports like the Browser", async () => {
    const { peer, transport, windowId } = await start();
    // A page shows one dialog at a time: the next opens once this one is answered.
    for (let index = 0; index < 25; index += 1) {
      peer.emit("Page.javascriptDialogOpening", { type: "alert", message: `${index}:${"m".repeat(2_000)}`, hasBrowserHandler: false }, "S-T1");
      await until(() => peer.callsOf("Page.handleJavaScriptDialog").length === index + 1);
    }
    const snapshot = value(await perform(transport, { action: "snapshot", windowId }));
    const dialogs = snapshot.dialogs as Array<{ message: string }>;
    expect(dialogs.length).toBeLessThanOrEqual(20);
    expect(dialogs.every((dialog) => dialog.message.length <= 1_024)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(dialogs), "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect((snapshot.dialogsOmitted as number) + dialogs.length).toBe(25);
  });

  it("redacts values typed into sensitive fields from later text, titles and logs, per document", async () => {
    const { peer, ctx, transport, windowId } = await start();
    value(await perform(transport, { action: "type", windowId, ref: "e3", text: "hunter2-secret", replace: true }));
    expect(peer.callsOf("Runtime.evaluate").some((call) => String(call.expression).includes("privacy.remember(state"))).toBe(true);
    peer.model.text = "Welcome back, your password is hunter2-secret!";
    peer.model.title = "hunter2-secret - Fixture";
    const snapshot = value(await perform(transport, { action: "snapshot", windowId }));
    expect(JSON.stringify(snapshot)).not.toContain("hunter2-secret");
    expect(snapshot.text).toContain("[redacted]");
    peer.emit("Target.targetInfoChanged", { targetInfo: { targetId: "T1", type: "page", url: "http://localhost:5173/", title: "hunter2-secret" } }, undefined);
    await until(() => transport.windows()[0]?.title !== "Fixture");
    expect(transport.windows()[0]!.title).not.toContain("hunter2-secret");
    peer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "pw=hunter2-secret" }] }, "S-T1");
    await until(() => ctx.log.mock.calls.length === 1);
    expect(ctx.log.mock.calls[0]![1]).not.toContain("hunter2-secret");
    // Text typed into an ordinary field is not remembered.
    value(await perform(transport, { action: "type", windowId, ref: "e2", text: "Ada", replace: true }));
    peer.model.text = "Hello Ada";
    expect(value(await perform(transport, { action: "snapshot", windowId })).text).toBe("Hello Ada");
    // A new document starts with nothing remembered.
    peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/next" } }, "S-T1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    peer.model.text = "hunter2-secret";
    expect(value(await perform(transport, { action: "snapshot", windowId })).text).toBe("hunter2-secret");
  });

  it("remembers a secret before Input.insertText, so an app that echoes it at once is already redacted", async () => {
    const { peer, ctx, transport, windowId } = await start();
    const titles: string[] = [];
    ctx.windowsChanged.mockImplementation(() => { titles.push(transport.windows()[0]?.title ?? ""); });
    let finish: (() => void) | null = null;
    peer.on("Input.insertText", (params) => {
      // The page echoes the value before Chromium answers the insert.
      peer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `typed ${String(params.text)}` }] }, "S-T1");
      peer.emit("Target.targetInfoChanged", { targetInfo: { targetId: "T1", type: "page", url: "http://localhost:5173/", title: `Hi ${String(params.text)}` } });
      return new Promise((resolve) => { finish = () => resolve({}); });
    });
    const pending = perform(transport, { action: "type", windowId, ref: "e3", text: "hunter2-secret", replace: true });
    await until(() => ctx.log.mock.calls.length === 1 && titles.length > 0);
    // Nothing was selected or focused before the value was remembered.
    const focusIndex = peer.calls.findIndex((call) => call.params.expression === appLocateExpression("e3", true, true));
    expect(focusIndex).toBeGreaterThan(-1);
    expect(ctx.log.mock.calls[0]).toEqual(["console", "typed [redacted]"]);
    expect(titles.at(-1)).toBe("Hi [redacted]");
    expect(transport.windows()[0]!.title).toBe("Hi [redacted]");
    finish!();
    expect(value(await pending)).toMatchObject({ typed: "e3", title: "Hi [redacted]" });
  });

  it("brings secrets found by a scan into runtime memory without ever returning them", async () => {
    const { peer, ctx, transport, windowId } = await start();
    peer.model.remember = ["s3cret-from-page"];
    peer.model.text = "Stored token s3cret-from-page";
    const snapshot = value(await perform(transport, { action: "snapshot", windowId }));
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("s3cret-from-page");
    expect(serialized).not.toContain("remember");
    expect(snapshot.text).toBe("Stored token [redacted]");
    peer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "token=S3CRET-FROM-PAGE" }] }, "S-T1");
    peer.emit("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "Error: bad s3cret-from-page" } } }, "S-T1");
    peer.emit("Log.entryAdded", { entry: { level: "error", text: "auth s3cret-from-page failed" } }, "S-T1");
    peer.emit("Target.targetInfoChanged", { targetInfo: { targetId: "T1", type: "page", url: "http://localhost:5173/", title: "s3cret-from-page" } });
    await until(() => ctx.log.mock.calls.length === 3 && transport.windows()[0]?.title !== "Fixture");
    expect(ctx.log.mock.calls).toEqual([
      ["console", "token=[redacted]"],
      ["exception", "Error: bad [redacted]"],
      ["console", "error: auth [redacted] failed"],
    ]);
    expect(transport.windows()[0]!.title).toBe("[redacted]");
    // The launch's own memory outlives the document, for stdout, stderr and crash lines too.
    peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/next" } }, "S-T1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.redactLog("stdout: s3cret-from-page", false)).toBe("stdout: [redacted]");
    // A short value is hidden only as a whole word; a cut line loses a partial tail.
    peer.model.remember = ["pin", "abcdefgh"];
    value(await perform(transport, { action: "snapshot", windowId }));
    expect(transport.redactLog("pin spinning pin", false)).toBe("[redacted] spinning [redacted]");
    expect(transport.redactLog("value abcd", true)).toBe("value");
    expect(transport.redactLog("nothing secret", false)).toBe("nothing secret");
  });
});

describe("App under test CDP window transport: interruption and serialization", () => {
  it("fails an action interrupted by navigation before its input with not-found", async () => {
    const { peer, transport, windowId } = await start();
    const original = peer.handlers.get("Runtime.evaluate")!;
    peer.on("Runtime.evaluate", (params, sessionId) => {
      if (params.expression !== appLocateExpression("e1")) return original(params, sessionId);
      // The window navigates while the ref is being located: no reply comes.
      peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/elsewhere" } }, "S-T1");
      return undefined;
    });
    const result = failed(await perform(transport, { action: "click", windowId, ref: "e1" }));
    expect(result).toMatchObject({ code: "not-found", dispatched: false, message: expect.stringContaining("take a new inertia_app_snapshot") });
    expect(peer.inputTypes()).not.toContain("mousePressed");
  });

  it("treats a navigation or close after the input as the action's result", async () => {
    const { peer, transport, windowId } = await start();
    peer.on("Input.dispatchMouseEvent", (params) => {
      if (params.type === "mouseReleased") {
        peer.emit("Page.frameStartedLoading", { frameId: "F-T1" }, "S-T1");
        peer.emit("Page.frameNavigated", { frame: { id: "F-T1", url: "http://localhost:5173/next" } }, "S-T1");
        setTimeout(() => peer.emit("Page.frameStoppedLoading", { frameId: "F-T1" }, "S-T1"), 20);
      }
      return {};
    });
    expect(value(await perform(transport, { action: "click", windowId, ref: "e1" }))).toMatchObject({ clicked: "e1", navigated: true });
    peer.on("Input.dispatchMouseEvent", (params) => {
      if (params.type === "mouseReleased") {
        peer.emit("Target.targetDestroyed", { targetId: "T1" });
        return undefined;
      }
      return {};
    });
    expect(value(await perform(transport, { action: "click", windowId, ref: "e1" }))).toMatchObject({ clicked: "e1", windowClosed: true });
    expect(failed(await perform(transport, { action: "snapshot", windowId }))).toMatchObject({ code: "not-found" });
  });

  it("runs one action at a time and times out a queued one with nothing sent", async () => {
    const { peer, transport, windowId } = await start(undefined, { queueWaitMs: 50 });
    let release: (() => void) | null = null;
    peer.on("Input.insertText", () => new Promise((resolve) => { release = () => resolve({}); }));
    const first = perform(transport, { action: "type", windowId, ref: "e2", text: "slow", replace: true });
    await until(() => release !== null);
    const second = await perform(transport, { action: "click", windowId, ref: "e1" });
    expect(second).toMatchObject({ ok: false, code: "timeout", dispatched: false });
    release!();
    expect(value(await first)).toMatchObject({ typed: "e2" });
  });

  it("times out at the action deadline, says input was sent, and still releases the mouse", async () => {
    const { peer, transport, windowId } = await start(undefined, { inputBudgetMs: 80 });
    peer.on("Input.dispatchMouseEvent", (params) => (params.type === "mousePressed" ? undefined : {}));
    expect(failed(await perform(transport, { action: "click", windowId, ref: "e1" }))).toMatchObject({ code: "timeout", dispatched: true });
    await until(() => peer.inputTypes().includes("mouseReleased"));
    expect(peer.callsOf("Input.dispatchMouseEvent").at(-1)).toMatchObject({ type: "mouseReleased", x: 50, y: 40, buttons: 0 });
  });

  it("releases the mouse when the call is cancelled between press and release", async () => {
    const { peer, transport, windowId } = await start();
    const controller = new AbortController();
    peer.on("Input.dispatchMouseEvent", (params) => {
      if (params.type !== "mousePressed") return {};
      setTimeout(() => controller.abort(), 5);
      return undefined;
    });
    expect(failed(await transport.perform({ action: "click", windowId, ref: "e1" }, { signal: controller.signal })))
      .toMatchObject({ code: "cancelled", dispatched: true });
    await until(() => peer.inputTypes().includes("mouseReleased"));
  });

  it("cancels with the caller's signal", async () => {
    const { peer, transport, windowId } = await start();
    peer.on("Runtime.evaluate", () => undefined);
    const controller = new AbortController();
    const pending = transport.perform({ action: "snapshot", windowId }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(failed(await pending)).toMatchObject({ code: "cancelled", dispatched: false });
  });

  it("fails every command once the pipe closes", async () => {
    const { peer, ctx, transport, windowId } = await start();
    ctx.windowsChanged.mockClear();
    peer.output.end();
    await until(() => transport.windows().length === 0);
    expect(ctx.windowsChanged).toHaveBeenCalled();
    expect(failed(await perform(transport, { action: "snapshot", windowId }))).toMatchObject({ code: "unavailable" });
    // fd 3 stays open: Chromium decides when the app ends.
    expect(peer.input.destroyed).toBe(false);
  });
});

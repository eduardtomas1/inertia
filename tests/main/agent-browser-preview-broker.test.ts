import { describe, expect, it, vi } from "vitest";

import type { PreviewAgentTarget } from "../../src/main/preview-agent-page";

const electronState = vi.hoisted(() => ({
  interactionTimeline: [] as string[],
  viewOptions: [] as Array<Record<string, unknown>>,
  contents: [] as Array<{
    id: number;
    capturePage: {
      getMockImplementation(): (() => Promise<unknown>) | undefined;
      mockImplementationOnce(implementation: () => Promise<unknown>): unknown;
    };
    debugger: {
      emitMessage(method: string, params: Record<string, unknown>): void;
      isAttached: () => boolean;
      sendCommand: ReturnType<typeof vi.fn<(
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>>>;
    };
    navigationHistory: {
      canGoBack: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
      getActiveIndex: ReturnType<typeof vi.fn>;
      getEntryAtIndex: ReturnType<typeof vi.fn>;
      goBack: ReturnType<typeof vi.fn>;
      removeEntryAtIndex: ReturnType<typeof vi.fn>;
    };
    emit(name: string, ...args: unknown[]): void;
    on(name: string, handler: (...args: unknown[]) => void): void;
    getURL(): string;
    insertedText: string[];
    sentInputs: Array<Record<string, unknown>>;
    setTitle(title: string): void;
    setURL(url: string): void;
  }>,
  sessions: [] as Array<{
    permissionChecks: number;
    permissionRequests: number;
    downloadHandlers: number;
    clearStorageData: ReturnType<typeof vi.fn>;
    emitBeforeRequest(details: Record<string, unknown>): void;
    emitCompleted(details: Record<string, unknown>): void;
    emitError(details: Record<string, unknown>): void;
    hasEvidenceListeners(): boolean;
  }>,
}));

vi.mock("electron", () => {
  const sessionsByPartition = new Map<string, FakeSession>();
  let nextWebContentsId = 1;

  class FakeSession {
    permissionChecks = 0;
    permissionRequests = 0;
    downloadHandlers = 0;
    clearStorageData = vi.fn(async () => undefined);
    private beforeRequest: ((details: Record<string, unknown>, callback: (response: object) => void) => void) | null = null;
    private completed: ((details: Record<string, unknown>) => void) | null = null;
    private error: ((details: Record<string, unknown>) => void) | null = null;
    readonly webRequest = {
      onBeforeRequest: (listener: typeof this.beforeRequest) => { this.beforeRequest = listener; },
      onCompleted: (listener: typeof this.completed) => { this.completed = listener; },
      onErrorOccurred: (listener: typeof this.error) => { this.error = listener; },
    };

    constructor() {
      electronState.sessions.push(this);
    }

    setPermissionCheckHandler(): void { this.permissionChecks += 1; }
    setPermissionRequestHandler(): void { this.permissionRequests += 1; }
    on(name: string): void {
      if (name === "will-download") this.downloadHandlers += 1;
    }
    emitBeforeRequest(details: Record<string, unknown>): void {
      this.beforeRequest?.(details, () => undefined);
    }
    emitCompleted(details: Record<string, unknown>): void { this.completed?.(details); }
    emitError(details: Record<string, unknown>): void { this.error?.(details); }
    hasEvidenceListeners(): boolean {
      return Boolean(this.beforeRequest || this.completed || this.error);
    }
  }

  class FakeImage {
    constructor(private readonly width = 1_920, private readonly height = 1_080) {}
    getSize() { return { width: this.width, height: this.height }; }
    resize(options: { width: number; height?: number }) {
      const ratio = options.width / this.width;
      return new FakeImage(options.width, options.height ?? Math.max(1, Math.floor(this.height * ratio)));
    }
    toPNG() { return Buffer.from("bounded-png"); }
  }

  class FakeWebContents {
    readonly id = nextWebContentsId++;
    readonly navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      clear: vi.fn(),
      getActiveIndex: vi.fn(() => this.url === "about:blank" ? 0 : 2),
      getEntryAtIndex: vi.fn((index: number) => ({
        title: "",
        url: index === 0 ? "about:blank" : this.url,
      })),
      goBack: vi.fn(),
      goForward: vi.fn(),
      removeEntryAtIndex: vi.fn(() => true),
    };
    readonly sentInputs: Array<Record<string, unknown>> = [];
    readonly insertedText: string[] = [];
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    private url = "";
    private title = "";
    private destroyed = false;
    private readonly debuggerMessageHandlers: Array<(
      event: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => void> = [];
    readonly debugger = {
      attached: false,
      attach: vi.fn(() => { this.debugger.attached = true; }),
      detach: vi.fn(() => { this.debugger.attached = false; }),
      isAttached: vi.fn(() => this.debugger.attached),
      on: vi.fn((name: string, handler: (
        event: unknown,
        method: string,
        params: Record<string, unknown>,
      ) => void) => {
        if (name === "message") this.debuggerMessageHandlers.push(handler);
      }),
      emitMessage: (method: string, params: Record<string, unknown>): void => {
        for (const handler of this.debuggerMessageHandlers) handler({}, method, params);
      },
      sendCommand: vi.fn(async (method: string) => {
        if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
        if (method === "Runtime.evaluate") {
          return { result: { type: "object", subtype: "array", objectId: "boundary-hosts" } };
        }
        if (method === "Runtime.getProperties") {
          return {
            result: [{ name: "length", value: { type: "number", value: 0 } }],
          };
        }
        return undefined;
      }),
    };

    constructor(readonly session: FakeSession) {
      electronState.contents.push(this);
    }

    setWindowOpenHandler(): void {}
    on(name: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    }
    once(name: string, handler: (...args: unknown[]) => void): void {
      const onceHandler = (...args: unknown[]): void => {
        this.removeListener(name, onceHandler);
        handler(...args);
      };
      this.on(name, onceHandler);
    }
    removeListener(name: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(name);
      if (!handlers) return;
      this.handlers.set(name, handlers.filter((candidate) => candidate !== handler));
    }
    emit(name: string, ...args: unknown[]): void {
      const handlers = this.handlers.get(name)?.slice() ?? [];
      for (const handler of handlers) handler(...args);
    }
    async loadURL(url: string): Promise<void> {
      this.url = url;
      this.title = new URL(url).pathname === "/" ? "Local app" : new URL(url).pathname.slice(1);
      this.debugger.emitMessage("Page.frameNavigated", {
        frame: { id: "main", url },
      });
      this.emit("dom-ready");
      this.emit("did-navigate", {}, url);
    }
    getURL(): string { return this.url; }
    setURL(url: string): void { this.url = url; }
    getTitle(): string { return this.title; }
    async executeJavaScriptInIsolatedWorld(
      _worldId: number,
      scripts: Array<{ code: string }>,
    ): Promise<boolean | number> {
      return scripts[0]?.code.includes("__inertia_boundary_count__") ? 3 : false;
    }
    setTitle(title: string): void { this.title = title; }
    isLoading(): boolean { return false; }
    isDestroyed(): boolean { return this.destroyed; }
    reload(): void {}
    stop(): void {}
    close(): void { this.destroyed = true; }
    sendInputEvent(input: Record<string, unknown>): void {
      this.sentInputs.push(input);
      electronState.interactionTimeline.push(String(input.type));
      this.emit("input-event", {}, input);
    }
    async insertText(text: string): Promise<void> { this.insertedText.push(text); }
    readonly capturePage = vi.fn(async (): Promise<FakeImage> => new FakeImage());
  }

  class FakeWebContentsView {
    readonly webContents: FakeWebContents;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    constructor(options: Record<string, unknown>) {
      electronState.viewOptions.push(options);
      const preferences = options.webPreferences as { partition?: string } | undefined;
      const partition = preferences?.partition ?? crypto.randomUUID();
      const browserSession = sessionsByPartition.get(partition) ?? new FakeSession();
      sessionsByPartition.set(partition, browserSession);
      this.webContents = new FakeWebContents(browserSession);
    }
    setBounds(bounds: typeof this.bounds): void {
      this.bounds = bounds;
      electronState.interactionTimeline.push(
        `bounds:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
      );
    }
    getBounds(): typeof this.bounds { return this.bounds; }
    setBackgroundColor(): void {}
  }

  return { WebContentsView: FakeWebContentsView };
});

const pageTools = vi.hoisted(() => ({
  AGENT_BROWSER_WORLD_ID: 999,
  agentPageActivationBlocked: vi.fn<() => Promise<"disabled" | "file" | null>>(async () => null),
  agentPageHasSensitiveEvidence: vi.fn(async () => false),
  agentPageInputRefusal: vi.fn<() => Promise<"disabled" | "file" | "nested" | "retargeted" | null>>(async () => null),
  agentPageRefHasFocus: vi.fn(async () => true),
  installAgentPagePrivacyGuard: vi.fn(async () => undefined),
  locateAgentPageRef: vi.fn<() => Promise<PreviewAgentTarget>>(async () => ({
    found: true, blocked: false, disabled: false, editable: true,
    label: "Run checks", x: 42, y: 28,
  })),
  semanticPageSnapshot: vi.fn(async () => JSON.stringify({ title: "Local app", elements: [] })),
  setAgentPageInputGuard: vi.fn<(
    contents: unknown,
    active: boolean,
    expectedClickRef?: string,
  ) => Promise<void>>(async () => undefined),
  showAgentPageCursor: vi.fn(async () => undefined),
  waitForAgentPageHover: vi.fn(async () => undefined),
}));

vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewBroker } from "../../src/main/preview-broker";
import {
  MAX_AGENT_BROWSER_TEXT_BYTES,
  parseAgentBrowserResult,
} from "../../src/shared/agent-browser";

const conversationId = "11111111-1111-4111-8111-111111111111";
const runIdentity = {
  conversationId,
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
};

function harness() {
  const children: Array<{
    webContents: {
      sentInputs: Array<Record<string, unknown>>;
      insertedText: string[];
    };
  }> = [];
  const window = {
    contentView: {
      children,
      addChildView: (view: typeof children[number]) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
        children.push(view);
      },
      removeChildView: (view: typeof children[number]) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      },
    },
    webContents: { isDestroyed: () => false, send: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 1_200, height: 800 }),
  };
  const broker = new PreviewBroker({
    getWindow: () => window as never,
    openExternal: vi.fn(async () => undefined),
    stateChannel: "preview-state",
  });
  return { broker, children, window };
}

describe("agent-owned native Browser", () => {
  it("keeps one hardened ephemeral tab session and manages bounded pages atomically", async () => {
    const { broker } = harness();
    const initial = await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    expect(initial.tabs).toHaveLength(1);
    expect(initial.url).toBe("http://127.0.0.1:3000/");
    expect(electronState.viewOptions[0]).toMatchObject({
      webPreferences: {
        partition: expect.stringMatching(/^inertia-preview-/u),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        preload: expect.stringMatching(/preview-agent-privacy\.cjs$/u),
      },
    });
    expect(electronState.contents[0]!.debugger.sendCommand)
      .toHaveBeenCalledWith("Page.enable");
    expect(electronState.contents[0]!.debugger.sendCommand)
      .toHaveBeenCalledWith("DOM.enable");
    expect(electronState.contents[0]!.debugger.isAttached()).toBe(true);
    expect(electronState.contents[0]!.navigationHistory.clear).not.toHaveBeenCalled();
    expect(electronState.contents[0]!.navigationHistory.removeEntryAtIndex)
      .toHaveBeenCalledExactlyOnceWith(0);
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });
    expect(electronState.contents[0]!.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: false },
    );
    expect(electronState.contents[0]!.debugger.isAttached()).toBe(true);
    expect((electronState.viewOptions[0]!.webPreferences as { partition: string }).partition)
      .not.toMatch(/^persist:/u);
    expect(electronState.sessions[0]).toMatchObject({
      permissionChecks: 1,
      permissionRequests: 1,
      downloadHandlers: 1,
    });

    const second = await broker.tab({
      ownerId: "primary",
      contextId: conversationId,
      action: "open",
      url: "http://127.0.0.1:3000/settings",
    });
    expect(second.tabs).toHaveLength(2);
    expect(second.url).toBe("http://127.0.0.1:3000/settings");
    await expect(broker.tab({
      ownerId: "primary",
      contextId: conversationId,
      action: "open",
      url: "https://example.com/",
    })).rejects.toThrow("Only local development pages");
    const afterRejectedOpen = await broker.perform(conversationId, { action: "tabs" });
    expect(afterRejectedOpen.ok).toBe(true);
    if (afterRejectedOpen.ok) expect(afterRejectedOpen.state.tabs).toHaveLength(2);

    const closed = await broker.tab({
      ownerId: "primary",
      contextId: conversationId,
      action: "close",
      tabId: second.activeTabId,
    });
    expect(closed.tabs).toHaveLength(1);
  });

  it("publishes evidence only when its revision changes during runaway title updates", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker, window } = harness();
    const initial = await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    const contents = electronState.contents[contentsOffset]!;
    const send = window.webContents.send;
    send.mockClear();

    for (let frame = 0; frame < 64; frame += 1) {
      contents.setTitle(`Animated frame ${frame}`);
      contents.emit("page-title-updated");
    }

    expect(send).toHaveBeenCalledTimes(64);
    const titleUpdates = send.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(titleUpdates.every((update) => !Object.hasOwn(update, "evidence"))).toBe(true);
    expect(titleUpdates.at(-1)).toMatchObject({
      tabs: [expect.objectContaining({ title: "Animated frame 63" })],
    });

    contents.emit("console-message", {
      level: "error",
      message: "Animation failed safely",
      preventDefault: vi.fn(),
    });
    await vi.waitFor(() => expect(send.mock.calls.some((call) =>
      Object.hasOwn(call[1] as object, "evidence"))).toBe(true));
    const evidenceUpdates = send.mock.calls
      .map((call) => call[1] as { evidence?: { revision: number; entries: unknown[] } })
      .filter((update) => update.evidence !== undefined);
    expect(evidenceUpdates).toHaveLength(1);
    expect(evidenceUpdates[0]!.evidence).toMatchObject({
      revision: initial.evidence.revision + 1,
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "console-error" }),
      ]),
    });
  });

  it("returns semantic and visual evidence and renders exact visible interaction input", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true, text: expect.stringContaining("Local app") });
    const screenshot = await broker.perform(conversationId, { action: "screenshot" });
    expect(screenshot).toMatchObject({
      ok: true,
      image: { mimeType: "image/png", data: Buffer.from("bounded-png").toString("base64") },
    });
    expect(pageTools.agentPageHasSensitiveEvidence).toHaveBeenCalled();
    await expect(broker.perform(conversationId, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({ ok: true });
    expect(pageTools.showAgentPageCursor).toHaveBeenCalledWith(
      expect.anything(), 42, 28, "Agent click",
    );
    expect(children[0]!.webContents.sentInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mouseDown", x: 42, y: 28 }),
      expect.objectContaining({ type: "mouseUp", x: 42, y: 28 }),
    ]));
    expect(pageTools.setAgentPageInputGuard).toHaveBeenCalledWith(expect.anything(), true, "e1");
    expect(pageTools.setAgentPageInputGuard).toHaveBeenCalledWith(expect.anything(), false);
    expect(electronState.contents[contentsOffset]!.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: true, cancel: true },
    );
    await expect(broker.perform(conversationId, {
      action: "type", ref: "e2", text: "hello", replace: true,
    })).resolves.toMatchObject({ ok: true });
    expect(children[0]!.webContents.insertedText).toEqual(["hello"]);
  });

  it("keeps page-authored element names out of click and type activity labels", async () => {
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    const maximumName = "界".repeat(300);
    pageTools.locateAgentPageRef.mockResolvedValue({
      found: true, blocked: false, disabled: false, editable: true,
      label: maximumName, x: 42, y: 28,
    });

    const clicked = await broker.perform(conversationId, { action: "click", ref: "e1" });
    expect(clicked).toMatchObject({ ok: true });
    expect(parseAgentBrowserResult(clicked)).not.toBeNull();
    if (!clicked.ok) return;
    expect(clicked.state.activity?.label).toBe("Agent clicked a page element");
    expect(clicked.state.activity?.label).not.toContain(maximumName);

    const typed = await broker.perform(conversationId, {
      action: "type", ref: "e2", text: "hello", replace: true,
    });
    expect(typed).toMatchObject({ ok: true });
    expect(parseAgentBrowserResult(typed)).not.toBeNull();
    if (!typed.ok) return;
    expect(typed.state.activity?.label).toBe("Agent typed in a page element");
    expect(typed.state.activity?.label).not.toContain(maximumName);
    await expect(broker.perform(conversationId, { action: "tabs" }))
      .resolves.toSatisfy((result) => parseAgentBrowserResult(result) !== null);

    pageTools.locateAgentPageRef.mockResolvedValue({
      found: true, blocked: false, disabled: false, editable: true,
      label: "Run checks", x: 42, y: 28,
    });
  });

  it("refuses typing when a focus-handler microtask moves focus to another element", async () => {
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    pageTools.agentPageRefHasFocus.mockResolvedValueOnce(false);

    await expect(broker.perform(conversationId, {
      action: "type", ref: "e2", text: "must stay out", replace: true,
    })).resolves.toMatchObject({
      ok: false,
      code: "not-found",
      message: "That page element lost focus before typing. Inspect the page again for current refs.",
    });
    expect(pageTools.agentPageRefHasFocus).toHaveBeenCalledWith(expect.anything(), "e2");
    expect(children[0]!.webContents.insertedText).toEqual([]);
  });

  it("reports a click refused by the delivery-time exact-ref guard", async () => {
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    pageTools.agentPageInputRefusal.mockResolvedValueOnce("retargeted");

    await expect(broker.perform(conversationId, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({
        ok: false,
        code: "not-found",
        message: "That page element changed during the click. Inspect the page again for current refs.",
      });
    expect(children[0]!.webContents.sentInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mouseDown" }),
      expect.objectContaining({ type: "mouseUp" }),
    ]));
  });

  it("reports activation rejected during trusted key delivery", async () => {
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    pageTools.agentPageInputRefusal.mockResolvedValueOnce("disabled");

    await expect(broker.perform(conversationId, { action: "press", key: "Enter" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "The focused page element is disabled.",
      });
  });

  it("preserves a preload refusal while the rejected document navigates away", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/source",
    });
    const contents = electronState.contents[contentsOffset]!;
    expect(broker.reportInputRefusal(contents as never, "disabled")).toBe(false);
    contents.on("input-event", (_event: unknown, input: unknown) => {
      const inputType = (input as { type?: string }).type;
      if (inputType !== "keyDown") return;
      expect(broker.reportInputRefusal(contents as never, "disabled")).toBe(true);
      contents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
        url: "http://127.0.0.1:3000/destination",
      });
      queueMicrotask(() => contents.emit("did-stop-loading"));
    });

    await expect(broker.perform(conversationId, { action: "press", key: "Enter" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "The focused page element is disabled.",
    });
    expect(broker.reportInputRefusal(contents as never, "disabled")).toBe(false);
  });

  it("keeps sanitized page evidence local to its exact owner and live chat", async () => {
    const contentsOffset = electronState.contents.length;
    const sessionOffset = electronState.sessions.length;
    const { broker } = harness();
    const initial = await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/private/path?access_token=never-store#fragment",
    });
    const contents = electronState.contents[contentsOffset]!;
    const browserSession = electronState.sessions[sessionOffset]!;
    expect(browserSession.hasEvidenceListeners()).toBe(true);

    const preventDefault = vi.fn();
    contents.emit("console-message", {
      level: "error",
      message: "password=console-value from /Users/alice/private.ts",
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    const pwdPreventDefault = vi.fn();
    contents.emit("console-message", {
      level: "error",
      message: "pwd=hunter2",
      preventDefault: pwdPreventDefault,
    });
    expect(pwdPreventDefault).toHaveBeenCalledOnce();
    const uriPreventDefault = vi.fn();
    contents.emit("console-message", {
      level: "error",
      message: "MONGODB_URI=mongodb://alice:hunter2@localhost/private",
      preventDefault: uriPreventDefault,
    });
    expect(uriPreventDefault).toHaveBeenCalledOnce();
    for (const message of [
      "tok\u0000en=control-broker-short",
      "pass\u202dword=bidi-broker-short",
      "tok\u200ben=zero-width-broker-short",
      "tok％65n=compat-percent-broker-short",
      "sk%00-control-broker-prefix1234",
      "sk\u0000-literal-broker-prefix1234",
      "gho_abcdefghijklmnop",
    ]) {
      const controlPreventDefault = vi.fn();
      contents.emit("console-message", {
        level: "error",
        message,
        preventDefault: controlPreventDefault,
      });
      expect(controlPreventDefault).toHaveBeenCalledOnce();
    }
    for (const message of [
      "Failure at C://Users/Jane Doe/private/file.txt",
      "Failure in C:Users\\Jane Doe\\private\\config",
      "Failure opening /root-broker-secret",
      "Failure at //private-server/secret share/file.txt",
      "Failed in src/private/config",
      "Failed in src/config",
      "Failed in src\\private\\config",
      "Failed in src/.env",
      "Failed in ./Dockerfile",
    ]) {
      const pathPreventDefault = vi.fn();
      contents.emit("console-message", {
        level: "error",
        message,
        preventDefault: pathPreventDefault,
      });
      expect(pathPreventDefault).toHaveBeenCalledOnce();
    }
    await vi.waitFor(() => expect(pageTools.agentPageHasSensitiveEvidence)
      .toHaveBeenCalledWith(contents));
    pageTools.agentPageHasSensitiveEvidence.mockResolvedValueOnce(true);
    contents.emit("console-message", {
      level: "error",
      message: "hunter2",
      preventDefault: vi.fn(),
    });

    browserSession.emitBeforeRequest({
      id: 71,
      url: "http://127.0.0.1:3000/api?authorization=network-value#hidden",
      method: "POST",
      resourceType: "xhr",
      webContentsId: contents.id,
      requestHeaders: { Authorization: "Bearer never-store" },
      uploadData: [{ bytes: Buffer.from("request-body-never-store") }],
    });
    browserSession.emitCompleted({
      id: 71,
      url: "http://127.0.0.1:3000/api?authorization=network-value#hidden",
      method: "POST",
      resourceType: "xhr",
      webContentsId: contents.id,
      statusCode: 503,
      statusLine: "HTTP/1.1 503 raw-status-never-store",
      responseHeaders: { "Set-Cookie": ["never-store"] },
    });

    await expect(broker.perform(runIdentity, { action: "screenshot" }))
      .resolves.toMatchObject({ ok: true });
    const state = await broker.tab({
      ownerId: "primary",
      contextId: conversationId,
      action: "activate",
      tabId: initial.activeTabId,
    });
    const serialized = JSON.stringify(state.evidence);
    expect(serialized).not.toContain("console-value");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("MONGODB_URI");
    expect(serialized).not.toContain("mongodb://alice");
    expect(serialized).not.toContain("control-broker-short");
    expect(serialized).not.toContain("bidi-broker-short");
    expect(serialized).not.toContain("zero-width-broker-short");
    expect(serialized).not.toContain("compat-percent-broker-short");
    expect(serialized).not.toContain("control-broker-prefix1234");
    expect(serialized).not.toContain("literal-broker-prefix1234");
    expect(serialized).not.toContain("gho_abcdefghijklmnop");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("C:Users");
    expect(serialized).not.toContain("root-broker-secret");
    expect(serialized).not.toContain("private-server");
    expect(serialized).not.toContain("secret share");
    expect(serialized).not.toContain("src/private/config");
    expect(serialized).not.toContain("src/config");
    expect(serialized).not.toContain("src\\private\\config");
    expect(serialized).not.toContain("src/.env");
    expect(serialized).not.toContain("./Dockerfile");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("network-value");
    expect(serialized).not.toContain("never-store");
    expect(serialized).not.toContain("request-body");
    expect(serialized).not.toContain("raw-status");
    expect(serialized).not.toContain("private/path");
    expect(state.evidence.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "console-error",
        detail: "Sensitive console detail hidden",
        redacted: true,
      }),
      expect.objectContaining({
        kind: "network-failure",
        summary: "POST xhr failed",
        detail: "HTTP 503 · http://127.0.0.1:3000",
      }),
      expect.objectContaining({
        kind: "screenshot",
        runId: runIdentity.runId,
        turnId: runIdentity.turnId,
        screenshot: expect.objectContaining({ available: true }),
      }),
    ]));
    const consoleEvidence = state.evidence.entries.filter(
      (entry) => entry.kind === "console-error",
    );
    expect(consoleEvidence.every((entry) =>
      entry.redacted
      && (
        entry.detail === "Sensitive console detail hidden"
        || entry.detail === "<redacted>"
      )
    )).toBe(true);
    expect(consoleEvidence.reduce((total, entry) => total + entry.occurrences, 0))
      .toBe(20);

    const capture = state.evidence.entries.find((entry) => entry.kind === "screenshot");
    expect(capture).toBeDefined();
    const request = {
      ownerId: "primary",
      contextId: conversationId,
      evidenceId: capture!.id,
    };
    expect(broker.evidenceImage(request)).toEqual({
      mimeType: "image/png",
      data: Buffer.from("bounded-png").toString("base64"),
    });
    expect(broker.evidenceImage({ ...request, ownerId: "secondary" })).toBeNull();
    expect(broker.evidenceImage({
      ...request,
      contextId: "44444444-4444-4444-8444-444444444444",
    })).toBeNull();

    broker.close("primary", conversationId);
    expect(browserSession.hasEvidenceListeners()).toBe(false);
    expect(browserSession.clearStorageData).toHaveBeenCalledOnce();
    expect(broker.evidenceImage(request)).toBeNull();
  });

  it("holds queued work until click-triggered main-frame navigation settles", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/source",
    });
    const contents = electronState.contents[contentsOffset]!;
    const click = broker.perform(conversationId, { action: "click", ref: "e1" });
    await vi.waitFor(() => expect(contents.sentInputs)
      .toContainEqual(expect.objectContaining({ type: "mouseUp" })));
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "http://127.0.0.1:3000/destination",
    });
    let clickSettled = false;
    let queuedSettled = false;
    void click.finally(() => { clickSettled = true; });
    const queued = broker.perform(conversationId, { action: "tabs" })
      .finally(() => { queuedSettled = true; });
    await Promise.resolve();
    expect(clickSettled).toBe(false);
    expect(queuedSettled).toBe(false);

    contents.emit("did-stop-loading");
    await expect(click).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toMatchObject({ ok: true });
  });

  it("revalidates the exact ref after trusted hover handlers move the target", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/source",
    });
    pageTools.locateAgentPageRef
      .mockResolvedValueOnce({
        found: true, blocked: false, disabled: false, editable: false,
        label: "Hover-moving action", x: 42, y: 28,
      })
      .mockResolvedValueOnce({
        found: true, blocked: false, disabled: false, editable: false,
        label: "Hover-moving action", x: 42, y: 28,
      })
      .mockResolvedValueOnce({
        found: true, blocked: false, disabled: false, editable: false,
        label: "Hover-moving action", x: 282, y: 28,
      })
      .mockResolvedValueOnce({
        found: true, blocked: false, disabled: false, editable: false,
        label: "Hover-moving action", x: 282, y: 28,
      });

    await expect(broker.perform(conversationId, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({ ok: true });
    const inputs = electronState.contents[contentsOffset]!.sentInputs;
    expect(inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mouseMove", x: 42, y: 28 }),
      expect.objectContaining({ type: "mouseMove", x: 282, y: 28 }),
      expect.objectContaining({ type: "mouseDown", x: 282, y: 28 }),
      expect.objectContaining({ type: "mouseUp", x: 282, y: 28 }),
    ]));
    expect(inputs).not.toContainEqual(expect.objectContaining({
      type: "mouseDown", x: 42, y: 28,
    }));
  });

  it("holds queued work until key-triggered main-frame navigation settles", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/form",
    });
    const contents = electronState.contents[contentsOffset]!;
    const press = broker.perform(conversationId, { action: "press", key: "Enter" });
    await vi.waitFor(() => expect(contents.sentInputs)
      .toContainEqual(expect.objectContaining({ type: "char", keyCode: "\r" })));
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "http://127.0.0.1:3000/results",
    });
    let pressSettled = false;
    let queuedSettled = false;
    void press.finally(() => { pressSettled = true; });
    const queued = broker.perform(conversationId, { action: "tabs" })
      .finally(() => { queuedSettled = true; });
    await Promise.resolve();
    expect(pressSettled).toBe(false);
    expect(queuedSettled).toBe(false);

    contents.emit("did-stop-loading");
    await expect(press).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toMatchObject({ ok: true });
  });

  it("holds queued work until type-triggered main-frame navigation settles", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/form",
    });
    const contents = electronState.contents[contentsOffset]!;
    const typing = broker.perform(conversationId, {
      action: "type",
      ref: "e1",
      text: "navigate",
      replace: true,
    });
    await vi.waitFor(() => expect(contents.insertedText).toContain("navigate"));
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "http://127.0.0.1:3000/results",
    });
    let typeSettled = false;
    let queuedSettled = false;
    void typing.finally(() => { typeSettled = true; });
    const queued = broker.perform(conversationId, { action: "tabs" })
      .finally(() => { queuedSettled = true; });
    await Promise.resolve();
    expect(typeSettled).toBe(false);
    expect(queuedSettled).toBe(false);

    contents.emit("did-stop-loading");
    await expect(typing).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toMatchObject({ ok: true });
  });

  it("blocks activation keys while a file input owns focus", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/upload",
    });
    pageTools.agentPageActivationBlocked.mockResolvedValueOnce("file");
    const contents = electronState.contents[contentsOffset]!;

    await expect(broker.perform(conversationId, { action: "press", key: "Enter" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "File inputs cannot be activated by the Browser agent.",
      });
    expect(contents.sentInputs).toEqual([]);
  });

  it("refuses semantic and visual evidence after a password is observed", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/login",
    });
    const capturePage = electronState.contents[contentsOffset]!.capturePage as unknown as {
      mock: { calls: unknown[][] };
    };
    const captures = capturePage.mock.calls.length;
    pageTools.agentPageHasSensitiveEvidence.mockResolvedValueOnce(true);
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: false, code: "invalid" });
    pageTools.agentPageHasSensitiveEvidence.mockResolvedValueOnce(true);
    await expect(broker.perform(conversationId, { action: "screenshot" }))
      .resolves.toMatchObject({ ok: false, code: "invalid" });
    expect(capturePage).toHaveBeenCalledTimes(captures);
  });

  it("discards semantic evidence when nested credential taint races collection", async () => {
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/login",
    });
    pageTools.agentPageHasSensitiveEvidence
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "Page evidence is unavailable until the password-bearing document navigates away.",
      });
    expect(pageTools.semanticPageSnapshot).toHaveBeenCalled();
  });

  it("discards semantic evidence when an author shadow root races collection", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/login",
    });
    const contents = electronState.contents[contentsOffset]!;
    pageTools.semanticPageSnapshot.mockImplementationOnce(async () => {
      contents.debugger.emitMessage("DOM.shadowRootPushed", {
        root: { nodeId: 21, shadowRootType: "closed" },
      });
      return JSON.stringify({ title: "Local app", elements: [] });
    });

    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "Page evidence is unavailable for nested page content.",
      });
    expect(pageTools.semanticPageSnapshot).toHaveBeenCalled();
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith("DOMSnapshot.captureSnapshot", expect.anything());
  });

  it("refuses evidence from unguarded nested page boundaries", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/nested-login",
    });
    const contents = electronState.contents[contentsOffset]!;
    contents.debugger.emitMessage("Page.frameAttached", {
      frameId: "credential-frame",
      parentFrameId: "main",
    });

    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "Page evidence is unavailable for nested page content.",
      });
    await expect(broker.perform(conversationId, { action: "screenshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "Screenshots are unavailable for nested page content.",
      });
    expect(contents.capturePage).not.toHaveBeenCalled();
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith("Page.getFrameTree");
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith("DOMSnapshot.captureSnapshot", expect.anything());
  });

  it("retains privileged lifetime taint after a declarative closed root disappears", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/declarative-shadow",
    });
    const contents = electronState.contents[contentsOffset]!;
    contents.debugger.emitMessage("DOM.shadowRootPushed", {
      root: { nodeId: 12, shadowRootType: "closed" },
    });

    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "Page evidence is unavailable for nested page content.",
      });
    expect(contents.capturePage).not.toHaveBeenCalled();
    contents.debugger.emitMessage("Page.frameNavigated", {
      frame: { id: "replacement-main", url: "http://127.0.0.1:3000/clean" },
    });
    await expect(broker.perform(conversationId, { action: "snapshot" }))
      .resolves.toMatchObject({ ok: true });
  });

  it("freezes visual capture and discards a screenshot when credential evidence races it", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/login",
    });
    const contents = electronState.contents[contentsOffset]!;
    pageTools.agentPageHasSensitiveEvidence
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(broker.perform(conversationId, { action: "screenshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "Screenshots are unavailable until the password-bearing document navigates away.",
      });
    expect(contents.capturePage).toHaveBeenCalledOnce();
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.setWebLifecycleState",
      { state: "frozen" },
    );
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.setWebLifecycleState",
      { state: "active" },
    );
  });

  it("omits page-controlled tab metadata from provider-visible state", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    const secret = "password-mirrored-by-page";
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: `http://127.0.0.1:3000/${secret}?draft=${secret}#${secret}`,
    });
    electronState.contents[contentsOffset]!.setTitle(secret);

    const tabs = await broker.perform(conversationId, { action: "tabs" });
    expect(tabs).toMatchObject({
      ok: true,
      state: {
        tabs: [{
          title: "Local page",
          url: "http://127.0.0.1:3000",
        }],
      },
    });
    if (tabs.ok) expect(tabs.text).not.toContain(secret);

    const screenshot = await broker.perform(conversationId, { action: "screenshot" });
    expect(screenshot.ok).toBe(true);
    if (screenshot.ok) {
      expect(screenshot.text).not.toContain(secret);
      expect(JSON.parse(screenshot.text)).toMatchObject({
        url: "http://127.0.0.1:3000",
      });
    }
  });

  it("serializes parallel agent commands and binds visual evidence to its captured tab", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    const first = await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    const second = await broker.tab({
      ownerId: "primary",
      contextId: conversationId,
      action: "open",
      url: "http://127.0.0.1:3000/settings",
    });
    const firstTabId = first.activeTabId!;
    const secondTabId = second.activeTabId!;
    await broker.tab({
      ownerId: "primary",
      contextId: conversationId,
      action: "activate",
      tabId: firstTabId,
    });

    const contents = electronState.contents[contentsOffset]!;
    const originalCapture = contents.capturePage.getMockImplementation() as () => Promise<unknown>;
    let captureStarted = (): void => undefined;
    let releaseCapture = (): void => undefined;
    const started = new Promise<void>((resolve) => { captureStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCapture = resolve; });
    contents.capturePage.mockImplementationOnce(async () => {
      captureStarted();
      await blocked;
      return await originalCapture();
    });

    const screenshotPromise = broker.perform(conversationId, { action: "screenshot" });
    await started;
    let activationSettled = false;
    const activationPromise = broker.tab({
      ownerId: "primary",
      contextId: conversationId,
      action: "activate",
      tabId: secondTabId,
    }).finally(() => { activationSettled = true; });
    await Promise.resolve();
    expect(activationSettled).toBe(false);

    releaseCapture();
    const screenshot = await screenshotPromise;
    expect(screenshot.ok).toBe(true);
    if (screenshot.ok) {
      expect(JSON.parse(screenshot.text)).toMatchObject({
        captured: true,
        tabId: firstTabId,
        url: "http://127.0.0.1:3000",
      });
      expect(screenshot.state.activeTabId).toBe(firstTabId);
      expect(screenshot.state.activity?.tabId).toBe(firstTabId);
    }
    await expect(activationPromise).resolves.toMatchObject({ activeTabId: secondTabId });
  });

  it("binds screenshot metadata to the URL captured before page reactivation", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    const frozenUrl = "http://127.0.0.1:3000/captured";
    const resumedUrl = "http://127.0.0.1:3001/after-capture";
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: frozenUrl,
    });
    const contents = electronState.contents[contentsOffset]!;
    const original = contents.debugger.sendCommand.getMockImplementation();
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      const result = await original?.(method, params);
      if (method === "Page.setWebLifecycleState" && params?.state === "active") {
        contents.setURL(resumedUrl);
      }
      return result;
    });

    const screenshot = await broker.perform(conversationId, { action: "screenshot" });
    expect(screenshot.ok).toBe(true);
    if (screenshot.ok) {
      expect(JSON.parse(screenshot.text)).toMatchObject({
        captured: true,
        url: "http://127.0.0.1:3000",
      });
      expect(screenshot.state).toMatchObject({
        activeTabId: screenshot.state.tabs[0]?.id,
        tabs: [{ url: "http://127.0.0.1:3000" }],
        activity: { action: "screenshot" },
      });
    }
    expect(contents.getURL()).toBe(resumedUrl);
  });

  it("invalidates exact agent interactions when Preview geometry changes", async () => {
    const timelineOffset = electronState.interactionTimeline.length;
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    broker.setBounds({
      ownerId: "primary",
      contextId: conversationId,
      bounds: { x: 10, y: 20, width: 600, height: 400 },
    });
    await broker.perform(conversationId, { action: "tabs" });

    let cursorStarted = (): void => undefined;
    let releaseCursor = (): void => undefined;
    const started = new Promise<void>((resolve) => { cursorStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCursor = resolve; });
    pageTools.showAgentPageCursor.mockImplementationOnce(async () => {
      cursorStarted();
      await blocked;
    });
    const click = broker.perform(conversationId, { action: "click", ref: "e1" });
    await started;

    broker.setBounds({
      ownerId: "primary",
      contextId: conversationId,
      bounds: { x: 30, y: 40, width: 420, height: 280 },
    });
    await Promise.resolve();
    expect(Reflect.get(children[0]!, "bounds")).toEqual({
      x: 30, y: 40, width: 420, height: 280,
    });

    releaseCursor();
    await expect(click).resolves.toMatchObject({
      ok: false,
      code: "not-found",
      message: "The Browser page layout changed during this action. Inspect the page again for current refs.",
    });
    expect(electronState.interactionTimeline.slice(timelineOffset)).toEqual([
      "bounds:0,0,0,0",
      "bounds:10,20,600,400",
      "bounds:30,40,420,280",
    ]);
    expect(children[0]!.webContents.sentInputs).toEqual([]);

    let typeCursorStarted = (): void => undefined;
    let releaseTypeCursor = (): void => undefined;
    const typeStarted = new Promise<void>((resolve) => { typeCursorStarted = resolve; });
    const typeBlocked = new Promise<void>((resolve) => { releaseTypeCursor = resolve; });
    pageTools.showAgentPageCursor.mockImplementationOnce(async () => {
      typeCursorStarted();
      await typeBlocked;
    });
    const type = broker.perform(conversationId, {
      action: "type",
      ref: "e2",
      text: "must not reach the resized page",
      replace: true,
    });
    await typeStarted;
    broker.setBounds({
      ownerId: "primary",
      contextId: conversationId,
      bounds: { x: 50, y: 60, width: 360, height: 240 },
    });
    releaseTypeCursor();
    await expect(type).resolves.toMatchObject({ ok: false, code: "not-found" });
    expect(children[0]!.webContents.insertedText).toEqual([]);
  });

  it("revalidates refs and focus after rendering the page cursor", async () => {
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    pageTools.locateAgentPageRef
      .mockResolvedValueOnce({
        found: true, disabled: false, editable: false,
        label: "Pay now", x: 42, y: 28,
      })
      .mockResolvedValueOnce({
        found: false, disabled: false, editable: false, label: "", x: 0, y: 0,
      });
    await expect(broker.perform(conversationId, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({
        ok: false,
        code: "not-found",
        message: "That page element changed before the click. Inspect the page again for current refs.",
      });
    expect(children[0]!.webContents.sentInputs).toEqual([]);

    pageTools.locateAgentPageRef
      .mockResolvedValueOnce({
        found: true, disabled: false, editable: true,
        label: "Email", x: 42, y: 28,
      })
      .mockResolvedValueOnce({
        found: false, disabled: false, editable: false, label: "", x: 0, y: 0,
      });
    await expect(broker.perform(conversationId, {
      action: "type",
      ref: "e2",
      text: "must stay out",
      replace: true,
    })).resolves.toMatchObject({
      ok: false,
      code: "not-found",
      message: "That page element lost focus before typing. Inspect the page again for current refs.",
    });
    expect(children[0]!.webContents.insertedText).toEqual([]);
  });

  it("revalidates the exact ref after asynchronous privileged input setup", async () => {
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    const order: string[] = [];
    pageTools.locateAgentPageRef.mockImplementationOnce(async () => {
      order.push("initial");
      return {
        found: true, disabled: false, editable: false,
        label: "Pay now", x: 42, y: 28,
      };
    }).mockImplementationOnce(async () => {
      order.push("cursor-revalidation");
      return {
        found: true, disabled: false, editable: false,
        label: "Pay now", x: 42, y: 28,
      };
    }).mockImplementationOnce(async () => {
      order.push("post-hover-revalidation");
      return { found: false };
    });
    pageTools.setAgentPageInputGuard.mockImplementationOnce(async (_contents, active) => {
      order.push(`guard:${String(active)}`);
    });

    await expect(broker.perform(conversationId, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({ ok: false, code: "not-found" });
    expect(order).toEqual([
      "initial",
      "cursor-revalidation",
      "guard:true",
      "post-hover-revalidation",
    ]);
    expect(children[0]!.webContents.sentInputs).toEqual([
      { type: "mouseMove", x: 42, y: 28 },
    ]);
  });

  it("releases chooser interception when setup finishes after cancellation", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    const contents = electronState.contents[contentsOffset]!;
    const original = contents.debugger.sendCommand.getMockImplementation();
    let finishEnable = (): void => undefined;
    const delayedEnable = new Promise<void>((resolve) => { finishEnable = resolve; });
    contents.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === "Page.setInterceptFileChooserDialog") await delayedEnable;
      return await original?.(method);
    });
    const controller = new AbortController();
    const action = broker.perform(
      conversationId,
      { action: "click", ref: "e1" },
      controller.signal,
    );
    await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: true, cancel: true },
    ));

    controller.abort();
    await expect(action).resolves.toMatchObject({ ok: false, code: "cancelled" });
    finishEnable();
    await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: false },
    ));
  });

  it("rejects typing into a non-editable semantic ref", async () => {
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    pageTools.locateAgentPageRef.mockResolvedValueOnce({
      found: true, disabled: false, editable: false,
      label: "Continue", x: 42, y: 28,
    });
    const cursorCalls = pageTools.showAgentPageCursor.mock.calls.length;

    await expect(broker.perform(conversationId, {
      action: "type", ref: "e1", text: "not delivered", replace: true,
    })).resolves.toMatchObject({
      ok: false,
      code: "invalid",
      message: "That page element does not accept text input.",
    });
    expect(children[0]!.webContents.insertedText).toEqual([]);
    expect(pageTools.showAgentPageCursor).toHaveBeenCalledTimes(cursorCalls);
  });

  it("rejects browser elements that become host-controlled inputs", async () => {
    const { broker, children } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    pageTools.locateAgentPageRef.mockResolvedValueOnce({
      found: true,
      blocked: true,
      disabled: false,
      editable: false,
      label: "Upload private file",
      x: 42,
      y: 28,
    });

    await expect(broker.perform(conversationId, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({
        ok: false,
        code: "invalid",
        message: "That page element cannot be controlled by the Browser agent.",
      });
    expect(children[0]!.webContents.sentInputs).toEqual([]);
  });

  it("serializes renderer navigation and waits for history commands to settle", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    let snapshotStarted = (): void => undefined;
    let releaseSnapshot = (): void => undefined;
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    pageTools.semanticPageSnapshot.mockImplementationOnce(async () => {
      snapshotStarted();
      await blocked;
      return JSON.stringify({ title: "Local app", elements: [] });
    });

    const snapshotPromise = broker.perform(conversationId, { action: "snapshot" });
    await started;
    let navigationSettled = false;
    const navigationPromise = broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/settings",
    }).finally(() => { navigationSettled = true; });
    await Promise.resolve();
    expect(navigationSettled).toBe(false);

    releaseSnapshot();
    await expect(snapshotPromise).resolves.toMatchObject({ ok: true });
    await expect(navigationPromise).resolves.toMatchObject({
      url: "http://127.0.0.1:3000/settings",
    });

    let secondStarted = (): void => undefined;
    let releaseSecond = (): void => undefined;
    const secondStart = new Promise<void>((resolve) => { secondStarted = resolve; });
    const secondBlock = new Promise<void>((resolve) => { releaseSecond = resolve; });
    pageTools.semanticPageSnapshot.mockImplementationOnce(async () => {
      secondStarted();
      await secondBlock;
      return JSON.stringify({ title: "settings", elements: [] });
    });
    const secondSnapshot = broker.perform(conversationId, { action: "snapshot" });
    await secondStart;
    let commandSettled = false;
    const commandPromise = broker.command({
      ownerId: "primary",
      contextId: conversationId,
      action: "reload",
    }).finally(() => { commandSettled = true; });
    await Promise.resolve();
    expect(commandSettled).toBe(false);
    releaseSecond();
    await expect(secondSnapshot).resolves.toMatchObject({ ok: true });
    await Promise.resolve();
    expect(commandSettled).toBe(false);
    electronState.contents[contentsOffset]!.emit("did-stop-loading");
    await expect(commandPromise).resolves.toMatchObject({
      url: "http://127.0.0.1:3000/settings",
    });
  });

  it("releases queued browser work when a renderer operation is cancelled", async () => {
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    let snapshotStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    pageTools.semanticPageSnapshot.mockImplementationOnce(async () => {
      snapshotStarted();
      return await new Promise<string>(() => undefined);
    });
    const controller = new AbortController();
    const stalled = broker.perform(
      conversationId,
      { action: "snapshot" },
      controller.signal,
    );
    await started;
    let queuedSettled = false;
    const queued = broker.perform(conversationId, { action: "tabs" })
      .finally(() => { queuedSettled = true; });
    await Promise.resolve();
    expect(queuedSettled).toBe(false);

    controller.abort();
    await expect(stalled).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(queued).resolves.toMatchObject({ ok: true });
  });

  it("bounds an unresponsive renderer even without upstream cancellation", async () => {
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    vi.useFakeTimers();
    try {
      let snapshotStarted = (): void => undefined;
      const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
      pageTools.semanticPageSnapshot.mockImplementationOnce(async () => {
        snapshotStarted();
        return await new Promise<string>(() => undefined);
      });
      const stalled = broker.perform(conversationId, { action: "snapshot" });
      await started;
      const queued = broker.perform(conversationId, { action: "tabs" });

      await vi.advanceTimersByTimeAsync(15_000);
      await expect(stalled).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
        message: "The Browser page stopped responding.",
      });
      await expect(queued).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles matching same-document history navigation without a load cycle", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/current",
    });
    const contents = electronState.contents[contentsOffset]!;
    const targetUrl = "http://127.0.0.1:3000/current#previous";
    contents.navigationHistory.canGoBack.mockReturnValue(true);
    contents.navigationHistory.getActiveIndex.mockReturnValue(1);
    contents.navigationHistory.getEntryAtIndex.mockReturnValue({
      title: "Previous", url: targetUrl,
    });
    let settled = false;
    const command = broker.command({
      ownerId: "primary",
      contextId: conversationId,
      action: "back",
    }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(contents.navigationHistory.goBack).toHaveBeenCalledOnce());

    contents.emit("did-navigate-in-page", {}, targetUrl, false, 1, 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    contents.emit(
      "did-navigate-in-page",
      {},
      "http://127.0.0.1:3000/current#unrelated",
      true,
      1,
      1,
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    contents.emit("did-navigate-in-page", {}, targetUrl, true, 1, 1);
    await expect(command).resolves.toMatchObject({
      url: "http://127.0.0.1:3000/current",
    });
  });

  it("fails closed when a screenshot capture has no PNG data", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    electronState.contents[contentsOffset]!.capturePage
      .mockImplementationOnce(async () => ({
        getSize: () => ({ width: 0, height: 0 }),
        resize() { return this; },
        toPNG: () => Buffer.alloc(0),
      }));

    await expect(broker.perform(conversationId, { action: "screenshot" }))
      .resolves.toMatchObject({
        ok: false,
        code: "unavailable",
        message: "The active Browser page had no drawable screenshot.",
      });
  });

  it("attributes tab-close activity to the exact closed page", async () => {
    const { broker } = harness();
    const initial = await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    const firstTabId = initial.activeTabId!;
    const opened = await broker.perform(conversationId, {
      action: "tab-open",
      url: "http://127.0.0.1:3000/settings",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const inactiveTabId = opened.state.activeTabId;
    await expect(broker.perform(conversationId, {
      action: "tab-activate",
      tabId: firstTabId,
    })).resolves.toMatchObject({ ok: true });

    await expect(broker.perform(conversationId, {
      action: "tab-close",
      tabId: inactiveTabId,
    })).resolves.toMatchObject({
      ok: true,
      state: {
        activeTabId: firstTabId,
        activity: { action: "tab-close", tabId: inactiveTabId },
      },
    });

    const replacement = await broker.perform(conversationId, { action: "tab-open" });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    const activeClosedTabId = replacement.state.activeTabId;
    await expect(broker.perform(conversationId, {
      action: "tab-close",
      tabId: activeClosedTabId,
    })).resolves.toMatchObject({
      ok: true,
      state: {
        activeTabId: firstTabId,
        activity: { action: "tab-close", tabId: activeClosedTabId },
      },
    });
  });

  it("keeps maximum tab state valid within the broker text boundary", async () => {
    const { broker } = harness();
    const longPath = "x".repeat(3_900);
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/" + longPath,
    });
    for (let index = 1; index < 8; index += 1) {
      await expect(broker.perform(conversationId, {
        action: "tab-open",
        url: "http://127.0.0.1:3000/" + longPath + index,
      })).resolves.toMatchObject({ ok: true });
    }

    const result = await broker.perform(conversationId, { action: "tabs" });
    expect(result.ok).toBe(true);
    expect(parseAgentBrowserResult(result)).not.toBeNull();
    if (!result.ok) return;
    expect(Buffer.byteLength(result.text, "utf8"))
      .toBeLessThanOrEqual(MAX_AGENT_BROWSER_TEXT_BYTES);
    const text = JSON.parse(result.text) as {
      truncated?: boolean;
      tabs: Array<{ title: string; url: string }>;
    };
    expect(text.truncated).toBeUndefined();
    expect(text.tabs).toHaveLength(8);
    expect(text.tabs.every((tab) =>
      tab.title === "Local page" && tab.url === "http://127.0.0.1:3000"
    )).toBe(true);
  });

  it("fails closed for remote agent navigation, stale ownership, and tab overflow", async () => {
    const { broker } = harness();
    await broker.navigate({
      ownerId: "primary",
      contextId: conversationId,
      url: "http://127.0.0.1:3000/",
    });
    await expect(broker.perform(conversationId, {
      action: "navigate", url: "https://example.com/",
    })).resolves.toMatchObject({ ok: false, code: "invalid" });
    await expect(broker.perform("22222222-2222-4222-8222-222222222222", {
      action: "snapshot",
    })).resolves.toMatchObject({ ok: false, code: "unavailable" });
    for (let index = 1; index < 8; index += 1) {
      await expect(broker.perform(conversationId, { action: "tab-open" }))
        .resolves.toMatchObject({ ok: true });
    }
    await expect(broker.perform(conversationId, { action: "tab-open" }))
      .resolves.toMatchObject({ ok: false, code: "too-large" });
  });
});

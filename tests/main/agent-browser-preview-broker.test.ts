import { describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  viewOptions: [] as Array<Record<string, unknown>>,
  contents: [] as Array<{
    capturePage: {
      getMockImplementation(): (() => Promise<unknown>) | undefined;
      mockImplementationOnce(implementation: () => Promise<unknown>): unknown;
    };
    navigationHistory: {
      canGoBack: ReturnType<typeof vi.fn>;
      getActiveIndex: ReturnType<typeof vi.fn>;
      getEntryAtIndex: ReturnType<typeof vi.fn>;
      goBack: ReturnType<typeof vi.fn>;
    };
    emit(name: string, ...args: unknown[]): void;
  }>,
  sessions: [] as Array<{
    permissionChecks: number;
    permissionRequests: number;
    downloadHandlers: number;
    clearStorageData: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("electron", () => {
  class FakeSession {
    permissionChecks = 0;
    permissionRequests = 0;
    downloadHandlers = 0;
    clearStorageData = vi.fn(async () => undefined);

    constructor() {
      electronState.sessions.push(this);
    }

    setPermissionCheckHandler(): void { this.permissionChecks += 1; }
    setPermissionRequestHandler(): void { this.permissionRequests += 1; }
    on(name: string): void {
      if (name === "will-download") this.downloadHandlers += 1;
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
    readonly session = new FakeSession();
    readonly navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      getActiveIndex: vi.fn(() => 0),
      getEntryAtIndex: vi.fn(() => ({ title: "", url: this.url })),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    readonly sentInputs: Array<Record<string, unknown>> = [];
    readonly insertedText: string[] = [];
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    private url = "";
    private title = "";
    private destroyed = false;

    constructor() {
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
      this.emit("did-navigate", {}, url);
    }
    getURL(): string { return this.url; }
    getTitle(): string { return this.title; }
    isLoading(): boolean { return false; }
    isDestroyed(): boolean { return this.destroyed; }
    reload(): void {}
    stop(): void {}
    close(): void { this.destroyed = true; }
    sendInputEvent(input: Record<string, unknown>): void { this.sentInputs.push(input); }
    async insertText(text: string): Promise<void> { this.insertedText.push(text); }
    readonly capturePage = vi.fn(async (): Promise<FakeImage> => new FakeImage());
  }

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    constructor(options: Record<string, unknown>) { electronState.viewOptions.push(options); }
    setBounds(bounds: typeof this.bounds): void { this.bounds = bounds; }
    getBounds(): typeof this.bounds { return this.bounds; }
    setBackgroundColor(): void {}
  }

  return { WebContentsView: FakeWebContentsView };
});

const pageTools = vi.hoisted(() => ({
  locateAgentPageRef: vi.fn(async () => ({
    found: true, disabled: false, editable: true, label: "Run checks", x: 42, y: 28,
  })),
  semanticPageSnapshot: vi.fn(async () => JSON.stringify({ title: "Local app", elements: [] })),
  showAgentPageCursor: vi.fn(async () => undefined),
}));

vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewBroker } from "../../src/main/preview-broker";
import {
  MAX_AGENT_BROWSER_TEXT_BYTES,
  parseAgentBrowserResult,
} from "../../src/shared/agent-browser";

const conversationId = "11111111-1111-4111-8111-111111111111";

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
      },
    });
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

  it("returns semantic and visual evidence and renders exact visible interaction input", async () => {
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
    await expect(broker.perform(conversationId, { action: "click", ref: "e1" }))
      .resolves.toMatchObject({ ok: true });
    expect(pageTools.showAgentPageCursor).toHaveBeenCalledWith(
      expect.anything(), 42, 28, "Agent · Run checks",
    );
    expect(children[0]!.webContents.sentInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mouseDown", x: 42, y: 28 }),
      expect.objectContaining({ type: "mouseUp", x: 42, y: 28 }),
    ]));
    await expect(broker.perform(conversationId, {
      action: "type", ref: "e2", text: "hello", replace: true,
    })).resolves.toMatchObject({ ok: true });
    expect(children[0]!.webContents.insertedText).toEqual(["hello"]);
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
        url: "http://127.0.0.1:3000/",
      });
      expect(screenshot.state.activeTabId).toBe(firstTabId);
      expect(screenshot.state.activity?.tabId).toBe(firstTabId);
    }
    await expect(activationPromise).resolves.toMatchObject({ activeTabId: secondTabId });
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
      truncated: boolean;
      tabs: Array<{ title: string; url: string }>;
    };
    expect(text.truncated).toBe(true);
    expect(text.tabs).toHaveLength(8);
    expect(text.tabs.every((tab) =>
      tab.title.length <= 120 && tab.url.length <= 1_024
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

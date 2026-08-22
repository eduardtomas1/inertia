import { describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  viewOptions: [] as Array<Record<string, unknown>>,
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
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    readonly sentInputs: Array<Record<string, unknown>> = [];
    readonly insertedText: string[] = [];
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    private url = "";
    private title = "";
    private destroyed = false;

    setWindowOpenHandler(): void {}
    on(name: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    }
    async loadURL(url: string): Promise<void> {
      this.url = url;
      this.title = new URL(url).pathname === "/" ? "Local app" : new URL(url).pathname.slice(1);
      for (const handler of this.handlers.get("did-navigate") ?? []) handler({}, url);
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
    async capturePage(): Promise<FakeImage> { return new FakeImage(); }
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
    found: true, disabled: false, label: "Run checks", x: 42, y: 28,
  })),
  semanticPageSnapshot: vi.fn(async () => JSON.stringify({ title: "Local app", elements: [] })),
  showAgentPageCursor: vi.fn(async () => undefined),
}));

vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewBroker } from "../../src/main/preview-broker";

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

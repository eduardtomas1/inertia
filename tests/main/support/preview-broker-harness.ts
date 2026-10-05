import { vi } from "vitest";

import type { PreviewAgentTarget } from "../../../src/main/preview-agent-page";

export function createPreviewBrokerElectronState() {
  return {
    loadOverrides: [] as Array<(url: string) => Promise<void>>,
    focusedShadowRoots: undefined as Array<{ shadowRootType: string }> | undefined,
    stalledCommands: [] as Array<(method: string, params?: Record<string, unknown>) => boolean>,
    interactionTimeline: [] as string[],
    viewOptions: [] as Array<Record<string, unknown>>,
    contents: [] as Array<{
      id: number;
      capturePage: {
        getMockImplementation(): (() => Promise<unknown>) | undefined;
        mockImplementationOnce(implementation: () => Promise<unknown>): unknown;
      };
      debugger: {
        attached: boolean;
        attach: ReturnType<typeof vi.fn>;
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
      isDestroyed(): boolean;
      loading: boolean;
      crashed: boolean;
      stop: ReturnType<typeof vi.fn>;
      close(): void;
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
  };
}

export type PreviewBrokerElectronState = ReturnType<typeof createPreviewBrokerElectronState>;
export type PreviewBrokerHarnessContents = PreviewBrokerElectronState["contents"][number];

export function createPreviewBrokerElectronMock(electronState: PreviewBrokerElectronState) {
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
    private mainFrameId = "main";
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
      removeListener: vi.fn((name: string, handler: (
        event: unknown,
        method: string,
        params: Record<string, unknown>,
      ) => void) => {
        const index = name === "message" ? this.debuggerMessageHandlers.indexOf(handler) : -1;
        if (index >= 0) this.debuggerMessageHandlers.splice(index, 1);
      }),
      emitMessage: (method: string, params: Record<string, unknown>): void => {
        const frame = params.frame as { id?: unknown; parentId?: unknown } | undefined;
        if (method === "Page.frameNavigated" && typeof frame?.id === "string" && frame.parentId === undefined) {
          this.mainFrameId = frame.id;
        }
        for (const handler of this.debuggerMessageHandlers.slice()) handler({}, method, params);
      },
      sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        const stalled = electronState.stalledCommands.findIndex((matches) => matches(method, params));
        if (stalled >= 0) {
          electronState.stalledCommands.splice(stalled, 1);
          return await new Promise<never>(() => undefined);
        }
        if (method === "Runtime.enable") {
          this.debugger.emitMessage("Runtime.executionContextCreated", {
            context: {
              id: 7,
              name: "Electron Isolated Context",
              auxData: { frameId: this.mainFrameId, isDefault: false, type: "isolated" },
            },
          });
          return undefined;
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
        if (method === "Runtime.evaluate" && params?.contextId === 7) {
          return { result: { type: "boolean", value: true } };
        }
        if (method === "Runtime.evaluate") {
          return { result: { type: "object", subtype: "node", objectId: "focused-element" } };
        }
        if (method === "DOM.describeNode") {
          return { node: { nodeType: 1, shadowRoots: electronState.focusedShadowRoots } };
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
      const onceHandler = Object.assign((...args: unknown[]): void => {
        this.removeListener(name, onceHandler);
        handler(...args);
      }, { listener: handler });
      this.on(name, onceHandler);
    }
    removeListener(name: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(name);
      if (!handlers) return;
      const index = handlers.findLastIndex((candidate) => candidate === handler
        || (candidate as { listener?: unknown }).listener === handler);
      if (index >= 0) handlers.splice(index, 1);
    }
    emit(name: string, ...args: unknown[]): void {
      const handlers = this.handlers.get(name)?.slice() ?? [];
      for (const handler of handlers) handler(...args);
    }
    async loadURL(url: string): Promise<void> {
      this.url = url;
      const override = url === "about:blank" ? undefined : electronState.loadOverrides.shift();
      if (override) {
        this.loading = true;
        try {
          await override(url);
        } finally {
          this.loading = false;
        }
      }
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
    loading = false;
    crashed = false;
    isLoading(): boolean { return this.loading; }
    isLoadingMainFrame(): boolean { return this.loading; }
    isCrashed(): boolean { return this.crashed; }
    isDestroyed(): boolean { return this.destroyed; }
    reload(): void {}
    readonly stop = vi.fn();
    close(): void { this.destroyed = true; }
    sendInputEvent(input: Record<string, unknown>): void {
      this.sentInputs.push(input);
      electronState.interactionTimeline.push(String(input.type));
      this.emit("input-event", {}, typeof input.keyCode === "string" ? { ...input, key: input.keyCode } : input);
    }
    async insertText(text: string): Promise<void> { this.insertedText.push(text); }
    readonly throttling: boolean[] = [];
    setBackgroundThrottling(allowed: boolean): void { this.throttling.push(allowed); }
    readonly capturePage = vi.fn(async (): Promise<FakeImage> => new FakeImage());
  }

  class FakeWebContentsView {
    readonly webContents: FakeWebContents;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    readonly visibilityChanges: boolean[] = [];
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
    getVisible(): boolean { return this.visible; }
    setVisible(visible: boolean): void {
      this.visible = visible;
      this.visibilityChanges.push(visible);
    }
    setBackgroundColor(): void {}
  }

  return { WebContentsView: FakeWebContentsView };
}

export function createPreviewBrokerPageTools() {
  return {
    AGENT_BROWSER_WORLD_ID: 999,
    PRIVACY_RUNTIME: "({ redact: (_state, value) => value })",
    agentPageActivationBlocked: vi.fn<() => Promise<"disabled" | "file" | null>>(async () => null),
    agentPageActivationTargetStillFocused: vi.fn<() => Promise<boolean>>(async () => true),
    agentPageEvidencePrivacy: vi.fn<() => Promise<{
      withheld: "password" | "hidden-input" | "credential-signal" | "document-too-large" | null;
    }>>(async () => ({ withheld: null })),
    agentPageHasSensitiveEvidence: vi.fn(async () => false),
    agentPageHasSensitiveScreenshotEvidence: vi.fn(async () => false),
    agentPageInputRefusal: vi.fn<() => Promise<"disabled" | "file" | "nested" | "retargeted" | null>>(async () => null),
    agentPageRefHasFocus: vi.fn(async () => true),
    installAgentPagePrivacyGuard: vi.fn(async () => undefined),
    locateAgentPageRef: vi.fn<() => Promise<PreviewAgentTarget>>(async () => ({
      found: true, blocked: false, disabled: false, editable: true,
      label: "Run checks", x: 42, y: 28,
    })),
    semanticPageSnapshot: vi.fn<(
      contents: unknown,
      observed?: readonly string[],
    ) => Promise<string>>(async () => JSON.stringify({ title: "Local app", elements: [] })),
    setAgentPageInputGuard: vi.fn<(
      contents: unknown,
      active: boolean,
      expectedClickRef?: string,
    ) => Promise<void>>(async () => undefined),
    showAgentPageCursor: vi.fn(async () => undefined),
    waitForAgentPageHover: vi.fn(async () => undefined),

  };
}

export const conversationId = "11111111-1111-4111-8111-111111111111";
export const connectionId = "22222222-2222-4222-8222-222222222222";
export const runIdentity = {
  conversationId,
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
};

export function createPreviewBrokerHarness(
  PreviewBroker: typeof import("../../../src/main/preview-broker").PreviewBroker,
) {
  const children: Array<{
    webContents: {
      sentInputs: Array<Record<string, unknown>>;
      insertedText: string[];
    };
  }> = [];
  const window = {
    isDestroyed: vi.fn(() => false),
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
  const recordOperationFailure = vi.fn();
  const confirmPageUnload = vi.fn((_window: unknown) => false);
  const getWindow = vi.fn(() => window as typeof window | null);
  const unregisterHealth: Array<ReturnType<typeof vi.fn>> = [];
  const broker = new PreviewBroker({
    getWindow: () => getWindow() as never,
    openExternal: vi.fn(async () => undefined),
    stateChannel: "preview-state",
    recordOperationFailure,
    confirmPageUnload,
    registerHealthRenderer: () => {
      const unregister = vi.fn();
      unregisterHealth.push(unregister);
      return unregister;
    },
  });
  return { broker, children, recordOperationFailure, confirmPageUnload, window, getWindow, unregisterHealth };
}

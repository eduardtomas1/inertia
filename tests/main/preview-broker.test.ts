import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  class FakeWebContents {
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => undefined,
      goForward: () => undefined,
    };
    readonly session = {
      setPermissionCheckHandler: () => undefined,
      setPermissionRequestHandler: () => undefined,
      on: () => undefined,
      clearStorageData: async () => undefined,
    };
    url = "";
    loading = false;

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    setWindowOpenHandler(): void {}
    getURL(): string { return this.url; }
    isLoading(): boolean { return this.loading; }
    isDestroyed(): boolean { return false; }
    close(): void {}
    async loadURL(url: string): Promise<void> { this.url = url; }
  }

  const views: Array<{ webContents: FakeWebContents }> = [];
  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    constructor() {
      views.push(this);
    }
    setBackgroundColor(): void {}
    setBounds(): void {}
  }

  return {
    FakeWebContentsView,
    views,
  };
});

vi.mock("electron", () => ({
  WebContentsView: electronMocks.FakeWebContentsView,
}));

import {
  PreviewBroker,
  createPreviewPartition,
  previewAppShortcutKey,
} from "../../src/main/preview-broker";

describe("preview broker isolation", () => {
  beforeEach(() => {
    electronMocks.views.length = 0;
  });

  it("assigns each native preview an unpredictable non-persistent partition", () => {
    const first = createPreviewPartition();
    const second = createPreviewPartition();

    expect(first).toMatch(/^inertia-preview-[0-9a-f-]{36}$/u);
    expect(second).toMatch(/^inertia-preview-[0-9a-f-]{36}$/u);
    expect(second).not.toBe(first);
    expect(first.startsWith("persist:")).toBe(false);
    expect(second.startsWith("persist:")).toBe(false);
  });

  it("recognizes only exact app shortcuts from native preview input", () => {
    const input = {
      type: "keyDown",
      key: "K",
      control: false,
      meta: true,
      alt: false,
      shift: false,
    };

    expect(previewAppShortcutKey(input)).toBe("k");
    expect(previewAppShortcutKey({ ...input, key: "X" })).toBeNull();
    expect(previewAppShortcutKey({ ...input, meta: false })).toBeNull();
    expect(previewAppShortcutKey({ ...input, alt: true })).toBeNull();
    expect(previewAppShortcutKey({ ...input, type: "keyUp" })).toBeNull();
  });

  it("publishes readiness only for successful main-frame navigation", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const window = {
      webContents: {
        isDestroyed: () => false,
        send: (_channel: string, update: Record<string, unknown>) => {
          updates.push(update);
        },
      },
      contentView: {
        addChildView: () => undefined,
        removeChildView: () => undefined,
      },
    };
    const broker = new PreviewBroker({
      getWindow: () => window as never,
      openExternal: async () => undefined,
      stateChannel: "preview-state",
    });
    const contextId = "11111111-1111-4111-8111-111111111111";
    await broker.navigate({
      ownerId: "primary",
      contextId,
      url: "http://localhost:4173",
    });
    const contents = electronMocks.views[0]!.webContents;

    contents.loading = true;
    contents.emit("did-start-navigation", {
      url: contents.url,
      isSameDocument: false,
      isMainFrame: true,
      frame: null,
    });
    expect(updates.at(-1)).toMatchObject({ loading: true, ready: false });

    contents.loading = false;
    contents.emit("did-navigate");
    expect(updates.at(-1)).toMatchObject({ loading: false, ready: true });

    const updateCountBeforeSubframe = updates.length;
    contents.emit("did-start-navigation", {
      url: `${contents.url}/frame`,
      isSameDocument: false,
      isMainFrame: false,
      frame: null,
    });
    expect(updates).toHaveLength(updateCountBeforeSubframe);
    expect(updates.at(-1)).toMatchObject({ loading: false, ready: true });

    contents.loading = true;
    contents.emit("did-start-navigation", {
      url: contents.url,
      isSameDocument: false,
      isMainFrame: true,
      frame: null,
    });
    contents.loading = false;
    contents.emit("did-fail-load", {}, -102, "Connection refused", contents.url, true);
    contents.emit("did-stop-loading");
    expect(updates.at(-1)).toMatchObject({ loading: false, ready: false });

    const updateCount = updates.length;
    contents.emit("did-navigate-in-page", {}, `${contents.url}#frame`, false);
    expect(updates).toHaveLength(updateCount);
    contents.url = `${contents.url}#main`;
    contents.emit("did-navigate-in-page", {}, contents.url, true);
    expect(updates.at(-1)).toMatchObject({
      url: contents.url,
      loading: false,
      ready: true,
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { closesSecondaryWindow } from "../../src/main/preview-keyboard";

const key = (overrides: Partial<Parameters<typeof closesSecondaryWindow>[0]>) => ({
  type: "keyDown" as const,
  key: "w",
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...overrides,
});

describe("secondary window close keys", () => {
  it("closes on Escape without modifiers", () => {
    expect(closesSecondaryWindow(key({ key: "Escape" }), "darwin")).toBe(true);
    expect(closesSecondaryWindow(key({ key: "Escape", shift: true }), "linux")).toBe(false);
    expect(closesSecondaryWindow(key({ key: "Escape", type: "keyUp" }), "win32")).toBe(false);
  });

  it("closes on the platform's primary modifier with the typed W", () => {
    expect(closesSecondaryWindow(key({ meta: true }), "darwin")).toBe(true);
    expect(closesSecondaryWindow(key({ control: true }), "darwin")).toBe(false);
    expect(closesSecondaryWindow(key({ control: true, key: "W" }), "win32")).toBe(true);
    expect(closesSecondaryWindow(key({ control: true }), "linux")).toBe(true);
    expect(closesSecondaryWindow(key({ meta: true }), "linux")).toBe(false);
    expect(closesSecondaryWindow(key({ meta: true, shift: true }), "darwin")).toBe(false);
    expect(closesSecondaryWindow(key({ meta: true, alt: true }), "darwin")).toBe(false);
    expect(closesSecondaryWindow(key({ meta: true, key: "q" }), "darwin")).toBe(false);
  });
});

const electron = vi.hoisted(() => ({ windows: [] as Array<{
  closed: number;
  listeners: Map<string, (...args: unknown[]) => void>;
}> }));

vi.mock("electron", () => {
  class BrowserWindow {
    closed = 0;
    listeners = new Map<string, (...args: unknown[]) => void>();
    webContents = {
      on: (name: string, listener: (...args: unknown[]) => void) => this.listeners.set(name, listener),
      setWindowOpenHandler: () => undefined,
      session: {
        setPermissionCheckHandler: () => undefined,
        setPermissionRequestHandler: () => undefined,
        on: () => undefined,
      },
    };
    constructor() {
      electron.windows.push(this);
    }
    setMenuBarVisibility(): void {}
    loadURL(): Promise<void> { return Promise.resolve(); }
    isDestroyed(): boolean { return false; }
    close(): void { this.closed += 1; }
    destroy(): void {}
    show(): void {}
  }
  return {
    BrowserWindow,
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toDataURL: () => "data:image/png;base64,AA==" }) },
  };
});

describe("browser evidence capture window", () => {
  it("closes on Escape and on the close-tab chord", async () => {
    const { showBrowserEvidenceImageWindow } = await import("../../src/main/browser-evidence-image-inspector");
    await showBrowserEvidenceImageWindow(null, { data: "AA==", mimeType: "image/png" } as never);
    const inspector = electron.windows.at(-1)!;
    const input = inspector.listeners.get("before-input-event")!;
    const prevented: string[] = [];
    const fire = (overrides: Parameters<typeof key>[0]) => input({ preventDefault: () => prevented.push(overrides.key ?? "w") }, key(overrides));
    fire({ key: "a" });
    expect(inspector.closed).toBe(0);
    fire({ key: "Escape" });
    expect(inspector.closed).toBe(1);
    fire({ meta: process.platform === "darwin", control: process.platform !== "darwin" });
    expect(inspector.closed).toBe(2);
    expect(prevented).toEqual(["Escape", "w"]);
  });
});

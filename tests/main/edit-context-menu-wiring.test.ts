import { EventEmitter } from "node:events";

import type { BrowserWindowConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const popup = vi.fn();
  const windows: Array<{ webContents: EventEmitter & { mainFrame: object }; isDestroyed: () => boolean }> = [];
  class BrowserWindow {
    readonly webContents = Object.assign(new EventEmitter(), { mainFrame: {} });
    isDestroyed = () => false;
    constructor() {
      windows.push(this);
    }
  }
  return {
    popup,
    windows,
    build: vi.fn(() => ({ popup })),
    BrowserWindow,
  };
});
const detached = vi.hoisted(() => ({ options: undefined as undefined | {
  createBrowserWindow(options: BrowserWindowConstructorOptions): unknown;
} }));

vi.mock("electron", () => ({
  BrowserWindow: electron.BrowserWindow,
  Menu: { buildFromTemplate: electron.build },
  ipcMain: {},
  screen: { getAllDisplays: () => [] },
}));
vi.mock("../../src/main/detached-chat-main", () => ({
  DetachedChatMain: class {
    constructor(options: typeof detached.options) {
      detached.options = options;
    }
  },
}));
vi.mock("../../src/main/preview-broker", () => ({ hardenDesktopSession: vi.fn() }));

import { createDetachedChatMain } from "../../src/main/detached-chat-bootstrap";

const rendererUrl = "inertia://bundle/index.html";
const editableParams = {
  pageURL: rendererUrl, isEditable: true, selectionText: "",
  editFlags: {
    canUndo: false, canRedo: false, canCut: false, canCopy: false,
    canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false,
  },
};

function detachedWindow() {
  createDetachedChatMain({
    mainWindow: () => null,
    rendererUrl,
    userDataDirectory: "/tmp/inertia-user-data",
    iconPath: "/tmp/icon.png",
    backgroundColor: "#000000",
    registerRendererProtocol: vi.fn(),
    registerHealthRenderer: () => () => undefined,
    onDock: vi.fn(),
  });
  detached.options!.createBrowserWindow({});
  return electron.windows.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.windows.length = 0;
  detached.options = undefined;
});

describe("native editing menu wiring", () => {
  it("opens the editing menu in a detached chat window's trusted renderer", () => {
    const window = detachedWindow();
    window.webContents.emit("context-menu", {}, { ...editableParams, frame: window.webContents.mainFrame });
    expect(electron.build).toHaveBeenCalledWith(expect.arrayContaining([{ role: "paste", label: "Paste", enabled: true }]));
    expect(electron.popup).toHaveBeenCalledWith({ window });
  });

  it.each([
    ["another page", { pageURL: "https://untrusted.example/" }],
    ["renderer state in the URL", { pageURL: `${rendererUrl}#/elsewhere` }],
    ["a subframe", { frame: {} }],
  ])("keeps the detached chat menu closed for %s", (_label, patch) => {
    const window = detachedWindow();
    window.webContents.emit("context-menu", {}, { ...editableParams, frame: window.webContents.mainFrame, ...patch });
    expect(electron.build).not.toHaveBeenCalled();
  });
});

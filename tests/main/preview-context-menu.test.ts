import { EventEmitter } from "node:events";

import type { ContextMenuParams, MenuItemConstructorOptions, PopupOptions, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  build: vi.fn(),
  popup: vi.fn(),
  writeText: vi.fn(async () => undefined),
  views: [] as Array<{ webContents: unknown; getBounds: () => { x: number; y: number; width: number; height: number } }>,
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeContents extends Emitter {
    readonly session = {};
    readonly navigationHistory = {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    destroyed = false;
    isDestroyed = () => this.destroyed;
    setWindowOpenHandler = vi.fn();
    undo = vi.fn();
    redo = vi.fn();
    cut = vi.fn();
    copy = vi.fn();
    paste = vi.fn();
    selectAll = vi.fn();
    reload = vi.fn();
  }
  class WebContentsView {
    readonly webContents = new FakeContents();
    setBackgroundColor = vi.fn();
    getBounds = () => ({ x: 300, y: 80, width: 640, height: 480 });
    constructor() {
      electron.views.push(this);
    }
  }
  return {
    WebContentsView,
    Menu: { buildFromTemplate: electron.build },
    clipboard: { writeText: electron.writeText },
  };
});
vi.mock("../../src/main/preview-session", () => ({ hardenDesktopSession: vi.fn() }));

import { createPreviewTab } from "../../src/main/preview-tab";
import { sendAgentPageInput } from "../../src/main/preview-agent-control";

type Contents = EventEmitter & {
  destroyed: boolean;
  copy: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  navigationHistory: { goBack: ReturnType<typeof vi.fn> };
  sendInputEvent?: ReturnType<typeof vi.fn>;
};
type Item = MenuItemConstructorOptions & { click?: () => void };

const ownerWindow = { isDestroyed: () => false };
const editFlags = {
  canUndo: false, canRedo: false, canCut: false, canCopy: true,
  canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false,
};

function fixture({ window = ownerWindow as unknown } = {}) {
  const captureLocked = new WeakSet<WebContents>();
  createPreviewTab({
    partition: "inertia-preview-test",
    pageNumber: 1,
    captureLocked,
    ownerWindow: () => window as never,
    targetContents: () => null,
    guardNavigation: vi.fn(),
    publish: vi.fn(),
    navigated: vi.fn(),
    consoleError: vi.fn(),
  });
  const contents = electron.views.at(-1)!.webContents as Contents;
  const userClick = (x = 20, y = 30) => contents.emit("input-event", {}, { type: "mouseDown", x, y });
  const show = (patch: Partial<ContextMenuParams> = {}) => contents.emit("context-menu", {}, {
    x: 20, y: 30, frame: null, isEditable: false, selectionText: "", linkURL: "", editFlags, ...patch,
  });
  return { captureLocked, contents, userClick, show };
}

const template = () => electron.build.mock.calls.at(-1)![0] as Item[];
const labels = () => template().map((item) => item.type === "separator" ? "-" : item.enabled === false ? `${item.label} (disabled)` : item.label);
const choose = (label: string) => template().find((item) => item.label === label)!.click!();

beforeEach(() => {
  vi.clearAllMocks();
  electron.views.length = 0;
  electron.build.mockReturnValue({ popup: electron.popup });
});

describe("Browser pane context menu", () => {
  it("offers page navigation for a user's right-click and anchors it inside the pane", () => {
    const { contents, userClick, show } = fixture();
    userClick();
    show();
    expect(labels()).toEqual(["Back", "Forward (disabled)", "Reload"]);
    const options = electron.popup.mock.calls[0]![0] as PopupOptions;
    expect(options).toMatchObject({ window: ownerWindow, x: 320, y: 110 });
    choose("Back");
    choose("Reload");
    expect(contents.navigationHistory.goBack).toHaveBeenCalledOnce();
    expect(contents.reload).toHaveBeenCalledOnce();
  });

  it("builds editing actions that act on the page itself", () => {
    const { contents, userClick, show } = fixture();
    userClick();
    show({ isEditable: true });
    expect(labels()).toEqual([
      "Undo (disabled)", "Redo (disabled)", "-", "Cut (disabled)", "Copy", "Paste", "Select All",
      "-", "Back", "Forward (disabled)", "Reload",
    ]);
    choose("Paste");
    expect(contents.paste).toHaveBeenCalledOnce();
  });

  it("copies selected text and safe link addresses", async () => {
    const { contents, userClick, show } = fixture();
    userClick();
    show({ selectionText: "hello", linkURL: "https://example.com/a" });
    expect(labels().slice(0, 4)).toEqual(["Copy", "-", "Copy Link Address", "-"]);
    choose("Copy");
    expect(contents.copy).toHaveBeenCalledOnce();
    choose("Copy Link Address");
    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith("https://example.com/a");
  });

  it.each(["javascript:alert(1)", "file:///etc/hosts", "data:text/plain,x"])("offers no link copy for %s", (linkURL) => {
    const { userClick, show } = fixture();
    userClick();
    show({ linkURL });
    expect(labels()).not.toContain("Copy Link Address");
  });

  it("shows nothing while a capture holds the page", () => {
    const { captureLocked, contents, userClick, show } = fixture();
    captureLocked.add(contents as unknown as WebContents);
    userClick();
    show();
    expect(electron.build).not.toHaveBeenCalled();
  });

  it("shows nothing for a right-click the agent sent", () => {
    const { contents, show } = fixture();
    const sendInputEvent = vi.fn();
    Object.assign(contents, { sendInputEvent });
    sendAgentPageInput(contents as unknown as WebContents, { type: "mouseDown", x: 20, y: 30, button: "right", clickCount: 1 });
    contents.emit("input-event", {}, { type: "mouseDown", x: 20, y: 30 });
    show();
    expect(electron.build).not.toHaveBeenCalled();
  });

  it("does not act after the page closes and needs a live owner window", () => {
    const { contents, userClick, show } = fixture();
    userClick();
    show();
    contents.destroyed = true;
    choose("Reload");
    expect(contents.reload).not.toHaveBeenCalled();
    vi.clearAllMocks();
    const closed = fixture({ window: { isDestroyed: () => true } });
    closed.userClick();
    closed.show();
    expect(electron.build).not.toHaveBeenCalled();
  });
});

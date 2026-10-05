import { EventEmitter } from "node:events";
import type { BrowserWindow, ContextMenuParams } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({
  popup: vi.fn(), build: vi.fn(), writeText: vi.fn(async () => undefined), openExternal: vi.fn(async () => undefined),
}));
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: menu.build },
  clipboard: { writeText: menu.writeText },
  shell: { openExternal: menu.openExternal, openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { registerEditContextMenu } from "../../src/main/edit-context-menu";

const rendererUrl = "inertia://bundle/index.html";
function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, replaceMisspelling: vi.fn(), copyImageAt: vi.fn(), isDestroyed: vi.fn(() => false),
  });
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  registerEditContextMenu(window as unknown as BrowserWindow, (url) => url === rendererUrl);
  const params = {
    frame: contents.mainFrame, pageURL: rendererUrl, isEditable: true, selectionText: "", x: 41, y: 17,
    misspelledWord: "", dictionarySuggestions: [] as string[], linkURL: "", mediaType: "none", hasImageContents: false,
    editFlags: {
      canUndo: false, canRedo: false, canCut: false, canCopy: false,
      canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false,
    },
  };
  const show = (patch: Partial<ContextMenuParams> = {}) =>
    contents.emit("context-menu", {}, { ...params, ...patch });
  return { window, contents, show };
}

type Item = { label?: string; role?: string; type?: string; enabled?: boolean; click?: () => void };
const template = () => menu.build.mock.calls.at(-1)![0] as Item[];
const labelled = (label: string) => template().find((item) => item.label === label);

beforeEach(() => {
  vi.clearAllMocks();
  menu.build.mockReturnValue({ popup: menu.popup });
});

describe("native app editing menu", () => {
  it("allows paste in an empty editor without enabling selection actions", () => {
    const { window, show } = fixture();
    show();
    expect(menu.build).toHaveBeenCalledWith(expect.arrayContaining([
      { role: "paste", enabled: true },
      { role: "cut", enabled: false },
      { role: "copy", enabled: false },
      { role: "undo", enabled: false },
    ]));
    expect(menu.popup).toHaveBeenCalledWith({ window, x: 41, y: 17 });
  });

  it("opens a keyboard-invoked menu at the editor instead of the mouse pointer", () => {
    const { window, show } = fixture();
    show({ x: 451, y: 393, menuSourceType: "keyboard" });
    expect(menu.popup).toHaveBeenCalledExactlyOnceWith({ window, x: 451, y: 393 });
  });

  it("offers only Copy for selected read-only content", () => {
    const { show } = fixture();
    show({ isEditable: false, selectionText: "Message text", editFlags: {
      canUndo: false, canRedo: false, canCut: false, canCopy: true,
      canPaste: false, canDelete: false, canSelectAll: true, canEditRichly: false,
    } });
    expect(menu.build).toHaveBeenCalledWith([{ role: "copy", enabled: true }]);
  });

  it.each([
    { isEditable: false, selectionText: "" },
    { pageURL: "https://untrusted.example" },
    { frame: null },
    { frame: {} as Electron.WebFrameMain },
  ])("does not open an edit menu outside its trusted editing context (%j)", (patch) => {
    const { show } = fixture();
    show(patch);
    expect(menu.build).not.toHaveBeenCalled();
  });

  it("offers at most five spelling suggestions that replace the misspelled word", () => {
    const { contents, show } = fixture();
    show({ misspelledWord: "recieve", dictionarySuggestions: ["receive", "relieve", "recite", "revive", "reprieve", "receiver"] });
    const items = template();
    expect(items.slice(0, 6).map((item) => item.label ?? item.type)).toEqual([
      "receive", "relieve", "recite", "revive", "reprieve", "separator",
    ]);
    expect(items).toEqual(expect.arrayContaining([{ role: "paste", enabled: true }]));
    labelled("relieve")!.click!();
    expect(contents.replaceMisspelling).toHaveBeenCalledExactlyOnceWith("relieve");
  });

  it("says when a misspelled word has no suggestions", () => {
    const { show } = fixture();
    show({ misspelledWord: "qzxv", dictionarySuggestions: [] });
    expect(template()[0]).toEqual({ label: "No suggestions", enabled: false });
  });

  it("copies and opens a safe link from read-only content", async () => {
    const { show } = fixture();
    show({ isEditable: false, linkURL: "https://example.com/docs?q=1" });
    expect(template().map((item) => item.label ?? item.role ?? item.type)).toEqual([
      "Copy Link Address", "Open Link",
    ]);
    labelled("Copy Link Address")!.click!();
    expect(menu.writeText).toHaveBeenCalledExactlyOnceWith("https://example.com/docs?q=1");
    labelled("Open Link")!.click!();
    await vi.waitFor(() => expect(menu.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs?q=1"));
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://example.com/",
    "https://user:secret@example.com/",
    "inertia://bundle/index.html#/elsewhere",
    "data:text/html,hello",
  ])("offers no link actions for an unsafe link (%s)", (linkURL) => {
    const { show } = fixture();
    show({ isEditable: false, linkURL });
    expect(menu.build).not.toHaveBeenCalled();
  });

  it("copies an image at the clicked point", () => {
    const { contents, show } = fixture();
    show({ isEditable: false, mediaType: "image", hasImageContents: true, x: 120, y: 64 });
    expect(template().map((item) => item.label)).toEqual(["Copy Image"]);
    labelled("Copy Image")!.click!();
    expect(contents.copyImageAt).toHaveBeenCalledExactlyOnceWith(120, 64);
  });

  it("keeps selection Copy after link and image actions", () => {
    const { show } = fixture();
    show({
      isEditable: false, selectionText: "docs", linkURL: "https://example.com/",
      mediaType: "image", hasImageContents: true,
      editFlags: {
        canUndo: false, canRedo: false, canCut: false, canCopy: true,
        canPaste: false, canDelete: false, canSelectAll: true, canEditRichly: false,
      },
    });
    expect(template().map((item) => item.label ?? item.role ?? item.type)).toEqual([
      "Copy Link Address", "Open Link", "separator", "Copy Image", "separator", "copy",
    ]);
  });

  it("does nothing when an action runs after the page closed", () => {
    const { contents, show } = fixture();
    show({ isEditable: false, mediaType: "image", hasImageContents: true });
    contents.isDestroyed.mockReturnValue(true);
    labelled("Copy Image")!.click!();
    expect(contents.copyImageAt).not.toHaveBeenCalled();
  });

  it("ignores events after its owner closes", () => {
    const { window, show } = fixture();
    window.isDestroyed.mockReturnValue(true);
    show();
    expect(menu.build).not.toHaveBeenCalled();
  });
});

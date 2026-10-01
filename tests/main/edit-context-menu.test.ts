import { EventEmitter } from "node:events";
import type { BrowserWindow, ContextMenuParams } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({ popup: vi.fn(), build: vi.fn() }));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: menu.build } }));

import { registerEditContextMenu } from "../../src/main/edit-context-menu";

const rendererUrl = "inertia://bundle/index.html";
function fixture() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {} });
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  registerEditContextMenu(window as unknown as BrowserWindow, (url) => url === rendererUrl);
  const params = {
    frame: contents.mainFrame, pageURL: rendererUrl, isEditable: true, selectionText: "",
    editFlags: {
      canUndo: false, canRedo: false, canCut: false, canCopy: false,
      canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false,
    },
  };
  const show = (patch: Partial<ContextMenuParams> = {}) =>
    contents.emit("context-menu", {}, { ...params, ...patch });
  return { window, show };
}

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
    expect(menu.popup).toHaveBeenCalledWith({ window });
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

  it("ignores events after its owner closes", () => {
    const { window, show } = fixture();
    window.isDestroyed.mockReturnValue(true);
    show();
    expect(menu.build).not.toHaveBeenCalled();
  });
});

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

export function registerEditContextMenu(
  window: BrowserWindow,
  isTrustedRenderer: (url: string) => boolean,
): void {
  window.webContents.on("context-menu", (_event, params) => {
    if (
      window.isDestroyed()
      || params.frame !== window.webContents.mainFrame
      || !isTrustedRenderer(params.pageURL)
      || (!params.isEditable && !params.selectionText)
    ) return;
    const flags = params.editFlags;
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "undo", enabled: flags.canUndo },
          { role: "redo", enabled: flags.canRedo },
          { type: "separator" },
          { role: "cut", enabled: flags.canCut },
          { role: "copy", enabled: flags.canCopy },
          { role: "paste", enabled: flags.canPaste },
          { role: "pasteAndMatchStyle", enabled: flags.canPaste },
          { role: "delete", enabled: flags.canDelete },
          { type: "separator" },
          { role: "selectAll", enabled: flags.canSelectAll },
        ]
      : [{ role: "copy", enabled: flags.canCopy }];
    Menu.buildFromTemplate(items).popup({ window, x: params.x, y: params.y });
  });
}

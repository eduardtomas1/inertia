import { Menu, type MenuItemConstructorOptions } from "electron";

export function applicationMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const close: MenuItemConstructorOptions = { role: "close", accelerator: "Shift+CmdOrCtrl+W" };
  return [
    ...(mac ? [{ role: "appMenu" } satisfies MenuItemConstructorOptions] : []),
    { role: "fileMenu", submenu: mac ? [close] : [{ role: "quit" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      role: "windowMenu",
      submenu: mac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }, { role: "zoom" }, close],
    },
    { role: "help", submenu: [] },
  ];
}

export function installApplicationMenu(platform: NodeJS.Platform = process.platform): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(platform)));
}

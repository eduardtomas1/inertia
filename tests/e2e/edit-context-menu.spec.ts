// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";

import { createAppFixture } from "./support/app-fixture";

for (const detached of [false, true]) test(`offers working native edit commands in the ${detached ? "detached chat" : "main"} window`, async () => {
  const app = await createAppFixture({
    name: "edit-context-menu",
    initialState: "conversation",
    windowDisplay: "primary",
  });
  try {
    await app.electronApp.evaluate(({ Menu, clipboard }) => {
      Reflect.set(globalThis, "editContextMenus", []);
      Menu.prototype.popup = function (options) {
        (Reflect.get(globalThis, "editContextMenus") as Electron.Menu[]).push(this);
        Reflect.set(globalThis, "editContextWindow", options?.window);
      };
      return clipboard.writeText("Pasted through the native menu");
    });
    let page = app.page;
    if (detached) {
      await page.locator(".workspace-header").getByRole("button", {
        name: "edit-context-menu fixture", exact: true,
      }).click();
      const opened = app.electronApp.waitForEvent("window");
      await page.getByRole("menuitem", { name: "Open chat in new window" }).click();
      page = await opened;
      await page.locator(".detached-chat-shell").waitFor();
    }
    const input = page.getByRole("textbox", { name: "Message" });
    const menuCount = () => app.electronApp.evaluate(() =>
      (Reflect.get(globalThis, "editContextMenus") as Electron.Menu[]).length);
    const openMenu = async () => {
      const previous = await menuCount();
      await input.click({ button: "right" });
      await expect.poll(menuCount).toBe(previous + 1);
    };
    await input.click();
    await openMenu();

    const roles = await app.electronApp.evaluate(() => {
      const menu = (Reflect.get(globalThis, "editContextMenus") as Electron.Menu[]).at(-1)!;
      return menu.items.filter((item) => item.type !== "separator")
        .map(({ role, enabled }) => ({ role, enabled }));
    });
    expect(roles).toEqual(expect.arrayContaining([
      { role: "cut", enabled: false },
      { role: "copy", enabled: false },
      { role: "paste", enabled: true },
      { role: "selectall", enabled: false },
    ]));

    const selectItem = async (role: string) => {
      await app.electronApp.evaluate((_electron, selectedRole) => {
        const menu = (Reflect.get(globalThis, "editContextMenus") as Electron.Menu[]).at(-1)!;
        const item = menu.items.find((entry) => entry.role === selectedRole);
        const window = Reflect.get(globalThis, "editContextWindow") as Electron.BrowserWindow;
        if (!item?.enabled) throw new Error(`The native ${selectedRole} action is unavailable.`);
        if (process.platform === "darwin") {
          const commands: Record<string, () => void> = {
            paste: () => window.webContents.paste(),
            copy: () => window.webContents.copy(),
            cut: () => window.webContents.cut(),
            undo: () => window.webContents.undo(),
            redo: () => window.webContents.redo(),
            selectall: () => window.webContents.selectAll(),
          };
          if (!commands[selectedRole]) throw new Error("Unknown edit role.");
          commands[selectedRole]();
        } else {
          item.click({} as Electron.KeyboardEvent, window, window.webContents);
        }
      }, role);
    };
    await selectItem("paste");
    await expect(input).toHaveValue("Pasted through the native menu");
    await openMenu();
    await selectItem("selectall");
    await openMenu();
    await app.electronApp.evaluate(({ clipboard }) => clipboard.writeText("Copy replacement"));
    await selectItem("copy");
    await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("Pasted through the native menu");
    await openMenu();
    await selectItem("cut");
    await expect(input).toHaveValue("");
    await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("Pasted through the native menu");
    await openMenu();
    await selectItem("undo");
    await expect(input).toHaveValue("Pasted through the native menu");
    await openMenu();
    await selectItem("redo");
    await expect(input).toHaveValue("");
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

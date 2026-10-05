// @inertia-e2e-resource primary-display
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator } from "@playwright/test";

import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, openTerminalDock, selectWorkspaceTool } from "./support/workspace-tools";

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
        Reflect.set(globalThis, "editContextPosition", { x: options?.x, y: options?.y });
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

    const keyboardMenus = await menuCount();
    await page.keyboard.press("ContextMenu");
    await expect.poll(menuCount).toBe(keyboardMenus + 1);
    const position = await app.electronApp.evaluate(() =>
      Reflect.get(globalThis, "editContextPosition") as { x?: number; y?: number });
    const box = (await input.boundingBox())!;
    expect(position.x).toBeGreaterThanOrEqual(Math.floor(box.x));
    expect(position.x).toBeLessThanOrEqual(Math.ceil(box.x + box.width));
    expect(position.y).toBeGreaterThanOrEqual(Math.floor(box.y));
    expect(position.y).toBeLessThanOrEqual(Math.ceil(box.y + box.height));

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

type RecordedMenuItem = { label: string; role: string | null; enabled: boolean; separator: boolean };

async function recordMenus(app: Awaited<ReturnType<typeof createAppFixture>>): Promise<void> {
  await app.electronApp.evaluate(({ Menu }) => {
    Reflect.set(globalThis, "surfaceMenus", []);
    Menu.prototype.popup = function (options) {
      (Reflect.get(globalThis, "surfaceMenus") as Electron.Menu[]).push(this);
      Reflect.set(globalThis, "surfaceMenuWindow", options?.window);
      Reflect.set(globalThis, "surfaceMenuPosition", { x: options?.x, y: options?.y });
    };
  });
}

function surfaceMenuCount(app: Awaited<ReturnType<typeof createAppFixture>>): Promise<number> {
  return app.electronApp.evaluate(() => (Reflect.get(globalThis, "surfaceMenus") as Electron.Menu[]).length);
}

async function openSurfaceMenu(
  app: Awaited<ReturnType<typeof createAppFixture>>,
  target: Locator,
): Promise<RecordedMenuItem[]> {
  const previous = await surfaceMenuCount(app);
  await target.click({ button: "right" });
  await expect.poll(() => surfaceMenuCount(app)).toBe(previous + 1);
  return await app.electronApp.evaluate(() => {
    const menu = (Reflect.get(globalThis, "surfaceMenus") as Electron.Menu[]).at(-1)!;
    return menu.items.map((item) => ({
      label: item.type === "separator" ? "-" : item.label,
      role: item.role ?? null,
      enabled: item.enabled,
      separator: item.type === "separator",
    }));
  });
}

async function chooseSurfaceItem(
  app: Awaited<ReturnType<typeof createAppFixture>>,
  name: { label?: string; role?: string },
): Promise<void> {
  await app.electronApp.evaluate((_electron, selected) => {
    const menu = (Reflect.get(globalThis, "surfaceMenus") as Electron.Menu[]).at(-1)!;
    const window = Reflect.get(globalThis, "surfaceMenuWindow") as Electron.BrowserWindow;
    const item = menu.items.find((entry) => selected.role ? entry.role === selected.role : entry.label === selected.label);
    if (!item?.enabled) throw new Error("The context menu item is unavailable.");
    if (selected.role === "paste" && process.platform === "darwin") window.webContents.paste();
    else item.click({} as Electron.KeyboardEvent, window, window.webContents);
  }, name);
}

const visibleLabels = (items: RecordedMenuItem[]) => items
  .filter((item) => !item.separator && item.label !== "Inspect Element")
  .map((item) => item.role ? `role:${item.role}` : item.enabled ? item.label : `${item.label} (disabled)`);

for (const detached of [false, true]) test(`copies transcript content from the surface menu in the ${detached ? "detached chat" : "main"} window`, async () => {
  const app = await createAppFixture({
    name: "surface-context-menu",
    initialState: "conversation",
    seedAssistantCodeBlock: true,
    windowDisplay: "primary",
  });
  try {
    await recordMenus(app);
    let page = app.page;
    if (detached) {
      await page.locator(".workspace-header").getByRole("button", {
        name: "surface-context-menu fixture", exact: true,
      }).click();
      const opened = app.electronApp.waitForEvent("window");
      await page.getByRole("menuitem", { name: "Open chat in new window" }).click();
      page = await opened;
      await page.locator(".detached-chat-shell").waitFor();
    }
    const answer = page.locator("article.message.is-assistant");
    const heading = answer.getByRole("heading", { name: "Settings fixture" });
    const items = await openSurfaceMenu(app, heading);
    expect(visibleLabels(items)).toEqual(["Copy Message", "Copy as Markdown"]);
    const box = (await heading.boundingBox())!;
    const position = await app.electronApp.evaluate(() =>
      Reflect.get(globalThis, "surfaceMenuPosition") as { x: number; y: number });
    expect(position.x).toBeGreaterThanOrEqual(Math.floor(box.x));
    expect(position.x).toBeLessThanOrEqual(Math.ceil(box.x + box.width));
    expect(position.y).toBeGreaterThanOrEqual(Math.floor(box.y));
    expect(position.y).toBeLessThanOrEqual(Math.ceil(box.y + box.height));
    await chooseSurfaceItem(app, { label: "Copy Message" });
    await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("Settings fixture\n\nconst ready: boolean = true;");

    expect(visibleLabels(await openSurfaceMenu(app, answer.locator("pre")))).toEqual(["Copy Code"]);
    await chooseSurfaceItem(app, { label: "Copy Code" });
    await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("const ready: boolean = true;");
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("pastes into the workspace shell from the terminal menu", async () => {
  test.skip(process.platform === "win32", "The pasted command uses POSIX shell syntax.");
  const app = await createAppFixture({
    name: "terminal-context-menu",
    initialState: "conversation",
    windowDisplay: "primary",
  });
  try {
    await recordMenus(app);
    const { page } = app;
    const dock = await openTerminalDock(page);
    await expect(dock.locator(".terminal-panel[data-terminal-state=ready]")).toHaveCount(1);
    const output = join(app.workspaceDirectory, "terminal-menu-paste.txt");
    await app.electronApp.evaluate(({ clipboard }, path) => clipboard.writeText(
      `printf 'pasted-through-menu' > '${path}'`,
    ), output);
    const items = await openSurfaceMenu(app, dock.locator(".terminal-mount"));
    expect(visibleLabels(items)).toEqual(["Copy (disabled)", "role:paste", "Select All", "Clear"]);
    await chooseSurfaceItem(app, { role: "paste" });
    await expect(dock.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => readFile(output, "utf8").catch(() => "")).toBe("pasted-through-menu");
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("offers link and navigation actions for a user's right-click in the Browser pane", async () => {
  const app = await createAppFixture({
    name: "browser-context-menu",
    initialState: "conversation",
    windowDisplay: "primary",
  });
  try {
    await recordMenus(app);
    const { page } = app;
    await ensureWorkspaceTools(page);
    await selectWorkspaceTool(page.locator(".workspace-panel"), "Browser");
    const pageUrl = new URL("/agent-browser-page", app.previewUrl).toString();
    await page.getByRole("textbox", { name: "Preview address" }).fill(pageUrl);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect.poll(() => app.electronApp.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some((contents) => contents.getURL() === url && !contents.isLoading()), pageUrl))
      .toBe(true);
    const previous = await surfaceMenuCount(app);
    await app.electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      const point = await contents.executeJavaScript(
        "(() => { const box = document.querySelector('a').getBoundingClientRect(); return { x: Math.round(box.x + 4), y: Math.round(box.y + box.height / 2) }; })()",
      ) as { x: number; y: number };
      contents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
      contents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...point });
    }, pageUrl);
    await expect.poll(() => surfaceMenuCount(app)).toBe(previous + 1);
    const items = await app.electronApp.evaluate(() => {
      const menu = (Reflect.get(globalThis, "surfaceMenus") as Electron.Menu[]).at(-1)!;
      return menu.items.map((item) => item.type === "separator" ? "-" : item.enabled ? item.label : `${item.label} (disabled)`);
    });
    expect(items).toEqual([
      ...process.platform === "darwin" ? ["Copy", "-"] : [],
      "Copy Link Address", "-", "Back (disabled)", "Forward (disabled)", "Reload",
    ]);
    await chooseSurfaceItem(app, { label: "Copy Link Address" });
    await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(new URL("/agent-browser-destination", app.previewUrl).toString());
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

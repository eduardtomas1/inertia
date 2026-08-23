import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "window-health-recovery",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory }) => {
      const profile = join(testDirectory, "electron-profile");
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, "window-state.json"), JSON.stringify({
        x: 100_000,
        y: 100_000,
        width: 1_180,
        height: 760,
        maximized: false,
      }), { encoding: "utf8", mode: 0o600 });
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

test("restores a saved off-screen window with a reachable title bar", async ({
  browserName: _browserName,
}, testInfo) => {
  const geometry = await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("The main window is unavailable");
    return {
      bounds: window.getBounds(),
      workAreas: screen.getAllDisplays().map(({ workArea }) => workArea),
    };
  });
  expect(geometry.bounds).toMatchObject({ width: 1_180, height: 760 });
  expect(geometry.workAreas.some((workArea) => {
    const titleWidth = Math.min(
      geometry.bounds.x + geometry.bounds.width,
      workArea.x + workArea.width,
    ) - Math.max(geometry.bounds.x, workArea.x);
    const titleHeight = Math.min(
      geometry.bounds.y + 48,
      workArea.y + workArea.height,
    ) - Math.max(geometry.bounds.y, workArea.y);
    return titleWidth >= 80 && titleHeight >= 32;
  })).toBe(true);
  const screenshot = testInfo.outputPath("restored-off-screen-window.png");
  await page.screenshot({ animations: "disabled", path: screenshot });
  await testInfo.attach("Restored off-screen main window", {
    path: screenshot,
    contentType: "image/png",
  });
});

test("renders partial health failures without hiding healthy metrics", async ({
  browserName: _browserName,
}, testInfo) => {
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const session = BrowserWindow.getAllWindows()[0]?.webContents.session;
    if (!session) throw new Error("The main renderer session is unavailable");
    const original = session.getCacheSize;
    Reflect.set(session, "getCacheSize", async () => {
      throw new Error("simulated cache measurement failure");
    });
    Reflect.set(globalThis, "__restoreInertiaHealthCacheSize", () => {
      Reflect.set(session, "getCacheSize", original);
      Reflect.deleteProperty(globalThis, "__restoreInertiaHealthCacheSize");
    });
  });
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Archive & data", exact: true }).click();
    await expect(page.getByText("Partial health data", { exact: true }))
      .toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "Browser cache storage could not be measured.",
    );
    await expect(page.getByText("Browser cache", { exact: true })
      .locator("..").locator("b")).toHaveText("Unavailable");
    await expect(page.getByText("Database", { exact: true })
      .locator("..").locator("b")).not.toHaveText("Unavailable");

    const screenshot = testInfo.outputPath("partial-health-warning.png");
    await page.screenshot({ animations: "disabled", path: screenshot });
    await testInfo.attach("Partial local health warning", {
      path: screenshot,
      contentType: "image/png",
    });
  } finally {
    await app.electronApp.evaluate(() => {
      const restore = Reflect.get(
        globalThis,
        "__restoreInertiaHealthCacheSize",
      );
      if (typeof restore === "function") restore();
    });
  }
});

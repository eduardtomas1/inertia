import { expect, type ElectronApplication, type Page } from "@playwright/test";

export async function focusAppWindow(electronApp: ElectronApplication, page: Page): Promise<void> {
  const window = await electronApp.browserWindow(page);
  await window.evaluate((browserWindow) => { browserWindow.focus(); browserWindow.webContents.focus(); });
  await expect.poll(() => page.evaluate(() => document.visibilityState === "visible" && document.hasFocus())).toBe(true);
}

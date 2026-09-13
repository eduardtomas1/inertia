// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { join, resolve } from "node:path";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import type { SidebarUpdateFixture } from "./support/sidebar-update-fixture";

type FixtureGlobal = typeof globalThis & { sidebarUpdateFixture: SidebarUpdateFixture };
let app: AppFixture;
test.afterAll(async () => { await app?.close(); });

test("sidebar updater uses real main actions, bounded notes and safe restart in both themes", async ({ browserName: _browserName }, testInfo) => {
  let moduleUrl = "";
  app = await createAppFixture({ name: "sidebar-update", initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: async ({ testDirectory }) => {
      const output = join(testDirectory, "sidebar-update-fixture.cjs");
      await build({ entryPoints: [resolve("tests/e2e/support/sidebar-update-fixture.ts")], outfile: output,
        bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
      moduleUrl = output;
    } });
  const page = app.page;
  const button = page.locator(".sidebar-update-button");
  // Settle the hook's scheduled startup check, including its final rotation.
  // A direct IPC check does not settle that timer and can leave a later click
  // blocked by the unrelated startup check while its icon says "checking".
  await expect(button).toHaveAccessibleName("Up to date — check again");
  await expect(button).toHaveAttribute("data-update-state", "idle");
  await app.electronApp.evaluate(async ({ ipcMain, BrowserWindow }, url) => {
    const load = process.getBuiltinModule("module").createRequire(url);
    const module = load(url) as typeof import("./support/sidebar-update-fixture");
    const owner = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())!.webContents;
    (globalThis as FixtureGlobal).sidebarUpdateFixture = await module.installUpdateFixture(ipcMain, owner);
  }, moduleUrl);
  const popup = page.getByRole("dialog", { name: "Application update details" });
  const capture = async (name: string): Promise<void> => {
    await app.expectNoViewportOverflow();
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  for (const theme of ["dark", "light"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await button.hover();
    await expect(popup).toBeVisible();
    const geometry = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const panel = document.querySelector(".sidebar-update-details")!.getBoundingClientRect();
      return { width: box.width, height: box.height, left: panel.left, right: panel.right, top: panel.top, gap: box.top - panel.bottom, viewport: innerWidth };
    });
    expect(geometry.width).toBe(32); expect(geometry.height).toBe(32);
    expect(geometry.left).toBeGreaterThanOrEqual(8); expect(geometry.right).toBeLessThanOrEqual(geometry.viewport - 8);
    expect(geometry.top).toBeGreaterThanOrEqual(8); expect(geometry.gap).toBeCloseTo(8, 0);
    if (theme === "dark") {
      await expect(button).toHaveAttribute("data-update-state", "idle");
      await capture("update-current-dark");
      await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.holdCheck());
      await button.click();
      await expect.poll(async () => await app.electronApp.evaluate(
        () => (globalThis as FixtureGlobal).sidebarUpdateFixture.counts.checks,
      )).toBe(1);
      await expect(button).toHaveAttribute("data-update-state", "checking");
      await expect(page.locator(".update-status-icon.is-checking")).toHaveCSS("animation-name", "sidebar-update-check");
      await capture("update-checking-dark");
      await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.finishCheck());
      await expect(button).toHaveAttribute("data-update-state", "available");
      await button.hover();
      await expect(popup.getByRole("heading", { name: "What’s changed in 1.2.3" })).toBeVisible();
      await capture("update-available-dark");
      await button.click();
      await expect(button).toHaveAttribute("data-update-state", "downloading");
      await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.progress(43));
      await expect(popup.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "43");
      await capture("update-downloading-dark");
      // Move from the icon across its gap into the hover panel, then cancel via UI.
      await popup.getByRole("button", { name: "Cancel download" }).hover();
      await popup.getByRole("button", { name: "Cancel download" }).click();
      await expect(button).toHaveAccessibleName("Update download cancelled — retry");
      await button.click(); await expect(button).toHaveAttribute("data-update-state", "downloading");
      // Native focus loss must not dismiss details still owned by the pointer.
      // Exercise this explicitly on every OS, not only macOS's focus behavior.
      await button.focus(); await button.evaluate((node) => node.blur());
      await expect(popup).toBeVisible();
      await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.failDownload());
      await expect(button).toHaveAttribute("data-update-state", "attention");
      await button.hover(); await expect(popup).toContainText("The update could not be downloaded.");
      await expect(popup).not.toContainText("private fixture"); await capture("update-failed-dark");
      await button.click(); await expect(button).toHaveAttribute("data-update-state", "downloading");
      await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.finishDownload());
      await expect(button).toHaveAttribute("data-update-state", "downloaded");
    }
    await button.hover(); await capture(`update-ready-${theme}`);
    await button.focus(); await button.press("ArrowUp");
    await expect(popup.getByRole("button", { name: "Close update details" })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(popup).toBeHidden(); await expect(button).toBeFocused();
    await button.press("Enter");
    const confirmation = page.getByRole("dialog", { name: "Restart to install Inertia 1.2.3?" });
    await expect(confirmation).toBeVisible(); await expect(confirmation.getByRole("button", { name: "Not now" })).toBeFocused();
    const modalGeometry = await confirmation.evaluate((node) => {
      const box = node.getBoundingClientRect(); const buttons = [...node.querySelectorAll("button")].map((element) => element.getBoundingClientRect());
      return { centerX: box.left + box.width / 2, centerY: box.top + box.height / 2,
        viewportX: innerWidth / 2, viewportY: innerHeight / 2, buttonOffset: buttons[0]!.top - buttons[1]!.top };
    });
    expect(Math.abs(modalGeometry.centerX - modalGeometry.viewportX)).toBeLessThan(1);
    expect(Math.abs(modalGeometry.centerY - modalGeometry.viewportY)).toBeLessThan(1);
    expect(Math.abs(modalGeometry.buttonOffset)).toBeLessThan(1);
    await capture(`update-confirm-${theme}`);
    await page.keyboard.press("Escape"); await expect(confirmation).toBeHidden(); await expect(button).toBeFocused();
  }
  await button.click();
  await page.getByRole("dialog", { name: "Restart to install Inertia 1.2.3?" }).getByRole("button", { name: "Restart to update" }).click();
  await expect(button).toHaveAttribute("data-update-state", "attention");
  await button.hover(); await expect(popup).toContainText("Finish active agent work before restarting to update.");
  await capture("update-blocked-light");
  const counts = await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.counts);
  expect(counts).toMatchObject({ downloads: 3, installs: 1, cleanup: 0, quits: 0 });
  await app.resizeWindow(900, 700); await button.hover(); await expect(popup).toBeVisible();
  await capture("update-compact-light");
  expect(app.rendererErrors).toEqual([]);
});

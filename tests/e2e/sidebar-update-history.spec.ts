// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { join, resolve } from "node:path";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import type { SidebarUpdateFixture } from "./support/sidebar-update-fixture";

type FixtureGlobal = typeof globalThis & { sidebarUpdateFixture: SidebarUpdateFixture };
let app: AppFixture;
test.afterAll(async () => { await app?.close(); });

const release = (version: string, body: string) => ({ tag_name: `v${version}`, body, draft: false, prerelease: false });
const RELEASES = [
  release("1.2.3", "Not shown twice"),
  release("1.2.2", "Tasks that follow the agent, a more dependable Duo judge, and\n**Claude**'s own agents, skills and instructions.\n\n### Tasks\n\n- One\n- Two\n- Three"),
  release("1.2.1", "### Chats\n\n- Copy and Snooze submenus stay open while the pointer crosses into them.\n- Queued messages send mid-turn.\n- New chats no longer offer earlier messages.\n- The thinking label keeps its icon."),
  release("1.2.0", "Electron 44.9.3 with the eMudhra certificate fix."),
  release("1.1.9", "- The Windows broker shuts down cleanly."),
  release("1.1.8", "A calmer sidebar and faster deletes."),
  release("1.1.7", "Older"),
  release("1.1.6", "Older still"),
  release("1.1.5", "Installed"),
];

test("an update several releases ahead stacks their notes under the newest", async ({ browserName: _browserName }, testInfo) => {
  let moduleUrl = "";
  app = await createAppFixture({ name: "sidebar-update-history", initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: async ({ testDirectory }) => {
      const output = join(testDirectory, "sidebar-update-fixture.cjs");
      await build({ entryPoints: [resolve("tests/e2e/support/sidebar-update-fixture.ts")], outfile: output,
        bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
      moduleUrl = output;
    } });
  const page = app.page;
  const button = page.locator(".sidebar-update-button");
  await expect(button).toHaveAccessibleName("Up to date — check again");
  await app.electronApp.evaluate(async ({ ipcMain, BrowserWindow }, { url, releases }) => {
    const load = process.getBuiltinModule("module").createRequire(url);
    const module = load(url) as typeof import("./support/sidebar-update-fixture");
    const owner = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())!.webContents;
    (globalThis as FixtureGlobal).sidebarUpdateFixture = await module.installUpdateFixture(ipcMain, owner,
      { installedVersion: "1.1.5", releases });
  }, { url: moduleUrl, releases: RELEASES });
  await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.holdCheck());
  await button.click();
  await app.electronApp.evaluate(() => (globalThis as FixtureGlobal).sidebarUpdateFixture.finishCheck());
  await expect(button).toHaveAttribute("data-update-state", "available");
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
    await expect(popup).toContainText("Inertia · Installed 1.1.5 · 8 releases ago");
    await expect(popup.getByRole("heading", { level: 3 })).toHaveText([
      "What’s changed in 1.2.3", "Also in 1.2.2", "Also in 1.2.1", "Also in 1.2.0", "Also in 1.1.9", "Also in 1.1.8",
    ]);
    await expect(popup.locator(".update-release-group").nth(1)).toContainText(
      "Tasks that follow the agent, a more dependable Duo judge, and Claude's own agents, skills and instructions.");
    await expect(popup.locator(".update-release-group").nth(1).locator("strong")).toHaveText("Claude");
    await expect(popup.locator(".update-release-group").nth(1).locator("strong")).toHaveCSS("display", "inline");
    await expect(popup.getByRole("button", { name: "3 more changes for 1.2.2" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "1 more change for 1.2.1" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "View release for 1.2.0" })).toBeVisible();
    await expect(popup.locator("a, img")).toHaveCount(0);
    await capture(`update-history-${theme}`);
    const body = popup.locator(".update-release-body");
    await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(popup.getByRole("button", { name: "2 older releases on the release page" })).toBeInViewport();
    await capture(`update-history-end-${theme}`);
    const geometry = await popup.evaluate((node) => {
      const panel = node.getBoundingClientRect();
      const scroll = node.querySelector(".update-release-body")!;
      return { left: panel.left, right: panel.right, top: panel.top, viewport: innerWidth, scrolls: scroll.scrollHeight > scroll.clientHeight };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(8); expect(geometry.right).toBeLessThanOrEqual(geometry.viewport - 8);
    expect(geometry.top).toBeGreaterThanOrEqual(8); expect(geometry.scrolls).toBe(true);
    await page.mouse.move(600, 400);
    await expect(popup).toBeHidden();
  }
  await button.focus(); await button.press("ArrowUp");
  await expect(popup.getByRole("button", { name: "Close update details" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(popup.locator(".update-release-body")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(popup.getByRole("button", { name: "3 more changes for 1.2.2" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(popup).toBeHidden(); await expect(button).toBeFocused();
  await app.resizeWindow(900, 700); await button.hover(); await expect(popup).toBeVisible();
  await capture("update-history-compact-light");
  expect(app.rendererErrors).toEqual([]);
});

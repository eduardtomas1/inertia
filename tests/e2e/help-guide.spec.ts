// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { setAppearanceInPlace } from "./support/appearance";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "help-guide",
    initialState: "empty",
    welcomeGuide: true,
  });
});

test.afterAll(async () => {
  await app?.close();
});

async function settle(dialog: Locator): Promise<void> {
  await expect.poll(() => dialog.evaluate((element) => (
    element.getAnimations().every((animation) => animation.playState === "finished")
  ))).toBe(true);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("opens Help from the sidebar, walks its topics and leaves the welcome guide as it was", async ({ browserName: _browserName }, testInfo) => {
  const { page } = app;
  await app.resizeWindow(1280, 800);
  await setAppearanceInPlace(app, "dark");

  const welcome = page.getByRole("dialog", { name: "Welcome guide" });
  await expect(welcome.getByRole("heading", { name: "Welcome to Inertia" })).toBeVisible();
  await expect(welcome.getByRole("button", { name: "Take the tour" })).toBeFocused();
  await settle(welcome);
  await capture(page, testInfo, "welcome-guide-unchanged-dark");
  await welcome.getByRole("button", { name: "Skip" }).click();
  await expect(welcome).toHaveCount(0);
  const seen = await page.evaluate(() => window.localStorage.getItem("inertia:welcome-guide:v1"));
  expect(seen).not.toBeNull();

  const opener = page.getByRole("button", { name: "Help", exact: true });
  await expect(opener).toBeVisible();
  await opener.hover();
  await capture(page, testInfo, "help-entry-point-dark");

  await opener.click();
  const help = page.getByRole("dialog", { name: "Help" });
  await expect(help).toBeVisible();
  await expect(help.getByRole("tab", { name: "Getting started" })).toBeFocused();
  await settle(help);
  await capture(page, testInfo, "help-getting-started-dark");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const following = help.getByRole("tab", { name: "Following work" });
  await expect(following).toBeFocused();
  await expect(following).toHaveAttribute("aria-selected", "true");
  await expect(help.getByRole("tabpanel", { name: "Following work" }))
    .toContainText("Daily work in the sidebar");
  await settle(help);
  await capture(page, testInfo, "help-following-work-dark");

  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(opener).toBeFocused();

  await setAppearanceInPlace(app, "light");
  await opener.click();
  await expect(help.getByRole("tab", { name: "Getting started" })).toBeFocused();
  await settle(help);
  await capture(page, testInfo, "help-getting-started-light");
  await help.getByRole("tab", { name: "Review and ship" }).click();
  await settle(help);
  await capture(page, testInfo, "help-review-and-ship-light");
  await help.getByRole("button", { name: "Close" }).click();
  await expect(help).toHaveCount(0);
  await expect(opener).toBeFocused();

  await app.resizeWindow(760, 600);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const palette = page.getByRole("dialog", { name: "Search Inertia" });
  await palette.getByRole("combobox").fill("help");
  await palette.getByRole("option", { name: /Open help/u }).click();
  await expect(help).toBeVisible();
  await settle(help);
  const bounds = await help.boundingBox();
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  await help.getByRole("tab", { name: "Keyboard" }).click();
  await settle(help);
  await capture(page, testInfo, "help-keyboard-minimum-width-light");

  await help.getByRole("button", { name: "Open Settings → Keybindings" }).click();
  await expect(help).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();

  expect(await page.evaluate(() => window.localStorage.getItem("inertia:welcome-guide:v1"))).toBe(seen);
  await expect(welcome).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import type { AppFixture } from "./support/app-fixture";
import { createModelChooserFixture } from "./support/model-chooser-fixture";
import { expectModelChooserPlacement } from "./support/model-chooser-geometry";

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createModelChooserFixture("model-chooser-centering");
});

test.afterAll(async () => {
  await app?.close();
});

test("repositions an open chooser when empty-thread layout centers its unchanged trigger", async () => {
  const { page, electronApp, resizeWindow, rendererErrors } = app;
  await resizeWindow(1440, 920);
  const nativeWindow = await electronApp.browserWindow(page);
  const nativeHeight = await page.evaluate(() => innerHeight);
  const chooser = page.getByRole("dialog", { name: "Choose model" });
  const workspace = page.locator(".chat-workspace");
  try {
    await nativeWindow.evaluate((window, height) => {
      window.webContents.setZoomFactor(Math.min(1, height / 920));
    }, nativeHeight);
    await expect.poll(() => page.evaluate(() => innerHeight)).toBeGreaterThanOrEqual(919);
    await expect(workspace).toHaveClass(/is-empty-thread/u);
    await expect(workspace).not.toHaveAttribute("aria-busy", "true");
    // Reproduce detailLoading's flex-to-grid transition after the chooser is
    // open, using the production CSS and actual Electron layout. No sizes change.
    await workspace.evaluate((element) => element.classList.remove("is-empty-thread"));
    const trigger = page.getByRole("button", { name: /^Choose model\./u });
    await trigger.click();
    await chooser.getByRole("button", { name: /^Codex, \d+ models?$/u }).click();
    await expectModelChooserPlacement(chooser, "above");
    const measureTrigger = () => trigger.evaluate((element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
      y: element.getBoundingClientRect().y,
    }));
    const before = await measureTrigger();
    const previousMaxHeight = await chooser.evaluate((element) => getComputedStyle(element).maxHeight);
    await workspace.evaluate((element) => element.classList.add("is-empty-thread"));
    await expectModelChooserPlacement(chooser, "below");
    const after = await measureTrigger();
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(after.y).toBeLessThan(before.y);
    expect(await chooser.evaluate((element) => getComputedStyle(element).maxHeight))
      .not.toBe(previousMaxHeight);
    await expect(chooser.getByRole("searchbox", { name: "Search models" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(chooser).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(rendererErrors).toEqual([]);
  } finally {
    await workspace.evaluate((element) => element.classList.add("is-empty-thread"));
    await nativeWindow.evaluate((window) => window.webContents.setZoomFactor(1));
    await nativeWindow.dispose();
  }
});

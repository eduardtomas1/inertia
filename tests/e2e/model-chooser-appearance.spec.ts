// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import type { AppFixture } from "./support/app-fixture";
import { createModelChooserFixture } from "./support/model-chooser-fixture";
import { expectModelChooserPlacement, expectModelChooserVerticalFallback } from "./support/model-chooser-geometry";
import { modelChooserContentGeometry } from "../support/model-chooser-placement";

let app!: AppFixture;
let page!: AppFixture["page"];
let resizeWindow!: AppFixture["resizeWindow"];
let rendererErrors!: AppFixture["rendererErrors"];

test.beforeAll(async () => {
  // Seed this scenario's catalog before launch: a preceding test may never run,
  // or Playwright may replace its worker after a failure.
  app = await createModelChooserFixture("model-chooser-appearance", { nativeModels: true });
  page = app.page;
  resizeWindow = app.resizeWindow;
  rendererErrors = app.rendererErrors;
});

test.afterAll(async () => {
  await app?.close();
});

test("keeps branded model sources and rows legible across themes and narrow windows", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  // The fixture supplies 600 models across five real backend profiles.
  // Disable them through Settings before photographing an ordinary
  // setup, also proving unavailable profiles do not leave empty rail icons.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Model backends", exact: true }).click();
  const profiles = page.getByLabel("Backend profiles");
  const gateways = profiles.getByRole("button", { name: /^Catalog gateway /u });
  await expect(gateways).toHaveCount(5);
  for (const gateway of await gateways.all()) {
    await gateway.click();
    const enabled = page.getByRole("switch", { name: /^Enable Catalog gateway /u });
    await expect(enabled).toBeChecked();
    await enabled.click();
    await expect(enabled).not.toBeChecked();
    await expect(enabled).toBeEnabled();
  }
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("complementary", { name: "Project navigation", exact: true })
    .getByRole("button", { name: "New chat", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Choose model" });
  const trigger = page.getByRole("button", { name: /^Choose model\./u });
  const capture = async (name: string, vertical?: "above" | "below"): Promise<void> => {
    await expectModelChooserPlacement(chooser, vertical);
    await expect(chooser.locator('[data-model-source-rail-item^="custom:"]')).toHaveCount(0);
    await expect(chooser.locator('[data-model-source-rail-item^="provider:"]')).toHaveCount(2);
    await expect(trigger.locator(".provider-brand-icon")).toBeVisible();
    for (const source of await chooser.locator("[data-model-source-rail-item]").all()) {
      await expect(source).toBeInViewport({ ratio: 1 });
    }
    const search = chooser.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeInViewport({ ratio: 1 });
    await expect.poll(() => search.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === element;
    })).toBe(true);
    await expect.poll(() => chooser.locator("img").evaluateAll((images) =>
      images.length > 0 && images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
    )).toBe(true);
    const bounds = await chooser.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await app.expectNoViewportOverflow();
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };

  for (const theme of ["Light", "Dark"] as const) {
    await resizeWindow(1440, 920);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("radio", { name: theme, exact: true }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await trigger.click();
    const search = chooser.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeFocused();
    for (const [provider, id] of [["Codex", "codex"], ["Claude", "claude"]] as const) {
      const source = chooser.getByRole("button", { name: new RegExp(`^${provider}, \\d+ models?$`, "u") });
      await source.click();
      await expect(source).toHaveAttribute("aria-pressed", "true");
      await expect(search).toBeFocused();
      await expect(source.locator(".provider-brand-icon")).toHaveAttribute("data-provider-id", id);
      await expect(chooser.locator(".model-chooser-row-brand").first()).toHaveAttribute("data-provider-id", id);
      await capture(`model-chooser-${id}-${theme.toLowerCase()}`);
      // Without a viewport constraint, the frame ends with its content rather
      // than reserving a fixed-height blank area below these few model rows.
      const content = await chooser.evaluate(modelChooserContentGeometry);
      expect(content.bottomGap).toBeLessThanOrEqual(2);
      if (id === "codex") {
        await search.fill("Codex Beta");
        await expect(chooser.locator(".model-chooser-row-option")).toHaveCount(1);
        await expect.poll(async () => (await chooser.boundingBox())!.height)
          .toBeLessThan(content.frameHeight);
        await capture(`model-chooser-filtered-${theme.toLowerCase()}`);
        await search.fill("route-that-does-not-exist");
        await expect(chooser.getByText("No matching models", { exact: true })).toBeVisible();
        await expect.poll(async () => (await chooser.boundingBox())!.height)
          .toBeLessThan(content.frameHeight);
        await search.fill("");
        await expect.poll(async () => (await chooser.boundingBox())!.height)
          .toBeCloseTo(content.frameHeight, 0);
      }
    }
    await expectModelChooserVerticalFallback(app, chooser);
    await resizeWindow(720, 640);
    await capture(`model-chooser-narrow-${theme.toLowerCase()}`, "above");
    const source = chooser.getByRole("button", { name: /^Codex, \d+ models?$/u });
    await source.focus();
    await source.press("ArrowDown");
    await expect(chooser.getByRole("button", { name: /^Claude, \d+ models?$/u })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(chooser).toBeHidden();
    await expect(trigger).toBeFocused();
    const chipPath = testInfo.outputPath(`selected-model-chip-${theme.toLowerCase()}.png`);
    await page.locator(".composer").screenshot({ path: chipPath, animations: "disabled" });
    await testInfo.attach(`selected-model-chip-${theme.toLowerCase()}`, { path: chipPath, contentType: "image/png" });
  }
  expect(rendererErrors).toEqual([]);
});

// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { buildPaletteTokens, PALETTE_APPEARANCES } from "../../scripts/color-theme-spec.mjs";
import { COLOR_THEME_OPTIONS } from "../../src/renderer/src/utils/colorThemes";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

for (const appearance of PALETTE_APPEARANCES) {
  test.describe(`${appearance} palettes`, () => {
    let app: AppFixture;
    test.beforeAll(async () => {
      app = await createAppFixture({
        name: "color-palette", initialState: "conversation", seedAssistantCodeBlock: true,
      });
      await app.resizeWindow(1440, 1000);
    });
    test.afterAll(async () => { await app?.close(); });
    for (const family of COLOR_THEME_OPTIONS) {
      test(`renders ${family.label} in settings and chat`, async ({ browserName: _browserName }, info) => {
        const { page } = app;
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "General", exact: true }).click();
        await page.getByRole("radio", { name: appearance === "light" ? "Light" : "Dark", exact: true }).click();
        await page.getByRole("radio", { name: `${family.label} theme`, exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
        await expect(page.locator("html")).toHaveAttribute("data-color-theme", family.id);
        const palette = Object.fromEntries(buildPaletteTokens(family.id, appearance));
        const roles = ["app-bg", "sidebar-bg", "surface", "text", "accent", "terminal-bg"];
        await expect.poll(() => page.locator("html").evaluate((element, names) => {
          const styles = getComputedStyle(element);
          return Object.fromEntries(names.map((name) => [name, styles.getPropertyValue(`--${name}`).trim()]));
        }, roles)).toEqual(Object.fromEntries(roles.map((name) => [name, palette[name]])));
        await expect(page.getByRole("radio", { name: `${family.label} theme`, exact: true })).toHaveAttribute("aria-checked", "true");
        if (family.id === "inertia") {
          await page.locator(".theme-library").scrollIntoViewIfNeeded();
          const path = info.outputPath(`theme-library-${appearance}.png`);
          await page.screenshot({ path, animations: "disabled" });
          await info.attach(`theme-library-${appearance}`, { path, contentType: "image/png" });
        }
        await page.getByRole("button", { name: "Workspace", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
        await app.expectNoViewportOverflow();
        const path = info.outputPath(`${family.id}-${appearance}.png`);
        await page.screenshot({ path, animations: "disabled" });
        await info.attach(`${family.id}-${appearance}`, { path, contentType: "image/png" });
        expect(app.rendererErrors).toEqual([]);
      });
    }
  });
}

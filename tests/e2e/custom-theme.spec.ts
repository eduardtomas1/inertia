// @inertia-e2e-resource isolated
import { expect, test, type Page } from "@playwright/test";
import { buildCustomPaletteTokens, buildPaletteTokens } from "../../scripts/color-theme-spec.mjs";
import { createAppFixture } from "./support/app-fixture";

async function expectPalette(page: Page, color: string, mode: "light" | "dark"): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "custom");
  const palette = Object.fromEntries(buildCustomPaletteTokens(color, mode));
  const roles = ["app-bg", "sidebar-bg", "surface", "text", "accent", "terminal-bg"];
  await expect.poll(() => page.locator("html").evaluate((root, names) => {
    const styles = getComputedStyle(root);
    return names.map((name) => styles.getPropertyValue(`--${name}`).trim());
  }, roles)).toEqual(roles.map((name) => palette[name]));
}

test("selects custom colors per appearance, follows System, and restores them after restart", async ({ browserName: _browserName }, info) => {
  const app = await createAppFixture({ name: "custom-theme", initialState: "conversation", seedAssistantCodeBlock: true });
  let { page } = app;
  try {
    await app.resizeWindow(1440, 1100);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    const light = page.getByRole("textbox", { name: "Light color", exact: true });
    await light.fill("#0d9488");
    await light.press("Enter");
    await expectPalette(page, "#0d9488", "light");
    const dark = page.getByRole("textbox", { name: "Dark color", exact: true });
    await dark.fill("#f97316");
    await dark.press("Enter");
    await expectPalette(page, "#0d9488", "light");
    for (const mode of ["light", "dark"] as const) {
      await page.getByRole("radio", { name: mode === "light" ? "Light" : "Dark", exact: true }).click();
      await expectPalette(page, mode === "light" ? "#0d9488" : "#f97316", mode);
      await page.locator(".custom-theme-options").scrollIntoViewIfNeeded();
      await app.expectNoViewportOverflow();
      const path = info.outputPath(`custom-colors-${mode}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await info.attach(`Custom colors · ${mode}`, { path, contentType: "image/png" });
      await page.getByRole("button", { name: "Workspace", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
      const workspacePath = info.outputPath(`custom-workspace-${mode}.png`);
      await page.screenshot({ path: workspacePath, animations: "disabled" });
      await info.attach(`Custom workspace · ${mode}`, { path: workspacePath, contentType: "image/png" });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    }
    await page.getByRole("radio", { name: "System", exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await expectPalette(page, "#0d9488", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectPalette(page, "#f97316", "dark");
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    ({ page } = await app.restart());
    await expectPalette(page, "#f97316", "dark");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.locator(".workspace-header").getByRole("button", { name: "custom-theme fixture", exact: true }).click();
    const opened = app.electronApp.waitForEvent("window");
    await page.getByRole("menuitem", { name: "Open chat in new window" }).click();
    const popup = await opened;
    await popup.locator(".detached-chat-shell").waitFor();
    await expectPalette(popup, "#f97316", "dark");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Light color", exact: true })).toHaveValue("#0d9488");
    await expect(page.getByRole("textbox", { name: "Dark color", exact: true })).toHaveValue("#f97316");
    await page.getByRole("button", { name: "Use Ocean for dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", "ocean");
    await expect.poll(() => page.locator("html").evaluate((root) => getComputedStyle(root).getPropertyValue("--accent").trim()))
      .toBe(Object.fromEntries(buildPaletteTokens("ocean", "dark")).accent);
    await expect(popup.locator("html")).toHaveAttribute("data-color-theme", "ocean");
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    await expectPalette(page, "#0d9488", "light");
    await expectPalette(popup, "#0d9488", "light");
    await popup.close();
    await app.resizeWindow(1000, 800);
    await page.locator(".custom-theme-options").scrollIntoViewIfNeeded();
    await app.expectNoViewportOverflow();
    const narrow = info.outputPath("custom-colors-narrow.png");
    await page.screenshot({ path: narrow, animations: "disabled" });
    await info.attach("Custom colors · narrow", { path: narrow, contentType: "image/png" });
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    const path = info.outputPath("custom-theme-failure.png");
    await page.screenshot({ path, animations: "disabled" });
    await info.attach("Custom theme failure", { path, contentType: "image/png" });
    throw error;
  } finally {
    await app.close();
  }
});

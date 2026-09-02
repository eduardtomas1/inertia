import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: Page;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "theme-library",
    initialState: "conversation",
    seedAssistantCodeBlock: true,
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test("applies paired color themes and restores them after restart", async ({
  browserName: _browserName,
}, testInfo) => {
  await app.resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("radio", { name: "System", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.getByRole("radio", { name: "Iris theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "iris");
  await expect(page.getByRole("radio", { name: "Iris theme" })).toBeChecked();
  await app.expectNoViewportOverflow();

  const libraryScreenshot = testInfo.outputPath("theme-library-iris-dark.png");
  await page.screenshot({ path: libraryScreenshot, animations: "disabled" });
  await testInfo.attach("Theme library · Iris dark", {
    path: libraryScreenshot,
    contentType: "image/png",
  });

  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.getByRole("radio", { name: "Ocean theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "ocean");
  await expect.poll(() => page.locator("html").evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      background: styles.getPropertyValue("--app-bg").trim(),
      accent: styles.getPropertyValue("--accent").trim(),
    };
  })).toEqual({ background: "#edf3f6", accent: "#28698a" });
  await expect.poll(() => {
    const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    const value = (database.prepare(
      "SELECT color_theme AS colorTheme FROM app_state WHERE id = 1",
    ).get() as { colorTheme: string }).colorTheme;
    database.close();
    return value;
  }).toBe("ocean");

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const workspaceScreenshot = testInfo.outputPath("workspace-ocean-light.png");
  await page.screenshot({ path: workspaceScreenshot, animations: "disabled" });
  await testInfo.attach("Workspace · Ocean light", {
    path: workspaceScreenshot,
    contentType: "image/png",
  });

  ({ page } = await app.restart());
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "ocean");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Ocean theme" })).toBeChecked();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  expect(app.rendererErrors).toEqual([]);
});

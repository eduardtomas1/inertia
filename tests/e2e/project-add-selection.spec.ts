// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createAppFixture } from "./support/app-fixture";
import { openLocalProjectFromDialog } from "./support/add-project";

test("selects a newly added project as the sidebar scope and active workspace", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "project-add-selection", initialState: "conversation", seedSecondProject: true });
  try {
    await app.resizeWindow(1200, 800);
    const page = app.page;
    const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
    const filter = sidebar.getByRole("button", { name: "Filter work by project" });
    await filter.click();
    await page.getByRole("dialog", { name: "Choose project filter" }).getByRole("option", { name: "Inertia", exact: true }).click();
    await expect(filter).toHaveText("Inertia");
    await expect(page.getByText(/Checking/u)).toHaveCount(0);
    const beforeScreenshot = testInfo.outputPath("before-add-project.png");
    await page.screenshot({ path: beforeScreenshot });
    await testInfo.attach("before-add-project", { path: beforeScreenshot, contentType: "image/png" });

    const addedPath = join(app.testDirectory, "Launchpad");
    await mkdir(addedPath);
    await app.electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
    }, addedPath);
    await sidebar.getByRole("button", { name: "Add project", exact: true }).click();
    await openLocalProjectFromDialog(page);

    await expect(page.getByRole("heading", { name: "What should we build in Launchpad?" })).toBeVisible();
    await expect(page.locator(".dialog-presence")).toHaveCount(0);
    await expect(page.getByText(/Checking/u)).toHaveCount(0);
    const afterScreenshot = testInfo.outputPath("after-add-project.png");
    await page.screenshot({ path: afterScreenshot });
    await testInfo.attach("after-add-project", { path: afterScreenshot, contentType: "image/png" });
    await expect(filter).toHaveText("Launchpad");
    await expect(sidebar.getByRole("list", { name: "Work" }).getByRole("button", { name: /Inertia/u })).toHaveCount(0);

    const toggleNavigation = page.getByRole("button", { name: "Toggle project navigation" });
    await toggleNavigation.click();
    await expect(sidebar).toHaveCount(0);
    const collapsedPath = join(app.testDirectory, "Orbit");
    await mkdir(collapsedPath);
    await app.electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
    }, collapsedPath);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await page.getByRole("dialog", { name: "Search Inertia" }).locator('[id="palette-action:add-project"]').click();
    await openLocalProjectFromDialog(page);
    await expect(page.getByRole("heading", { name: "What should we build in Orbit?" })).toBeVisible();
    await toggleNavigation.click();
    await expect(filter).toHaveText("Orbit");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

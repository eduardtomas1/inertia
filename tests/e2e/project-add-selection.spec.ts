// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createAppFixture } from "./support/app-fixture";
import { openLocalProjectFromDialog } from "./support/add-project";

function activeChatProject(testDirectory: string): string | null {
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare(`
      SELECT projects.name AS name FROM app_state
      JOIN conversations ON conversations.id = app_state.active_conversation_id
      JOIN projects ON projects.id = conversations.project_id
      WHERE app_state.id = 1 AND app_state.active_project_id = projects.id
    `).get() as { name: string } | undefined;
    return row?.name ?? null;
  } finally { database.close(); }
}

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
    await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
    await expect.poll(() => activeChatProject(app.testDirectory)).toBe("Launchpad");

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
    await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
    await expect.poll(() => activeChatProject(app.testDirectory)).toBe("Orbit");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

test("keeps the chosen project scope after a cancelled or failed import", async () => {
  const app = await createAppFixture({ name: "project-add-failure-selection", initialState: "conversation", seedSecondProject: true });
  try {
    await app.resizeWindow(1200, 800);
    const page = app.page;
    const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
    const filter = sidebar.getByRole("button", { name: "Filter work by project" });
    await filter.click();
    await page.getByRole("dialog", { name: "Choose project filter" }).getByRole("option", { name: "Companion", exact: true }).click();
    await expect(filter).toHaveText("Companion");

    await app.electronApp.evaluate(({ dialog }) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: true, filePaths: [], bookmarks: [] }));
    });
    await sidebar.getByRole("button", { name: "Add project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
    await dialog.getByRole("button", { name: /Local folder/u }).click();
    await dialog.getByRole("button", { name: "Browse", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Open project", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close add project" }).click();
    await expect(page.locator(".add-project-dialog")).toHaveCount(0);
    await expect(filter).toHaveText("Companion");

    await sidebar.getByRole("button", { name: "Add project", exact: true }).click();
    await dialog.getByRole("button", { name: /Local folder/u }).click();
    await dialog.getByRole("textbox", { name: "Folder path" }).fill(app.attachmentImagePath);
    await dialog.getByRole("button", { name: "Open project", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Project path must be an existing directory.");
    await dialog.getByRole("button", { name: "Close add project" }).click();
    await expect(page.locator(".add-project-dialog")).toHaveCount(0);
    await expect(filter).toHaveText("Companion");
    await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
    await expect.poll(() => activeChatProject(app.testDirectory)).toBe("Companion");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

test("keeps the search placeholder and typed text clear of the focus frame", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "project-add-search-inset", initialState: "conversation" });
  try {
    await app.resizeWindow(1200, 800);
    const page = app.page;
    await page.getByRole("complementary", { name: "Project navigation", exact: true })
      .getByRole("button", { name: "Add project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
    const search = dialog.getByRole("textbox", { name: "Search project sources" });
    await expect(search).toBeFocused();
    const icon = dialog.locator(".add-project-search > svg");
    await expect(icon).toBeVisible();
    // Compare both text origins after the dialog's entry scale has finished.
    await expect.poll(() => dialog.evaluate((element) =>
      element.getAnimations().every((animation) => animation.playState === "finished"),
    )).toBe(true);
    // The focus ring is the frame the placeholder used to touch, so measure the
    // painted text origin against the ring the renderer actually resolved.
    const measure = async (): Promise<{
      outlineStyle: string;
      frameLeft: number;
      frameRight: number;
      textLeft: number;
      textRight: number;
    }> => await search.evaluate((element) => {
      const styles = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const ring = Number.parseFloat(styles.outlineWidth)
        + Number.parseFloat(styles.outlineOffset);
      return {
        outlineStyle: styles.outlineStyle,
        frameLeft: box.left - ring,
        frameRight: box.right + ring,
        textLeft: box.left
          + Number.parseFloat(styles.borderLeftWidth)
          + Number.parseFloat(styles.paddingLeft),
        textRight: box.right
          - Number.parseFloat(styles.borderRightWidth)
          - Number.parseFloat(styles.paddingRight),
      };
    });

    const placeholder = await measure();
    expect(placeholder.outlineStyle).not.toBe("none");
    expect(placeholder.textLeft - placeholder.frameLeft).toBeGreaterThanOrEqual(10);
    expect(placeholder.frameRight - placeholder.textRight).toBeGreaterThanOrEqual(10);
    const iconBox = await icon.boundingBox();
    if (!iconBox) throw new Error("Expected the search icon to be laid out.");
    expect(placeholder.textLeft).toBeGreaterThan(iconBox.x + iconBox.width);
    expect(placeholder.frameLeft).toBeGreaterThan(iconBox.x + iconBox.width);

    await search.fill("clone");
    await expect(dialog.getByRole("button", { name: /Clone repository/u })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Local folder/u })).toHaveCount(0);
    const typed = await measure();
    expect(Math.abs(typed.textLeft - placeholder.textLeft)).toBeLessThan(1);
    expect(typed.textLeft - typed.frameLeft).toBeGreaterThanOrEqual(10);
    const inset = testInfo.outputPath("add-project-search-inset.png");
    await dialog.screenshot({ path: inset });
    await testInfo.attach("add-project-search-inset", { path: inset, contentType: "image/png" });
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

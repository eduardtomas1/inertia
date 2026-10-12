// @inertia-e2e-resource primary-display
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { adaptProjectColor } from "../../src/shared/project-color-contrast";
import { PROJECT_COLOR_PALETTE } from "../../src/shared/project-colors";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
let projectId: string;

function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

async function color(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).color);
}

function projectRows(page: Page, name: string): Locator {
  return page.locator(".activity-thread-projectline").filter({ has: page.locator(".activity-thread-project-meta", { hasText: new RegExp(`^${name}$`, "u") }) });
}

function storedPreferences() {
  const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
  try { return store.project(projectId).preferences; } finally { store.close(); }
}

test.beforeAll(async () => {
  app = await createAppFixture({ name: "project-colours", initialState: "conversation", seedSecondProject: true, windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory, secondWorkspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const state = store.shellSnapshot();
        const project = state.projects.find(({ path }) => path === workspaceDirectory)!;
        const other = state.projects.find(({ path }) => path === secondWorkspaceDirectory)!;
        projectId = project.id;
        store.updateProject(project.id, { name: "Munich - Etendo" });
        store.updateProject(other.id, { name: "Atlas billing" });
        store.createConversation(project.id, "40183 - Massive Edits", { activate: false });
        store.selectConversation(state.activeConversationId!);
        store.updateSettings({ theme: "dark" });
      } finally { store.close(); }
    } });
});
test.afterAll(async () => { await app?.close(); });

test("colours a project from the filter menu, updates every surface and window live, and keeps it after restart", async () => {
  test.setTimeout(90_000);
  const page = app.page;
  const rows = projectRows(page, "Munich - Etendo");
  const otherRows = projectRows(page, "Atlas billing");
  await expect(rows).toHaveCount(2);
  const untintedName = await color(otherRows.first().locator(".activity-thread-project-meta"));

  await page.locator(".workspace-header .header-title-button").click();
  const opened = app.electronApp.waitForEvent("window");
  await page.getByRole("menuitem", { name: "Open chat in new window" }).click();
  const popup = await opened;
  await expect(popup.locator(".detached-chat-shell")).toBeVisible();
  await expect(popup.locator(".detached-chat-project")).toContainText("Munich - Etendo");

  const trigger = page.getByRole("button", { name: "Filter work by project" });
  await trigger.click();
  await page.getByRole("button", { name: "Customise Munich - Etendo" }).click();
  const panel = page.getByRole("dialog", { name: "Customise Munich - Etendo" });
  const colours = panel.getByRole("radiogroup", { name: "Project colour" });
  await expect(colours.getByRole("radio", { name: "Default" })).toBeFocused();
  await colours.getByRole("radio", { name: "Teal" }).click();
  await expect(rows.first().locator("svg.project-icon-symbol")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.teal.dark));
  await expect(rows.nth(1).locator("svg.project-icon-symbol")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.teal.dark));
  expect(await color(rows.first().locator(".activity-thread-project-meta"))).toBe(untintedName);
  await page.keyboard.press("ArrowRight");
  await expect(colours.getByRole("radio", { name: "Blue" })).toBeFocused();
  await expect(rows.first().locator("svg.project-icon-symbol")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));
  await panel.getByRole("radio", { name: "Icon and name" }).click();
  for (const row of [rows.first(), rows.nth(1)]) {
    await expect(row.locator(".activity-thread-project-meta")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));
  }
  expect(await color(otherRows.first().locator(".activity-thread-project-meta"))).toBe(untintedName);
  await expect(page.locator(".header-breadcrumb-project .project-name-tinted")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));
  await expect(popup.locator(".detached-chat-project .project-name-tinted")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));
  await expect(popup.locator(".detached-chat-project svg")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Customise Munich - Etendo" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(storedPreferences()).toMatchObject({ color: { kind: "palette", name: "blue" }, colorEmphasis: "icon-and-name" });

  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await expect(rows.first().locator(".activity-thread-project-meta")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.light));
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

  await trigger.click();
  await page.getByRole("option", { name: "Munich - Etendo" }).click();
  await expect(trigger.locator(".project-name-tinted")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));
  await expect(otherRows).toHaveCount(0);
  await trigger.click();
  await page.getByRole("option", { name: "All projects" }).click();

  await app.restart();
  const restarted = app.page;
  const restartedRows = projectRows(restarted, "Munich - Etendo");
  await expect(restartedRows).toHaveCount(2);
  await expect(restartedRows.first().locator(".activity-thread-project-meta")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));
  await expect(restarted.locator(".header-breadcrumb-project svg")).toHaveCSS("color", rgb(PROJECT_COLOR_PALETTE.blue.dark));
  expect(app.rendererErrors).toEqual([]);
});

test("pins a project to the top of the filter and applies a typed custom colour", async () => {
  const page = app.page;
  await page.getByRole("button", { name: "Filter work by project" }).click();
  await page.getByRole("button", { name: "Customise Atlas billing" }).click();
  const panel = page.getByRole("dialog", { name: "Customise Atlas billing" });
  const hex = panel.getByRole("textbox", { name: "Custom colour hex value" });
  await hex.fill("#ff7a00");
  await hex.press("Enter");
  await expect(panel.getByRole("radio", { name: "Custom #ff7a00" })).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("switch", { name: "Pin to top of project lists" }).click();
  await expect(panel.getByRole("switch", { name: "Pin to top of project lists" })).toHaveAttribute("aria-checked", "true");
  await expect(projectRows(page, "Atlas billing").first().locator("svg.project-icon-symbol")).toHaveCSS("color", rgb(adaptProjectColor("#ff7a00", "dark")));
  await panel.getByRole("button", { name: "Back to projects" }).click();
  await expect(page.getByRole("option").nth(1)).toHaveAccessibleName("Atlas billing, pinned");
  await page.keyboard.press("Escape");
  expect(app.rendererErrors).toEqual([]);
});

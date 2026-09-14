// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { selectWorkspaceTool } from "./support/workspace-tools";

let app!: AppFixture;
let page!: AppFixture["page"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "palette", initialState: "conversation" });
  page = app.page;
  rendererErrors = app.rendererErrors;
  resizeWindow = app.resizeWindow;
});

test.afterAll(async () => {
  await app.close();
});

test("opens the command palette and manages a thread", async () => {
  await resizeWindow(1440, 920);
  const initialThreadCount = await page.locator(".activity-thread").count();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Search Inertia" })).toBeVisible();
  await page.getByRole("dialog", { name: "Search Inertia" })
    .getByRole("option")
    .filter({ hasText: "Start work in the current project" })
    .click();
  await expect(page.locator(".activity-thread")).toHaveCount(initialThreadCount + 1);
  await expect(page.locator(".activity-thread.is-active .activity-thread-select")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();

  await page.locator(".activity-thread.is-active")
    .getByRole("button", { name: /^New chat,/u })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename thread" }).click();
  const rename = page.getByRole("textbox", { name: "Rename New chat" });
  await rename.fill("Focused V1 pass");
  await rename.press("Enter");
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /^Focused V1 pass,/u }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive thread" }).click();
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Focused V1 pass,/u })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Terminal");
  const terminalInput = page.locator(".xterm-helper-textarea").first();
  await terminalInput.focus();
  await page.keyboard.press("Control+K");
  await expect(terminalInput).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Search Inertia" })).toHaveCount(0);
  if (process.platform !== "darwin") {
    await page.getByRole("textbox", { name: "Message", exact: true }).focus();
  }
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const search = page.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
  await expect(search).toBeFocused();
  await search.pressSequentially("settings");
  await expect(search).toHaveValue("settings");
  const settingsOption = page.getByRole("option", { name: /Open settings/ });
  await expect(settingsOption).toHaveAttribute("aria-selected", "true");
  if (process.platform === "win32") await settingsOption.click();
  else await search.press("Enter");
  await expect(page.getByRole("button", { name: "General", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  expect(rendererErrors).toEqual([]);
});

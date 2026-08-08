import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

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
  const initialThreadCount = await page.locator(".conversation-item").count();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Search Inertia" })).toBeVisible();
  await page.getByRole("dialog", { name: "Search Inertia" })
    .getByRole("option")
    .filter({ hasText: "Start work in the current project" })
    .click();
  await expect(page.locator(".conversation-item")).toHaveCount(initialThreadCount + 1);
  await expect(page.locator(".conversation-row.is-active")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();

  await page.locator(".conversation-item").filter({ has: page.locator(".conversation-row.is-active") })
    .getByRole("button", { name: "Thread actions for New chat" })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("textbox", { name: "Rename New chat" });
  await rename.fill("Focused V1 pass");
  await rename.press("Enter");
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Thread actions for Focused V1 pass" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thread actions for Focused V1 pass" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  const terminalInput = page.locator(".xterm-helper-textarea").first();
  await terminalInput.focus();
  await page.keyboard.press("Control+K");
  const search = page.getByRole("combobox", { name: "Search commands, projects, and threads" });
  await expect(search).toBeFocused();
  await search.pressSequentially("settings");
  await expect(search).toHaveValue("settings");
  const settingsOption = page.getByRole("option", { name: /Open settings/ });
  await expect(settingsOption).toHaveAttribute("aria-selected", "true");
  if (process.platform === "win32") await settingsOption.click();
  else await search.press("Enter");
  await expect(page.getByRole("button", { name: "General", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

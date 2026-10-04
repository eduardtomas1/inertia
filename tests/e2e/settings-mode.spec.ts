// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];
let rendererErrors!: AppFixture["rendererErrors"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "settings-mode", initialState: "conversation" });
  page = app.page;
  rendererErrors = app.rendererErrors;
});

test.afterAll(async () => {
  await app.close();
});

test("leaves Settings with Escape, reopens at the last section and keeps typed text", async () => {
  const settings = page.getByRole("main", { name: "Settings" });
  const sidebarSettings = page.getByRole("complementary", { name: "Project navigation" })
    .getByRole("button", { name: "Settings", exact: true });
  await sidebarSettings.focus();
  await sidebarSettings.press("Enter");
  await expect(settings).toBeVisible();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Devices & integrations", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Devices & integrations" })).toBeFocused();
  const repository = page.getByRole("textbox", { name: "Discord release repository URL" });
  await repository.pressSequentially("not a url");
  await expect(repository).toHaveValue("not a url");
  await repository.press("Escape");
  await expect(repository).toHaveValue("");
  await expect(settings).toBeVisible();

  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Keyboard", exact: true }).click();
  await expect(page.getByText("Toggle project navigation", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(sidebarSettings).toBeFocused();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await expect(settings).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Keyboard", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("finds a setting with Settings search, lands on its row and keeps the search above the narrow section strip", async () => {
  await app.resizeWindow(1440, 920);
  const settings = page.getByRole("main", { name: "Settings" });
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await expect(settings).toBeVisible();
  const field = page.getByRole("combobox", { name: "Search settings" });
  await field.click();
  await field.pressSequentially("ignore white");
  const results = page.getByRole("listbox", { name: "Matching settings" });
  await expect(results.getByRole("option", { name: "Ignore whitespace" })).toHaveAttribute("aria-selected", "true");
  await expect(sections).toHaveCount(0);
  await field.press("Enter");
  await expect(page.getByRole("switch", { name: "Ignore whitespace" })).toBeFocused();
  await expect(sections.getByRole("button", { name: "Chats", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(field).toHaveValue("");

  await field.click();
  await field.pressSequentially("zzzz");
  await expect(page.getByText("No settings match", { exact: true })).toBeVisible();
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(settings).toBeVisible();

  await app.resizeWindow(860, 700);
  const fieldBox = await field.boundingBox();
  const sectionsBox = await sections.boundingBox();
  expect(fieldBox && sectionsBox && fieldBox.y + fieldBox.height <= sectionsBox.y).toBe(true);
  await field.pressSequentially("theme");
  await expect(sections).toHaveCount(0);
  const resultsBox = await results.boundingBox();
  expect(fieldBox && resultsBox && resultsBox.y >= fieldBox.y + fieldBox.height).toBe(true);
  await field.press("Escape");
  await expect(sections).toBeVisible();
  await field.press("Escape");
  await expect(settings).toBeHidden();
  await app.resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

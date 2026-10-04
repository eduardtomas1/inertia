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

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

test("leaves Settings with Escape after reverting an unsaved field first and reopens at the last section", async () => {
  const settings = page.getByRole("main", { name: "Settings" });
  const sidebarSettings = page.getByRole("complementary", { name: "Project navigation" })
    .getByRole("button", { name: "Settings", exact: true });
  await sidebarSettings.focus();
  await sidebarSettings.press("Enter");
  await expect(settings).toBeVisible();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Devices & integrations", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Devices & integrations" })).toBeFocused();
  const repository = page.getByRole("textbox", { name: "Repository URL" });
  await repository.pressSequentially("not a url");
  await expect(repository).toHaveValue("not a url");
  await repository.press("Escape");
  await expect(repository).toHaveValue("");
  await expect(settings).toBeVisible();

  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Keyboard", exact: true }).click();
  await expect(page.getByText("Toggle project navigation", { exact: true })).toBeVisible();
  const keySelect = page.getByRole("combobox", { name: "Search everything key" });
  const pickerOpen = (): Promise<boolean> => keySelect.evaluate((element) => element.matches(":open"));
  expect(await keySelect.evaluate((element) => getComputedStyle(element, "::picker-icon").maskImage)).toContain("m6 9 6 6 6-6");
  await keySelect.click();
  await expect.poll(pickerOpen).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(pickerOpen).toBe(false);
  await expect(settings).toBeVisible();
  await expect(keySelect).toBeFocused();
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

test("keeps an action row's height when its notice appears", async () => {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Data", exact: true }).click();
  const recoveryRow = page.locator('[data-setting-id="recovery-export"]');
  await expect(page.locator(".settings-view [aria-busy='true']")).toHaveCount(0);
  await expect(page.locator('[data-setting-id="attachment-storage"] .data-facts')).toContainText(" used · ");
  const rowHeight = (): Promise<number> => recoveryRow.evaluate((element) => element.getBoundingClientRect().height);
  const idleHeight = await rowHeight();
  await app.electronApp.evaluate(({ dialog }) => {
    Reflect.set(globalThis, "__restoreShowSaveDialog", dialog.showSaveDialog);
    Reflect.set(dialog, "showSaveDialog", async () => ({ canceled: true }));
  });
  try {
    await recoveryRow.getByRole("button", { name: "Export recovery file" }).click();
    await expect(recoveryRow.getByText("Recovery export cancelled.", { exact: true })).toBeVisible();
    expect(await rowHeight()).toBe(idleHeight);
  } finally {
    await app.electronApp.evaluate(({ dialog }) => {
      Reflect.set(dialog, "showSaveDialog", Reflect.get(globalThis, "__restoreShowSaveDialog"));
      Reflect.deleteProperty(globalThis, "__restoreShowSaveDialog");
    });
  }
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  expect(rendererErrors).toEqual([]);
});

test("keeps a switch row's size and control position at 760 × 600 after Saved and after an error", async () => {
  await app.resizeWindow(760, 600);
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await sections.getByRole("button", { name: "Chats", exact: true }).click();
  const geometry = (id: string) => page.locator(`[data-setting-id="${id}"]`).evaluate((element) => {
    const row = element.getBoundingClientRect();
    const control = element.querySelector('[role="switch"]')!.getBoundingClientRect();
    return {
      height: Math.round(row.height), width: Math.round(row.width),
      controlX: Math.round(control.x - row.x), controlY: Math.round(control.y - row.y),
    };
  });
  const timestamps = page.locator('[data-setting-id="message-timestamps"]');
  await timestamps.scrollIntoViewIfNeeded();
  const idle = await geometry("message-timestamps");
  await timestamps.getByRole("switch").click();
  await expect(timestamps.getByText("Saved", { exact: true })).toBeVisible();
  expect(await geometry("message-timestamps")).toEqual(idle);
  await timestamps.getByRole("switch").click();
  await expect(timestamps.getByText("Saved", { exact: true })).toBeVisible();

  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("inertia:mascot-configure");
    ipcMain.handle("inertia:mascot-configure", async () => { throw new Error("fixture mascot failure"); });
  });
  await sections.getByRole("button", { name: "Notifications", exact: true }).click();
  const mascot = page.locator('[data-setting-id="desktop-mascot"]');
  await mascot.scrollIntoViewIfNeeded();
  const mascotIdle = await geometry("desktop-mascot");
  await mascot.getByRole("switch", { name: "Show mascot" }).click();
  await expect(mascot.getByRole("alert")).toHaveText("Could not update the mascot. Try again.");
  expect(await geometry("desktop-mascot")).toEqual(mascotIdle);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await app.resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

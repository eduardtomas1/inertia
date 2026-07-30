import { expect, test } from "@playwright/test";

import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "multi-spawn",
    initialState: "conversation",
    seedSecondProject: true,
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test("launches two truthful routes into a cross-project split", async (
  { browserName: _browserName },
  testInfo,
) => {
  await app.resizeWindow(1320, 900);
  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
  await sidebar.getByRole("button", { name: "Launch two chats" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Launch a duo",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Ready", { exact: true })).toHaveCount(2);
  await dialog.getByRole("textbox", { name: "Shared prompt" })
    .fill("Compare the lifecycle and propose the safest implementation.");
  await dialog.getByRole("textbox", { name: "Chat 1 name" })
    .fill("Lifecycle review");
  await dialog.getByRole("textbox", { name: "Chat 2 name" })
    .fill("Independent review");
  await dialog.getByRole("combobox", { name: "Chat 2 project" })
    .selectOption({ label: "Companion" });
  await dialog.getByRole("combobox", { name: "Chat 2 access" })
    .selectOption("full");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  });
  const lightWide = testInfo.outputPath("multi-spawn-light-wide.png");
  await page.screenshot({
    animations: "disabled",
    path: lightWide,
    scale: "device",
  });
  await testInfo.attach("multi-spawn-light-wide", {
    path: lightWide,
    contentType: "image/png",
  });

  await app.resizeWindow(720, 840);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await expect(dialog.getByRole("button", { name: "Launch duo" }))
    .toBeVisible();
  await app.expectNoViewportOverflow();
  const darkNarrow = testInfo.outputPath("multi-spawn-dark-narrow.png");
  await page.screenshot({
    animations: "disabled",
    path: darkNarrow,
    scale: "device",
  });
  await testInfo.attach("multi-spawn-dark-narrow", {
    path: darkNarrow,
    contentType: "image/png",
  });

  await app.resizeWindow(1320, 900);
  await dialog.getByRole("button", { name: "Launch duo" }).click();

  const split = page.getByRole("main", {
    name: "Split conversation workspace",
  });
  await expect(split).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", {
    name: "Primary chat: Inertia · Lifecycle review",
  })).toBeVisible();
  await expect(page.getByRole("region", {
    name: "Second chat: Companion · Independent review",
  })).toBeVisible();
  await expect(
    split.getByText(
      "Compare the lifecycle and propose the safest implementation.",
      { exact: true },
    ),
  ).toHaveCount(2);
  await expect(
    sidebar.locator("button.conversation-row")
      .filter({ hasText: "Lifecycle review" }),
  ).toBeVisible();
  await sidebar.getByRole("button", { name: "Expand Companion" }).click();
  await expect(
    sidebar.locator("button.conversation-row")
      .filter({ hasText: "Independent review" }),
  ).toBeVisible();
  await app.expectNoViewportOverflow();

  const splitResult = testInfo.outputPath("multi-spawn-split-result.png");
  await page.screenshot({
    animations: "disabled",
    path: splitResult,
    scale: "device",
  });
  await testInfo.attach("multi-spawn-split-result", {
    path: splitResult,
    contentType: "image/png",
  });
  expect(app.rendererErrors).toEqual([]);
});

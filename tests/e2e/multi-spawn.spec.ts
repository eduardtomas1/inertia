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

test("launches two truthful routes and locks a bounded third-model judge", async (
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
  await dialog.getByRole("checkbox", { name: "Compare with a third model" })
    .check();
  const judgeConfiguration = dialog.locator(".multi-spawn-judge-config");
  await expect(judgeConfiguration).not.toHaveAttribute("open", "");
  await judgeConfiguration.getByText("Configure judge", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comparison chat name" })
    .fill("Independent judge");
  await dialog.getByRole("combobox", { name: "Comparison chat project" })
    .selectOption({ label: "Companion" });
  await dialog.getByRole("combobox", { name: "Comparison chat access" })
    .selectOption("full");
  await expect(judgeConfiguration).toHaveAttribute("open", "");
  await expect(dialog.getByRole("textbox", { name: "Comparison chat name" }))
    .toBeVisible();
  const sharingDisclosure = dialog.getByText(
    "What is shared with the judge?",
    { exact: true },
  );
  await expect(sharingDisclosure)
    .toBeVisible();
  await expect(dialog.getByText(/It sends no source session/u))
    .not.toBeVisible();
  await sharingDisclosure.click();
  await expect(dialog.getByText(/It sends no source session/u)).toBeVisible();
  await sharingDisclosure.click();
  await expect(dialog.getByText("Judge can edit a source checkout", { exact: true }))
    .toBeVisible();
  await judgeConfiguration.getByText("Configure judge", { exact: true }).click();
  await expect(judgeConfiguration).not.toHaveAttribute("open", "");

  const wideDialogBounds = await dialog.boundingBox();
  expect(wideDialogBounds).not.toBeNull();
  expect(wideDialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(wideDialogBounds!.y + wideDialogBounds!.height)
    .toBeLessThanOrEqual(900);

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
  await judgeConfiguration.getByText("Configure judge", { exact: true }).click();
  await judgeConfiguration.scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "Launch duo" }))
    .toBeVisible();
  const routeCards = dialog.locator(".multi-spawn-sides > .multi-spawn-side");
  const routeCardBounds = await routeCards.evaluateAll((cards) => cards.map((card) => {
    const bounds = card.getBoundingClientRect();
    return { left: bounds.left, top: bounds.top, right: bounds.right };
  }));
  expect(routeCardBounds).toHaveLength(2);
  expect(Math.abs(routeCardBounds[0].top - routeCardBounds[1].top))
    .toBeLessThanOrEqual(1);
  expect(routeCardBounds[0].right).toBeLessThan(routeCardBounds[1].left);
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
    sidebar.locator("button.activity-thread-select")
      .filter({ hasText: "Lifecycle review" }),
  ).toBeVisible();
  await expect(
    sidebar.locator("button.activity-thread-select")
      .filter({ hasText: "Independent review" }),
  ).toBeVisible();
  await expect(
    sidebar.locator("button.activity-thread-select")
      .filter({ hasText: "Independent judge" }),
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

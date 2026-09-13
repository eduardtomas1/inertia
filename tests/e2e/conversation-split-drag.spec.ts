// @inertia-e2e-resource isolated
import { expect, test, type Locator } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "conversation-split-drag",
    initialState: "conversation",
    seedSecondProject: true,
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

test("drags chats into split view and rearranges them by edge", async () => {
  await app.resizeWindow(1440, 920);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() =>
    window.matchMedia("(max-width: 860px)").matches)).toBe(false);

  const secondaryTitle = "conversation-split-drag companion";
  const workspace = page.locator("#workspace-content");
  const row = page.getByRole("complementary", { name: "Project navigation" })
    .locator(".activity-thread-select")
    .filter({ hasText: secondaryTitle });
  const highlight = page.locator(".split-drop-highlight");
  const split = page.getByRole("main", { name: "Split conversation workspace" });
  const primaryPane = page.locator("#primary-conversation-pane");
  const secondaryPane = page.locator("#secondary-conversation-pane");
  const box = async (locator: Locator) => {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error("Expected a visible element.");
    return bounds;
  };
  const dragFrom = async (source: Locator, x: number, y: number) => {
    const start = await box(source);
    const startX = start.x + start.width / 2;
    const startY = start.y + start.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 24, startY, { steps: 4 });
    await page.mouse.move(x, y, { steps: 12 });
  };

  const area = await box(workspace);
  await dragFrom(row, area.x + area.width * 0.08, area.y + area.height / 2);
  await expect(highlight).toHaveAttribute("data-split-drop-zone", "left");
  await expect(page.locator(".chat-drag-chip")).toHaveText(secondaryTitle);
  await page.mouse.up();

  await expect(split).toBeVisible();
  await expect(highlight).toHaveCount(0);
  await expect(page.locator(".chat-drag-chip")).toHaveCount(0);
  await expect(split).not.toHaveClass(/is-stacked/u);
  expect((await box(secondaryPane)).x).toBeLessThan((await box(primaryPane)).x);

  await dragFrom(
    secondaryPane.locator(".conversation-split-header strong"),
    area.x + area.width / 2,
    area.y + area.height * 0.92,
  );
  await expect(highlight).toHaveAttribute("data-split-drop-zone", "bottom");
  await page.mouse.up();

  await expect(split).toHaveClass(/is-stacked/u);
  await expect(page.getByRole("separator", { name: "Resize split chats" }))
    .toHaveAttribute("aria-orientation", "horizontal");
  expect((await box(secondaryPane)).y).toBeGreaterThan((await box(primaryPane)).y);

  await dragFrom(row, area.x + area.width * 0.08, area.y + area.height / 2);
  await expect(highlight).toHaveAttribute("data-split-drop-zone", "left");
  await page.keyboard.press("Escape");
  await expect(highlight).toHaveCount(0);
  await page.mouse.up();
  await expect(split).toHaveClass(/is-stacked/u);

  await page.getByRole("button", { name: "Place split chats side by side" }).click();
  await expect(split).not.toHaveClass(/is-stacked/u);
  expect((await box(secondaryPane)).x).toBeGreaterThan((await box(primaryPane)).x);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem(
    "inertia:layout:conversation-split-orientation:v1",
  ))).toBe("columns");

  await secondaryPane.getByRole("button", {
    name: `Close split chat ${secondaryTitle}`,
  }).click();
  await expect(split).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

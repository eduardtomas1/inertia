// @inertia-e2e-resource isolated
import { expect, test, type Locator } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];

const primaryTitle = "conversation-split-drag fixture";
const secondaryTitle = "conversation-split-drag companion";
const thirdTitle = "conversation-split-drag third";
const fourthTitle = "conversation-split-drag fourth";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "conversation-split-drag",
    initialState: "conversation",
    seedSecondProject: true,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const primary = store.snapshot().conversations
        .find(({ title }) => title === primaryTitle);
      if (!primary) throw new Error("Expected the seeded primary chat.");
      store.createConversation(primary.projectId, thirdTitle);
      store.createConversation(primary.projectId, fourthTitle);
      store.selectConversation(primary.id);
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

test("drags chats into split view, rearranges them and grows to four panes", async () => {
  await app.resizeWindow(1440, 920);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() =>
    window.matchMedia("(max-width: 860px)").matches)).toBe(false);

  const workspace = page.locator("#workspace-content");
  const sidebar = page.getByRole("complementary", { name: "Project navigation" });
  const row = (title: string) => sidebar
    .locator(".activity-thread-select")
    .filter({ hasText: title });
  const highlight = page.locator(".split-drop-highlight");
  const split = page.getByRole("main", { name: "Split conversation workspace" });
  const panes = page.locator(".conversation-split-pane");
  const primaryPane = page.locator("#primary-conversation-pane");
  const secondaryPane = page.locator("#secondary-conversation-pane");
  const tertiaryPane = page.locator("#tertiary-conversation-pane");
  const quaternaryPane = page.locator("#quaternary-conversation-pane");
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
  await dragFrom(row(secondaryTitle), area.x + area.width * 0.08, area.y + area.height / 2);
  await expect(highlight).toHaveAttribute("data-split-drop-zone", "left");
  await expect(page.locator(".chat-drag-chip")).toHaveText(secondaryTitle);
  await page.mouse.up();

  await expect(split).toBeVisible();
  await expect(highlight).toHaveCount(0);
  await expect(page.locator(".chat-drag-chip")).toHaveCount(0);
  await expect(split).not.toHaveClass(/is-stacked/u);
  expect((await box(secondaryPane)).x).toBeLessThan((await box(primaryPane)).x);

  const primaryBounds = await box(primaryPane);
  await dragFrom(
    secondaryPane.locator(".conversation-split-header strong"),
    primaryBounds.x + primaryBounds.width / 2,
    primaryBounds.y + primaryBounds.height * 0.92,
  );
  await expect(highlight).toHaveAttribute("data-split-drop-zone", "bottom");
  await expect(highlight).toHaveAttribute("data-split-drop-action", "move");
  await page.mouse.up();

  await expect(split).toHaveClass(/is-stacked/u);
  await expect(page.getByRole("separator", { name: "Resize split chats" }))
    .toHaveAttribute("aria-orientation", "horizontal");
  expect((await box(secondaryPane)).y).toBeGreaterThan((await box(primaryPane)).y);

  const topBounds = await box(primaryPane);
  await dragFrom(
    row(secondaryTitle),
    topBounds.x + topBounds.width * 0.05,
    topBounds.y + topBounds.height / 2,
  );
  await expect(highlight).toHaveAttribute("data-split-drop-zone", "left");
  await page.keyboard.press("Escape");
  await expect(highlight).toHaveCount(0);
  await page.mouse.up();
  await expect(split).toHaveClass(/is-stacked/u);
  expect((await box(secondaryPane)).y).toBeGreaterThan((await box(primaryPane)).y);

  await page.getByRole("button", { name: "Place split chats side by side" }).click();
  await expect(split).not.toHaveClass(/is-stacked/u);
  expect((await box(secondaryPane)).x).toBeGreaterThan((await box(primaryPane)).x);
  await expect.poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem(
    "inertia:layout:conversation-split-layout:v1",
  ) ?? "{}").axis)).toBe("columns");

  const secondaryBounds = await box(secondaryPane);
  await dragFrom(
    row(thirdTitle),
    secondaryBounds.x + secondaryBounds.width / 2,
    secondaryBounds.y + secondaryBounds.height * 0.9,
  );
  await expect(highlight).toHaveAttribute("data-split-drop-action", "insert");
  await expect(highlight).toHaveAttribute("data-split-drop-zone", "bottom");
  await page.mouse.up();

  await expect(panes).toHaveCount(3);
  await expect(page.getByRole("region", { name: `Third chat: Inertia · ${thirdTitle}` }))
    .toBeVisible();
  const thirdBounds = await box(tertiaryPane);
  expect(thirdBounds.y).toBeGreaterThan((await box(secondaryPane)).y);
  expect(Math.abs(thirdBounds.x - (await box(secondaryPane)).x)).toBeLessThan(2);

  await row(fourthTitle).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add this chat to split view" }).click();

  await expect(panes).toHaveCount(4);
  await expect(page.getByRole("region", { name: `Second chat: Inertia · ${fourthTitle}` }))
    .toBeVisible();
  expect((await box(quaternaryPane)).y).toBeGreaterThan((await box(primaryPane)).y);
  await expect(split.getByRole("textbox", { name: "Message" })).toHaveCount(4);
  await expect(page.getByRole("separator")).toHaveCount(4);
  await expect(page.getByRole("region", { name: `Primary chat: Inertia · ${primaryTitle}` }))
    .toBeVisible();

  await row(secondaryTitle).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove from split view" })).toBeVisible();
  await page.keyboard.press("Escape");

  await quaternaryPane.getByRole("button", {
    name: `Close split chat ${fourthTitle}`,
  }).click();
  await expect(panes).toHaveCount(3);
  await tertiaryPane.getByRole("button", {
    name: `Close split chat ${thirdTitle}`,
  }).click();
  await secondaryPane.getByRole("button", {
    name: `Close split chat ${secondaryTitle}`,
  }).click();
  await expect(split).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

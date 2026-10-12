// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "panel-tab-drag", initialState: "conversation" });
});

test.afterAll(async () => {
  await app.close();
});

test("reorders panel tabs by pointer drag and keeps the order after a reload", async () => {
  const { page } = app;
  await app.resizeWindow(1440, 920);
  let panel = await ensureWorkspaceTools(page);
  for (const name of ["Changes", "Files", "Plan", "Attachments"]) await selectWorkspaceTool(panel, name);
  const order = async () => await page.locator(".workspace-panel [data-tab-key]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-key")));
  const before = await order();
  const moved = before.at(-1)!;
  const source = await panel.locator(`[data-tab-key="${moved}"]`).boundingBox();
  const target = await panel.locator(`[data-tab-key="${before[0]}"]`).boundingBox();
  if (!source || !target) throw new Error("Panel tabs have no geometry");
  const y = source.y + source.height / 2;
  await page.mouse.move(source.x + source.width * 0.7, y);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width * 0.7 - 12, y, { steps: 3 });
  await page.mouse.move(target.x + 4, y, { steps: 10 });
  await page.mouse.up();
  const reordered = [moved, ...before.slice(0, -1)];
  await expect.poll(order).toEqual(reordered);
  await expect(panel.locator(`[data-workspace-tab="${moved}"]`)).toHaveAttribute("aria-selected", "true");

  await page.reload();
  await page.locator('.app-shell[data-connection-status="online"]').waitFor();
  panel = await ensureWorkspaceTools(page);
  await expect.poll(order).toEqual(reordered);
  expect(app.rendererErrors).toEqual([]);
});

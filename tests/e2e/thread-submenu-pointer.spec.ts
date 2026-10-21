// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
test.beforeAll(async () => { app = await createAppFixture({ name: "thread-submenu-pointer", initialState: "conversation" }); });
test.afterAll(async () => { await app.close(); });

test("opens each thread submenu beside its row and keeps it open while the pointer travels into it", async () => {
  const { page } = app;
  await app.resizeWindow(1280, 820);
  const row = page.locator('[data-work-focus-id^="thread:"]').first();
  for (const name of ["Copy", "Snooze"]) {
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: /^Thread actions for/u });
    await expect(menu).toBeVisible();
    const trigger = menu.getByRole("menuitem", { name, exact: true });
    const start = (await trigger.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2, { steps: 5 });
    const submenu = page.getByRole("menu", { name, exact: true });
    await expect(submenu).toBeVisible();
    await expect.poll(() => menu.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
    const row_ = (await trigger.boundingBox())!;
    const box = (await submenu.boundingBox())!;
    expect(Math.abs(box.x - (row_.x + row_.width + 4))).toBeLessThan(3);
    expect(Math.abs(box.y - row_.y)).toBeLessThan(3);
    await page.mouse.move(box.x + box.width / 2, box.y + 14, { steps: 25 });
    await expect(submenu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  expect(app.rendererErrors).toEqual([]);
});

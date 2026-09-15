// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "welcome-guide",
    initialState: "empty",
    welcomeGuide: true,
  });
});

test.afterAll(async () => {
  await app?.close();
});

test("greets a fresh install with a compact, keyboard-friendly guide", async () => {
  const { page } = app;
  const guide = page.getByRole("dialog", { name: "Welcome guide" });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("heading", { name: "Welcome to Inertia" })).toBeVisible();
  await expect(guide.getByRole("button", { name: "Take the tour" })).toBeFocused();
  // Native presentation can delay the opening animation beyond a fixed sleep.
  await expect.poll(() => guide.evaluate((element) => (
    element.getAnimations().every((animation) => animation.playState === "finished")
  ))).toBe(true);
  const first = await guide.boundingBox();

  await page.keyboard.press("ArrowRight");
  await expect(guide.getByRole("heading", { name: "How it works" })).toBeVisible();
  await guide.getByRole("tab", { name: "Duo" }).click();
  await expect(guide.getByRole("tabpanel")).toContainText("third model");
  await expect.poll(() => guide.evaluate((element) => (
    element.getAnimations().every((animation) => animation.playState === "finished")
  ))).toBe(true);
  const tour = await guide.boundingBox();
  expect(Math.round(tour?.width ?? 0)).toBe(Math.round(first?.width ?? 0));
  expect(Math.round(tour?.height ?? 0)).toBe(Math.round(first?.height ?? 0));

  await guide.getByRole("button", { name: "Connect an agent" }).click();
  await expect(guide.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
  await guide.getByRole("button", { name: "Continue" }).click();
  await expect(guide.getByRole("heading", { name: "You're ready to start" })).toBeVisible();
  await guide.getByRole("button", { name: /Add a project/u }).click();

  await expect(guide).toHaveCount(0);
  const addProject = page.getByRole("dialog", { name: "Add project" });
  await expect(addProject).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(addProject).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.getItem("inertia:welcome-guide:v1")))
    .not.toBeNull();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Report an issue" }).click();
  await page.getByRole("button", { name: "Show welcome guide" }).click();
  await expect(guide).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(guide).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

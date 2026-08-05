import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "private-connect",
    initialState: "conversation",
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test("wires the packaged Private Connect state through the desktop settings boundary", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", {
    name: "Connections & devices",
    exact: true,
  }).click();

  await expect(page.getByRole("heading", {
    name: "Inertia Private Connect",
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole("button", {
    name: /^(Enable|Disable)$/u,
  })).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Paired devices",
    exact: true,
  })).toBeVisible();
  await expect(page.getByText("No browsers are paired.", { exact: true }))
    .toBeVisible();

  await page.getByText("Advanced diagnostics", { exact: true }).click();
  const diagnostics = page.locator(".private-connect-diagnostics");
  await expect(diagnostics.getByText("Protocol", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("1", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Go to workspace" }).click();
  const indicator = page.getByRole("button", {
    name: /^Connections & devices/u,
  });
  await expect(indicator).toBeVisible();
  await indicator.click();
  await expect(page.getByRole("heading", {
    name: "Connections & devices",
    exact: true,
  })).toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});

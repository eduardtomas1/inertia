import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

const codexAppServerSource = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "provider-settings-visual-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [
      {
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        description: "Latest agentic coding model for complex engineering work.",
        isDefault: true,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "medium", description: "Balanced reasoning" },
          { reasoningEffort: "high", description: "Deep reasoning" }
        ]
      },
      {
        model: "gpt-5.2-codex-mini",
        displayName: "GPT-5.2 Codex Mini",
        description: "Fast, efficient coding model for everyday tasks.",
        inputModalities: ["text"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced reasoning" }
        ]
      }
    ], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
});
`;

let app!: AppFixture;
let page!: Page;

async function capture(testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "provider-settings-visual",
    initialState: "conversation",
    codexAppServerSource,
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test("keeps provider settings coherent across details, themes, and widths", async ({ browserName: _browserName }, testInfo) => {
  await app.resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Light" }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();

  const shell = page.locator(".provider-settings-shell");
  const rail = page.locator(".provider-settings-rail");
  const editor = page.locator(".provider-settings-editor");
  await expect(shell).toBeVisible();
  await expect(page.getByRole("button", { name: "Configure Codex" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: /Models 2/u })).toBeVisible();
  const wideGeometry = await Promise.all([rail.boundingBox(), editor.boundingBox()]);
  expect(wideGeometry[0]?.y).toBe(wideGeometry[1]?.y);
  expect(wideGeometry[0]?.x ?? 0).toBeLessThan(wideGeometry[1]?.x ?? 0);
  await app.expectNoViewportOverflow();
  await capture(testInfo, "provider-settings-configuration-light-wide");

  await page.getByRole("tab", { name: /Models 2/u }).click();
  await expect(page.getByText("GPT-5.3 Codex", { exact: true })).toBeVisible();
  await expect(page.getByText("GPT-5.2 Codex Mini", { exact: true })).toBeVisible();
  await capture(testInfo, "provider-settings-models-light-wide");

  await page.getByRole("tab", { name: "Configuration" }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.getByText("New chat defaults", { exact: true })).toBeVisible();
  await capture(testInfo, "provider-settings-advanced-light-wide");

  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await app.resizeWindow(760, 800);
  const narrowGeometry = await Promise.all([rail.boundingBox(), editor.boundingBox()]);
  expect(narrowGeometry[0]?.y ?? 0).toBeLessThan(narrowGeometry[1]?.y ?? 0);
  await app.expectNoViewportOverflow();
  await capture(testInfo, "provider-settings-configuration-dark-narrow");

  await app.resizeWindow(1440, 920);
  expect(app.rendererErrors).toEqual([]);
});

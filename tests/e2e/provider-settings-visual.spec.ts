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
    windowDisplay: "primary",
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
  await app.resizeWindow(1440, 1180);
  for (const name of ["Provider", "Model", "Reasoning", "Mode", "Access", "Chat location"]) {
    const control = page.getByRole("combobox", { name, exact: true });
    await expect(control).toBeEnabled();
    await control.click();
    await expect(control).toHaveCSS("appearance", "base-select");
    await expect.poll(() => control.evaluate((element) => element.matches(":open"))).toBe(true);
    const option = control.getByRole("option").last();
    await expect(option).toBeVisible();
    const bounds = await option.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(0);
    if (name === "Model") await capture(testInfo, "provider-default-model-picker-light");
    await page.keyboard.press("Escape");
    await expect(control).toBeFocused();
  }
  await capture(testInfo, "provider-settings-advanced-light-wide");

  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByRole("button", { name: "Advanced", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await app.resizeWindow(760, 1100);
  const narrowGeometry = await Promise.all([rail.boundingBox(), editor.boundingBox()]);
  expect(narrowGeometry[0]?.y ?? 0).toBeLessThan(narrowGeometry[1]?.y ?? 0);
  await app.expectNoViewportOverflow();
  await capture(testInfo, "provider-settings-configuration-dark-narrow");
  const access = page.getByRole("combobox", { name: "Access", exact: true });
  await access.click();
  const fullAccess = access.getByRole("option", { name: "Full access", exact: true });
  await expect(fullAccess).toBeVisible();
  const bounds = await fullAccess.boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  await capture(testInfo, "provider-default-access-picker-dark-narrow");
  await page.keyboard.press("Escape");

  await app.resizeWindow(1440, 920);
  expect(app.rendererErrors).toEqual([]);
});

test("selects Advanced defaults with pointer and keyboard and preserves them after restart", async () => {
  if (!await page.getByRole("main", { name: "Settings", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  const advanced = page.getByRole("button", { name: "Advanced", exact: true });
  if (await advanced.getAttribute("aria-expanded") !== "true") await advanced.click();
  const select = (name: string) => page.getByRole("combobox", { name, exact: true });
  const choose = async (name: string, option: string | RegExp, value: string): Promise<void> => {
    const control = select(name);
    await control.click();
    await control.getByRole("option", { name: option, exact: true }).click();
    await expect(control).toHaveValue(value);
    await expect(control).toBeFocused();
  };

  await choose("Model", "GPT-5.2 Codex Mini", "gpt-5.2-codex-mini");
  await expect(select("Reasoning")).toHaveValue("medium");
  await expect(select("Reasoning").getByRole("option", { name: "High", exact: true })).toHaveCount(0);
  await choose("Model", "GPT-5.3 Codex — Default", "gpt-5.3-codex");
  await choose("Reasoning", "High", "high");
  await choose("Mode", "Plan", "plan");
  await choose("Access", "Full access", "full");

  const location = select("Chat location");
  await location.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(location).toHaveValue("worktree");
  await expect(location).toBeFocused();

  await choose("Provider", /^Claude —/u, "claude");
  await expect(select("Model")).toHaveValue("");
  await expect(select("Reasoning")).toHaveValue("");
  await choose("Provider", /^Codex —/u, "codex");
  await choose("Model", "GPT-5.3 Codex — Default", "gpt-5.3-codex");
  await choose("Reasoning", "High", "high");

  ({ page } = await app.restart());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  for (const [name, value] of [
    ["Provider", "codex"], ["Model", "gpt-5.3-codex"], ["Reasoning", "high"],
    ["Mode", "plan"], ["Access", "full"], ["Chat location", "worktree"],
  ]) await expect(select(name!)).toHaveValue(value!);
  expect(app.rendererErrors).toEqual([]);
});

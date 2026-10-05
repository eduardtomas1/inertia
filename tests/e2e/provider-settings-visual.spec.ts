// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

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
    claudeAuthSource: `
if (process.argv[2] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
`,
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

const NEW_CHAT_SELECTS = [
  "Model",
  "Reasoning",
  "Work mode",
  "Access",
  "Where new chats run",
] as const;

async function distanceFromRail(row: Locator): Promise<number> {
  return row.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const fill = (color: string): number[] => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const rail = fill(getComputedStyle(element.parentElement!).backgroundColor);
    const row = fill(getComputedStyle(element).backgroundColor);
    return Math.hypot(...row.map((channel, index) => channel - rail[index]!));
  });
}

async function expectHoverQuieterThanSelection(rail: Locator): Promise<void> {
  const selected = rail.locator(".provider-settings-list-row.is-selected");
  const other = rail.locator(".provider-settings-list-row:not(.is-selected)").first();
  await other.hover();
  const hovered = await distanceFromRail(other);
  expect(hovered).toBeGreaterThan(0);
  expect(hovered).toBeLessThan(await distanceFromRail(selected));
  await page.mouse.move(0, 0);
}

async function selectedLabel(control: Locator): Promise<string> {
  return control.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent ?? "");
}

test("keeps provider settings coherent across details, themes, and widths", async ({ browserName: _browserName }, testInfo) => {
  await app.resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Light" }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();

  const shell = page.locator(".provider-settings-shell");
  const rail = page.locator(".provider-settings-rail");
  const editor = page.locator(".provider-settings-editor");
  await expect(shell).toBeVisible();
  await expect(page.getByRole("button", { name: "Configure Codex" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: /Models 2/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Advanced", exact: true })).toHaveCount(0);
  const wideGeometry = await Promise.all([rail.boundingBox(), editor.boundingBox()]);
  expect(wideGeometry[0]?.y).toBe(wideGeometry[1]?.y);
  expect(wideGeometry[0]?.x ?? 0).toBeLessThan(wideGeometry[1]?.x ?? 0);
  await app.expectNoViewportOverflow();
  await expectHoverQuieterThanSelection(rail);
  await capture(testInfo, "provider-settings-configuration-light-wide");

  await page.getByRole("tab", { name: /Models 2/u }).click();
  await expect(page.getByText("GPT-5.3 Codex", { exact: true })).toBeVisible();
  await expect(page.getByText("GPT-5.2 Codex Mini", { exact: true })).toBeVisible();
  await capture(testInfo, "provider-settings-models-light-wide");
  await page.getByRole("tab", { name: "Configuration" }).click();

  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await app.resizeWindow(1440, 1180);
  for (const name of NEW_CHAT_SELECTS) {
    const control = page.getByRole("combobox", { name, exact: true });
    await expect(control).toBeEnabled();
    if (await control.getAttribute("aria-disabled") === "true") {
      expect(name).toBe("Reasoning");
      await expect(control.getByRole("option")).toHaveCount(1);
      continue;
    }
    await control.click();
    await expect(control).toHaveCSS("appearance", "base-select");
    await expect.poll(() => control.evaluate((element) => element.matches(":open"))).toBe(true);
    const option = control.getByRole("option").last();
    await expect(option).toBeVisible();
    const bounds = await option.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(0);
    if (name === "Model") await capture(testInfo, "new-chat-default-model-picker-light");
    await page.keyboard.press("Escape");
    await expect(control).toBeFocused();
  }
  await capture(testInfo, "new-chat-defaults-light-wide");

  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expectHoverQuieterThanSelection(rail);
  await app.resizeWindow(760, 1100);
  const narrowGeometry = await Promise.all([rail.boundingBox(), editor.boundingBox()]);
  expect(narrowGeometry[0]?.y ?? 0).toBeLessThan(narrowGeometry[1]?.y ?? 0);
  await app.expectNoViewportOverflow();
  await capture(testInfo, "provider-settings-configuration-dark-narrow");
  await page.getByRole("button", { name: "Chats", exact: true }).click();
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
  await capture(testInfo, "new-chat-default-access-picker-dark-narrow");
  await page.keyboard.press("Escape");

  await app.resizeWindow(1440, 920);
  expect(app.rendererErrors).toEqual([]);
});

test("selects new-chat defaults with pointer and keyboard and preserves them after restart", async () => {
  if (!await page.getByRole("main", { name: "Settings", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const select = (name: string) => page.getByRole("combobox", { name, exact: true });
  const choose = async (name: string, option: string | RegExp): Promise<void> => {
    const control = select(name);
    await control.click();
    const choice = control.getByRole("option", { name: option, exact: true });
    await expect(choice).toHaveCount(1);
    await choice.click();
    await expect.poll(() => selectedLabel(control)).toMatch(option);
    await expect(control).toBeFocused();
  };
  const reasoning = select("Reasoning");

  await choose("Model", "GPT-5.2 Codex Mini");
  await expect(reasoning).toHaveValue("");
  await expect(reasoning.getByRole("option", { name: "High", exact: true })).toHaveCount(0);
  await choose("Model", "GPT-5.3 Codex");
  await choose("Reasoning", "High");
  await expect(reasoning).toHaveValue("high");
  await choose("Work mode", "Plan");
  await choose("Access", "Full access");

  const location = select("Where new chats run");
  await location.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(location).toHaveValue("worktree");
  await expect(location).toBeFocused();

  ({ page } = await app.restart());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await expect.poll(() => selectedLabel(select("Model"))).toBe("GPT-5.3 Codex");
  await expect(select("Reasoning")).toHaveValue("high");
  await expect(select("Work mode")).toHaveValue("plan");
  await expect(select("Access")).toHaveValue("full");
  await expect(select("Where new chats run")).toHaveValue("worktree");
  expect(app.rendererErrors).toEqual([]);
});

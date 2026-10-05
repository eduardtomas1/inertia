// @inertia-e2e-resource isolated
import { hostname, userInfo } from "node:os";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import type { AppSettingsUpdate } from "../../src/shared/contracts";
import { buildCustomPaletteTokens } from "../../scripts/color-theme-spec.mjs";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { updateSettingsInPlace } from "./support/appearance";
import { ensureWorkspaceTools, openTerminalDock, selectWorkspaceTool } from "./support/workspace-tools";

const scenarios: readonly (readonly [string, AppSettingsUpdate])[] = [
  ["ember", { lightColorTheme: "ember", darkColorTheme: "ember" }],
  ["teal", { lightCustomColor: "#0d9488", darkCustomColor: "#0d9488", mutedCustomColors: false }],
  ["teal-muted", { lightCustomColor: "#0d9488", darkCustomColor: "#0d9488", mutedCustomColors: true }],
  ["orange", { lightCustomColor: "#f97316", darkCustomColor: "#f97316", mutedCustomColors: false }],
  ["orange-muted", { lightCustomColor: "#f97316", darkCustomColor: "#f97316", mutedCustomColors: true }],
];

function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

function token(color: string, mode: "light" | "dark", muted: boolean, name: string): string {
  return Object.fromEntries(buildCustomPaletteTokens(color, mode, muted))[name]!;
}

function rootToken(page: Page, name: string): Promise<string> {
  return page.locator("html").evaluate((root, property) => getComputedStyle(root).getPropertyValue(property).trim(), `--${name}`);
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectTerminalFollows(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    painted: getComputedStyle(document.querySelector(".terminal-dock .xterm-scrollable-element")!).backgroundColor,
    token: getComputedStyle(document.documentElement).getPropertyValue("--terminal-bg").trim(),
  })).then(({ painted, token: value }) => painted === rgb(value) ? "terminal follows" : `${painted} instead of ${rgb(value)}`))
    .toBe("terminal follows");
}

async function openWorkbench(name: string): Promise<AppFixture> {
  const app = await createAppFixture({ name, initialState: "conversation", seedAssistantCodeBlock: true });
  await app.resizeWindow(1440, 920);
  await ensureWorkspaceTools(app.page);
  await selectWorkspaceTool(app.page.locator(".workspace-panel"), "Changes");
  await expect(app.page.locator(".diff-line.is-addition").first()).toBeVisible();
  await openTerminalDock(app.page);
  await expect(app.page.locator(".terminal-dock .terminal-panel[data-terminal-state=ready]")).toHaveCount(1);
  await app.page.locator(".terminal-dock .xterm").click();
  await app.page.keyboard.type("PS1='$ ' PROMPT='$ '; clear");
  await app.page.keyboard.press("Enter");
  await expectAnonymousTerminal(app.page);
  await app.page.getByRole("textbox", { name: "Message" }).fill("Review the colour changes");
  return app;
}

async function expectAnonymousTerminal(page: Page): Promise<void> {
  const rows = page.locator(".terminal-dock .xterm-rows");
  await expect(rows).toContainText("$");
  await expect(rows).not.toContainText(userInfo().username);
  await expect(rows).not.toContainText(hostname().split(".")[0]!);
}

async function openDetachedChat(app: AppFixture, name: string): Promise<Page> {
  await app.page.locator(".workspace-header").getByRole("button", { name: `${name} fixture`, exact: true }).click();
  const opened = app.electronApp.waitForEvent("window");
  await app.page.getByRole("menuitem", { name: "Open chat in new window" }).click();
  const popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  return popup;
}

async function applyScenario(app: AppFixture, update: AppSettingsUpdate, theme: "light" | "dark", pages: readonly Page[]): Promise<void> {
  await updateSettingsInPlace(app, { ...update, theme });
  const expected = "lightCustomColor" in update ? "custom" : update.lightColorTheme!;
  for (const page of pages) {
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", expected);
    if (update.lightCustomColor) {
      await expect.poll(() => rootToken(page, "accent"))
        .toBe(token(update.lightCustomColor, theme, update.mutedCustomColors ?? false, "accent"));
    }
  }
}

test("mutes custom colours from Settings and recolours the terminal and the detached window", async ({
  browserName: _browserName,
}) => {
  const app = await openWorkbench("custom-colours-live");
  const { page } = app;
  try {
    await applyScenario(app, { lightCustomColor: "#0d9488" }, "light", [page]);
    await expectTerminalFollows(page);
    await updateSettingsInPlace(app, { lightCustomColor: "#f97316" });
    await expect.poll(() => rootToken(page, "accent")).toBe(token("#f97316", "light", false, "accent"));
    await expectTerminalFollows(page);
    const popup = await openDetachedChat(app, "custom-colours-live");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const muted = page.getByRole("switch", { name: "Muted colours" });
    await expect(muted).not.toBeChecked();
    await muted.click();
    await expect(muted).toBeChecked();
    for (const view of [page, popup]) {
      await expect.poll(() => rootToken(view, "accent")).toBe(token("#f97316", "light", true, "accent"));
      await expect.poll(() => rootToken(view, "app-bg")).toBe(token("#f97316", "light", true, "app-bg"));
    }
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expectTerminalFollows(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("button", { name: "Reset light custom colour", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", "inertia");
    await expect(popup.locator("html")).toHaveAttribute("data-color-theme", "inertia");
    await expect(muted).not.toBeChecked();
    await expect(muted).toHaveAttribute("aria-disabled", "true");
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("carries custom colours through the workbench, terminal, Settings, and the detached window", async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(360_000);
  const app = await openWorkbench("custom-colours-reach");
  const { page } = app;
  try {
    for (const [label, update] of scenarios) {
      for (const theme of ["light", "dark"] as const) {
        await applyScenario(app, update, theme, [page]);
        await expectTerminalFollows(page);
        await expectAnonymousTerminal(page);
        await capture(page, info, `${label}-workspace-${theme}`);
      }
    }
    const popup = await openDetachedChat(app, "custom-colours-reach");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    for (const [label, update] of scenarios) {
      for (const theme of ["light", "dark"] as const) {
        await applyScenario(app, update, theme, [page, popup]);
        await capture(popup, info, `${label}-detached-${theme}`);
        await page.locator('[data-setting-id="muted-custom-colours"]').scrollIntoViewIfNeeded();
        await app.expectNoViewportOverflow();
        await capture(page, info, `${label}-settings-${theme}`);
      }
    }
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

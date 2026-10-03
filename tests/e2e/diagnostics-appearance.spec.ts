// @inertia-e2e-resource isolated
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import type { DiagnosticIncident } from "../../src/shared/application-diagnostics";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const MINUTE = 60_000;
const SEEDED_AT = Math.floor(Date.now() / MINUTE) * MINUTE - 90 * MINUTE;

function seedJournal(testDirectory: string): void {
  let clock = SEEDED_AT;
  const diagnostics = new RuntimeDiagnostics(join(testDirectory, "electron-profile", "logs", "runtime"), { now: () => clock });
  const at = (minutes: number): string => {
    clock = SEEDED_AT + minutes * MINUTE;
    return new Date(clock).toISOString();
  };
  const incident = (minutes: number, update: Partial<DiagnosticIncident>): void => {
    const id = randomUUID();
    diagnostics.recordIncident({ schemaVersion: 1, id, correlationId: id, code: "discord.delivery-unknown", at: at(minutes),
      runtimeGeneration: null, outcome: "unknown", context: {}, metadata: {}, ...update });
  };
  at(0);
  diagnostics.record("app.start");
  diagnostics.record("runtime.state", { phase: "ready", generation: 1 });
  incident(6, { code: "provider.auth-failed", outcome: "failed", context: { providerId: "codex" } });
  at(14);
  diagnostics.record("runtime.stderr", { code: "database-backup-failed", count: 1 });
  incident(22, { code: "git.command-failed", metadata: { exitCode: 128 } });
  at(31);
  diagnostics.record("runtime.failure", { phase: "restarting", generation: 1, message: "Runtime startup timed out." });
  diagnostics.record("runtime.state", { phase: "ready", generation: 2 });
  incident(38, {});
  incident(45, { code: "runtime.reconnected", outcome: "recovered" });
  diagnostics.flushIncidents();
}

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "diagnostics-appearance", initialState: "conversation",
    beforeLaunch: ({ testDirectory }) => seedJournal(testDirectory) });
  await app.page.clock.setFixedTime(SEEDED_AT + 120 * MINUTE);
});

test.afterAll(async () => {
  await app?.close();
});

async function capture(page: Page, info: TestInfo, name: string, keepFocus = false): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  if (!keepFocus) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectLayoutHolds(app: AppFixture): Promise<void> {
  await app.expectNoViewportOverflow();
  const layout = await app.page.locator(".diagnostics").evaluate((root) => {
    const content = root.closest(".settings-content")!.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    const rows = [...root.querySelectorAll<HTMLElement>(".diagnostics-event-row")];
    const titles = [...root.querySelectorAll<HTMLElement>(".diagnostics-event-copy strong")];
    const controls = [...root.querySelectorAll<HTMLElement>(".diagnostics-filters input, .diagnostics-filters select, .diagnostics-actions button")];
    return {
      inside: bounds.left >= content.left - 0.5 && bounds.right <= content.right + 0.5,
      overflow: root.scrollWidth - root.clientWidth,
      nested: [...root.querySelectorAll("button")].filter((button) => button.parentElement?.closest("button")).length,
      truncatedTitles: titles.filter((title) => title.scrollWidth > title.clientWidth + 1).length,
      shortRows: rows.filter((row) => row.getBoundingClientRect().height < 44).length,
      clippedControls: controls.filter((control) => control.scrollWidth > control.clientWidth + 1 && control.tagName === "BUTTON").length,
      narrowControls: controls.filter((control) => control.getBoundingClientRect().width < 72).length,
      shortControls: controls.filter((control) => control.getBoundingClientRect().height < 28).length,
    };
  });
  expect(layout).toEqual({ inside: true, overflow: 0, nested: 0, truncatedTitles: 0, shortRows: 0,
    clippedControls: 0, narrowControls: 0, shortControls: 0 });
}

async function openDiagnostics(page: Page): Promise<void> {
  if (!await page.getByRole("main", { name: "Settings", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Diagnostics", exact: true, level: 3 })).toBeVisible();
  await expect(page.getByText("A scheduled database backup failed", { exact: true })).toBeVisible();
}

test("reads recent events plainly across themes and window sizes", async ({ browserName: _browserName }, info) => {
  test.setTimeout(180_000);
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await openDiagnostics(page);
  const list = page.getByRole("list", { name: "Recent events" });
  await expect(list.getByText("Provider authentication is required", { exact: true })).toBeVisible();
  await expect(list.getByText("The local runtime reported a failure", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Capture diagnostics" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("group", { name: "Process health" })).toContainText("Memory");
  await expectLayoutHolds(app);
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "diagnostics-light-wide");
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "diagnostics-dark-wide");

  const row = list.getByRole("button", { name: /Provider authentication is required/u });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Open provider settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy incident", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByText("provider.auth-failed", { exact: true })).toBeVisible();
  await expectLayoutHolds(app);
  await capture(page, info, "diagnostics-expanded-dark-wide");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("heading", { name: "Diagnostics", exact: true, level: 3 }).scrollIntoViewIfNeeded();

  for (const [width, height, theme, name] of [
    [1000, 800, "light", "diagnostics-light-narrow"],
    [1000, 800, "dark", "diagnostics-dark-narrow"],
    [760, 600, "dark", "diagnostics-dark-760x600"],
  ] as const) {
    await app.resizeWindow(width, height);
    await setAppearanceInPlace(app, theme);
    await expectLayoutHolds(app);
    await capture(page, info, name);
  }

  await app.resizeWindow(1440, 920);
  const trigger = page.getByRole("button", { name: "Clear history…", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Clear diagnostics history?" });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await capture(page, info, "diagnostics-clear-dialog-dark-wide", true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});

test("turns capture off, keeps the always-on events and clears history", async ({ browserName: _browserName }, info) => {
  test.setTimeout(120_000);
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await openDiagnostics(page);
  const toggle = page.getByRole("switch", { name: "Capture diagnostics" });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeFocused();
  await expect(page.getByText(/Off since .*App start, quit and failures are still kept\./u)).toBeVisible();
  const preferences = JSON.parse(await readFile(join(app.testDirectory, "electron-profile", "diagnostics-preferences.json"), "utf8"));
  expect(preferences).toMatchObject({ enabled: false });
  await expect(page.getByRole("list", { name: "Recent events" }).getByText("Diagnostics capture turned off", { exact: true })).toBeVisible();

  const failed = await page.evaluate(async () => window.inertia.sendDiscordReleaseInfo({ repositoryUrl: "https://unsupported.invalid/project" }));
  expect(failed).toMatchObject({ sent: false, code: "discord.repository-missing" });
  expect(failed).not.toHaveProperty("incidentId");
  const page1 = await page.evaluate(() => window.inertia.queryDiagnostics({ severity: "all", search: "discord.repository-missing" }));
  expect(page1.total).toBe(0);
  await capture(page, info, "diagnostics-capture-off-dark-wide");

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Copy support summary", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Support summary copied" })).toBeVisible();
  const summary = await app.electronApp.evaluate(({ clipboard }) => clipboard.readText());
  expect(summary).toContain("diagnostics.capture-stopped");
  expect(summary).not.toContain(app.workspaceDirectory);
  await page.getByRole("button", { name: "Reveal log folder", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Log folder opened." })).toBeVisible();

  const trigger = page.getByRole("button", { name: "Clear history…", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Clear diagnostics history?" });
  await dialog.getByRole("button", { name: "Clear history", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Diagnostics history cleared." })).toBeVisible();
  const list = page.getByRole("list", { name: "Recent events" });
  await expect(list.getByText("Diagnostics history cleared", { exact: true })).toBeVisible();
  await expect(list.getByText("Provider authentication is required", { exact: true })).toHaveCount(0);
  const cleared = await page.evaluate(() => window.inertia.queryDiagnostics({ severity: "all" }));
  expect(cleared.records).toEqual([]);
  expect(cleared.events.at(-1)?.event).toBe("diagnostics.history-cleared");
  expect(app.rendererErrors).toEqual([]);
});

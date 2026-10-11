// @inertia-e2e-resource primary-display
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import { RuntimeStore } from "../../src/server/database";
import { seedModelChooserNativeMetadata } from "./support/model-catalog-fixture";
import type { DiagnosticIncident } from "../../src/shared/application-diagnostics";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const outDir = process.env.CAP_OUT ?? "";
const suffix = process.env.CAP_SUFFIX ?? "after";
const logFile = process.env.CAP_LOG ?? "";
const only = (process.env.CAP_ONLY ?? "").split(",").filter(Boolean);
const themes = (process.env.CAP_THEMES ?? "light,dark").split(",") as Theme[];
type Theme = "light" | "dark";

function log(line: string): void {
  if (logFile) appendFileSync(logFile, `${line}\n`);
  console.log(line);
}

function seedJournal(testDirectory: string): void {
  const minute = 60_000;
  const seededAt = Math.floor(Date.now() / minute) * minute - 90 * minute;
  let clock = seededAt;
  const diagnostics = new RuntimeDiagnostics(join(testDirectory, "electron-profile", "logs", "runtime"), { now: () => clock });
  const at = (minutes: number): string => {
    clock = seededAt + minutes * minute;
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
  incident(45, { code: "runtime.reconnected", outcome: "recovered" });
  diagnostics.flushIncidents();
}

let app!: AppFixture;
let page!: Page;
let currentTheme: Theme = "light";

test.beforeAll(async () => {
  test.setTimeout(240_000);
  app = await createAppFixture({
    name: "batch-d-capture",
    initialState: "conversation",
    windowDisplay: "primary",
    seedSecondProject: true,
    codexAppServerSource: `
if (process.argv.slice(2)[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
setInterval(() => {}, 1_000);
`,
    claudeAuthSource: `
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
if (args[0] === "login") {
  process.stdout.write("Opening browser to sign in...\\r\\n");
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge\\r\\n");
  process.stdout.write("Paste code here if prompted > ");
  setInterval(() => {}, 1_000);
}
`,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      seedJournal(testDirectory);
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        seedModelChooserNativeMetadata(store, new Date().toISOString());
      } finally {
        store.close();
      }
    },
  });
  page = app.page;
  await app.electronApp.evaluate(({ shell }) => {
    Reflect.set(shell, "openExternal", async () => undefined);
  });
  await app.resizeWindow(1440, 860);
});

test.afterAll(async () => {
  await app?.close();
});

async function size(width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
}

async function settle(): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function shot(surface: string, options: { moveMouse?: boolean; target?: Page } = {}): Promise<void> {
  const target = options.target ?? page;
  if (options.moveMouse !== false && target === page) await page.mouse.move(720, 4);
  if (target === page) await settle();
  else await target.waitForTimeout(600);
  const viewport = target === page ? page.viewportSize() : null;
  const dims = viewport ? `${viewport.width}x${viewport.height}` : "native";
  const file = join(outDir, `${surface}-${currentTheme}-${dims}-${suffix}.png`);
  await target.screenshot({ path: file, animations: "disabled", caret: "hide", scale: "css" });
  log(`OK\t${surface}\t${currentTheme}\t${file}`);
}

async function scrolled(surface: string, maxPages = 8): Promise<void> {
  const scroller = page.locator(".settings-content").first();
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await shot(`${surface}-p1`);
  for (let index = 2; index <= maxPages; index += 1) {
    const moved = await scroller.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = before + element.clientHeight - 80;
      return element.scrollTop > before + 4;
    });
    if (!moved) break;
    await shot(`${surface}-p${index}`);
  }
}

async function reset(): Promise<void> {
  await size(1440, 920);
  for (const extra of app.electronApp.windows()) if (extra !== page && !extra.url().endsWith("/mascot.html")) await extra.close().catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.reload();
  await page.locator('.app-shell[data-connection-status="online"]').waitFor({ timeout: 45_000 });
  const close = page.getByRole("button", { name: "Close settings", exact: true }).first();
  if (await close.isVisible({ timeout: 1_500 }).catch(() => false)) await close.click().catch(() => undefined);
}

async function openSettings(section: string): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }).click();
  await page.waitForTimeout(500);
  return page.getByRole("main", { name: "Settings" });
}

async function scrollTo(locator: Locator): Promise<void> {
  await locator.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(200);
}

type Surface = { name: string; drive: () => Promise<void> };

const sections = ["Appearance", "Chats", "Notifications", "Keyboard", "Projects", "Agents", "Devices & integrations", "Data", "Help"];

const surfaces: Surface[] = [
  ...sections.map((section) => ({
    name: `settings-${section}`,
    drive: async () => {
      await openSettings(section);
      await scrolled(`settings-${section.toLowerCase().replace(/[^a-z]+/gu, "-")}`);
    },
  })),
  ...["Appearance", "Agents", "Data", "Projects"].map((section) => ({
    name: `settings-760-${section}`,
    drive: async () => {
      await openSettings(section);
      await size(760, 600);
      await scrolled(`settings-${section.toLowerCase()}`, 3);
    },
  })),
  { name: "settings-search", drive: async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("combobox", { name: "Search settings" }).pressSequentially("sound");
    await page.waitForTimeout(400);
    await page.keyboard.press("ArrowDown");
    await shot("settings-search", { moveMouse: false });
  } },
  { name: "settings-picker", drive: async () => {
    await openSettings("Chats");
    await page.getByRole("combobox", { name: "Work mode", exact: true }).click();
    await page.waitForTimeout(300);
    await page.keyboard.press("ArrowDown");
    await shot("settings-picker", { moveMouse: false });
  } },
  { name: "settings-sound", drive: async () => {
    const settings = await openSettings("Notifications");
    const toggle = settings.getByRole("switch", { name: "Sound when a task ends" });
    if (await toggle.getAttribute("aria-checked") !== "true") await toggle.click();
    await settings.getByText("How custom sprites work").click().catch(() => undefined);
    await scrolled("settings-notifications-open");
    await toggle.click();
  } },
  { name: "settings-working-advanced", drive: async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSettings("Appearance");
    const block = page.locator(".working-indicator-settings");
    await block.getByText("Advanced", { exact: true }).click();
    await scrollTo(block);
    await shot("settings-working-indicator");
    await page.emulateMedia({ reducedMotion: null });
  } },
  { name: "settings-project-editor", drive: async () => {
    const settings = await openSettings("Projects");
    await settings.getByRole("button", { name: "Choose project", exact: true }).click();
    await page.waitForTimeout(300);
    await shot("settings-project-chooser", { moveMouse: false });
    await page.getByRole("option", { name: /^Inertia/u }).first().click();
    await page.waitForTimeout(600);
    await settings.getByRole("button", { name: "Add action" }).click().catch(() => undefined);
    await scrolled("settings-project-editor");
    await settings.getByRole("button", { name: "Remove project" }).click();
    await page.waitForTimeout(300);
    await scrollTo(settings.getByRole("group", { name: "Confirm removing the project" }));
    await shot("settings-project-remove");
    await settings.getByRole("button", { name: "Choose icon", exact: true }).click().catch(() => undefined);
    await page.waitForTimeout(300);
    await page.locator(".settings-content").first().evaluate((element) => { element.scrollTop = 0; });
    await shot("settings-project-icons");
  } },
  { name: "project-customize", drive: async () => {
    await page.getByRole("button", { name: "Filter work by project" }).click();
    await page.getByRole("button", { name: /^Customise /u }).last().click();
    await page.waitForTimeout(500);
    await shot("project-customize", { moveMouse: false });
  } },
  { name: "settings-agents-detail", drive: async () => {
    const settings = await openSettings("Agents");
    const claude = settings.getByRole("button", { name: "Configure Claude" });
    await expect(claude).toContainText("Sign in required", { timeout: 20_000 }).catch(() => undefined);
    await claude.click();
    await shot("settings-agents-claude");
    await settings.getByRole("button", { name: "Configure Codex" }).click();
    await settings.getByRole("tab", { name: /^Models/u }).click().catch(() => undefined);
    await shot("settings-agents-models");
    await settings.getByRole("button", { name: "New profile" }).click();
    await page.waitForTimeout(300);
    await scrollTo(settings.getByRole("region", { name: "Custom backends" }));
    await shot("settings-agents-backend-editor");
  } },
  { name: "provider-auth", drive: async () => {
    const settings = await openSettings("Agents");
    const claude = settings.getByRole("button", { name: "Configure Claude" });
    await expect(claude).toContainText("Sign in required", { timeout: 20_000 });
    await claude.click();
    await page.locator(".provider-settings-editor").getByRole("button", { name: "Connect" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect Claude" });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(1500);
    await shot("provider-auth-dialog", { moveMouse: false });
    await dialog.getByRole("button", { name: "Close connection window" }).click();
  } },
  { name: "help-diagnostics", drive: async () => {
    const settings = await openSettings("Help");
    const row = settings.locator(".diagnostics-event-row").first();
    await row.click().catch(() => undefined);
    await scrollTo(settings.locator(".diagnostics").first());
    await shot("settings-help-diagnostics");
    const clear = settings.getByRole("button", { name: /^Clear history/u }).first();
    await clear.click();
    await page.waitForTimeout(500);
    await shot("diagnostics-clear-dialog", { moveMouse: false });
    await page.keyboard.press("Escape");
  } },
  { name: "data-confirm", drive: async () => {
    const settings = await openSettings("Data");
    await settings.getByRole("button", { name: "Restore defaults…" }).click();
    await page.waitForTimeout(300);
    await scrollTo(settings.getByRole("group", { name: "Confirm restore defaults" }));
    await shot("settings-data-restore-confirm");
  } },
  { name: "composer-reasoning", drive: async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().waitFor();
    const composer = page.locator("[data-maximum-reasoning], .composer").first();
    log(`INFO\tmaximum-reasoning\t${currentTheme}\t${await page.locator('[data-maximum-reasoning="true"]').count()}`);
    await composer.waitFor().catch(() => undefined);
    await shot("composer-welcome");
  } },
  { name: "issue-report-preview", drive: async () => {
    const settings = await openSettings("Help");
    const back = settings.getByRole("button", { name: "Back", exact: true });
    if (await back.isVisible().catch(() => false)) await back.click();
    await settings.getByRole("textbox", { name: "What happened", exact: true }).fill("The sidebar lost its selection after a reload.");
    await settings.getByRole("button", { name: "Preview issue" }).click();
    await page.waitForTimeout(1500);
    await shot("settings-issue-preview");
  } },
  { name: "welcome-guide", drive: async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const settings = await openSettings("Help");
    await settings.getByRole("button", { name: "Show welcome guide" }).click();
    const dialog = page.getByRole("dialog", { name: "Welcome guide" });
    await dialog.waitFor();
    await page.waitForTimeout(800);
    await shot("welcome-guide-1", { moveMouse: false });
    for (const [index, name] of [[2, /Take the tour/u], [3, /Connect an agent/u], [4, /Continue/u]] as const) {
      await dialog.getByRole("button", { name }).click();
      await page.waitForTimeout(800);
      await shot(`welcome-guide-${index}`, { moveMouse: false });
    }
    await dialog.getByRole("tab", { name: "Split view" }).click().catch(() => undefined);
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: null });
  } },
  { name: "welcome-guide-tour", drive: async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const settings = await openSettings("Help");
    await settings.getByRole("button", { name: "Show welcome guide" }).click();
    const dialog = page.getByRole("dialog", { name: "Welcome guide" });
    await dialog.getByRole("button", { name: /Take the tour/u }).click();
    await dialog.getByRole("tab", { name: "Duo" }).click();
    await page.waitForTimeout(800);
    await shot("welcome-guide-2-duo", { moveMouse: false });
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: null });
  } },
  { name: "help-guide", drive: async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Help", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Help" });
    await dialog.waitFor();
    await page.waitForTimeout(800);
    await shot("help-guide", { moveMouse: false });
    await dialog.getByRole("tab", { name: "Following work" }).click().catch(() => undefined);
    await page.waitForTimeout(600);
    await shot("help-guide-demo", { moveMouse: false });
    await dialog.getByRole("searchbox", { name: "Search help" }).fill("snooz");
    await page.waitForTimeout(600);
    await shot("help-guide-search", { moveMouse: false });
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: null });
  } },
  { name: "mascot", drive: async () => {
    const settings = await openSettings("Notifications");
    const toggle = settings.getByRole("switch", { name: "Show mascot", exact: true });
    if (await toggle.getAttribute("aria-checked") === "true") await toggle.click();
    const opened = app.electronApp.waitForEvent("window");
    await toggle.click();
    const overlay = await opened;
    await overlay.locator(".mascot").waitFor();
    await overlay.waitForTimeout(1500);
    await shot("mascot-overlay", { target: overlay });
    await overlay.locator(".mascot-open").focus().catch(() => undefined);
    await overlay.keyboard.press("Tab").catch(() => undefined);
    await shot("mascot-overlay-focus", { target: overlay });
    await toggle.click();
  } },
];

test("captures batch D surfaces", async () => {
  test.setTimeout(75 * 60_000);
  expect(outDir).not.toBe("");
  mkdirSync(outDir, { recursive: true });
  const selected = surfaces.filter((surface) => !only.length || only.includes(surface.name));
  for (const theme of themes) {
    await reset();
    await setAppearanceInPlace(app, theme);
    currentTheme = theme;
    for (const surface of selected) {
      try {
        await reset();
        await surface.drive();
      } catch (error) {
        log(`FAIL\t${surface.name}\t${theme}\t${String(error).split("\n")[0]!.slice(0, 240)}`);
        await page.screenshot({ path: join(outDir, `zz-fail-${surface.name.replace(/[^a-z0-9-]+/giu, "-")}-${theme}-${suffix}.png`) }).catch(() => undefined);
      }
    }
  }
  log(`renderer errors: ${JSON.stringify(app.rendererErrors).slice(0, 2000)}`);
});

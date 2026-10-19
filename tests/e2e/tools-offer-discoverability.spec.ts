// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { closeWorkspaceTools, ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const execFileAsync = promisify(execFile);
const FIXED_NOW = Date.parse("2026-10-19T12:00:00.000Z");
const PRIMARY = process.platform === "darwin" ? "Meta" : "Control";
const SURFACE_COMMANDS = [
  "Open Changes",
  "Open Files",
  "Open Browser",
  "Open Terminal",
  "Open Attachments",
  "Open Background tasks",
  "Open Usage",
  "Open Goal",
  "Open Plan",
];
const BUILD_INTRO = "Build finished. I changed three things:";
const BUILD_STEPS = [
  "Renamed the surface launcher helper",
  "Updated the palette unit tests",
  "Refreshed the keyboard shortcut docs",
];
const PLAN_INTRO = "Here is how I would make the tools easier to find:";
const PLAN_STEPS = [
  "List every surface in the command palette",
  "Add a shortcut that opens the surface menu",
  "Show the new shortcut in Keyboard settings",
];
const reply = (intro: string, steps: readonly string[]): string =>
  [intro, "", ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n");

// Neither turn reports a native plan: the Build reply's list must stay out of
// the Plan tab, and the Plan reply's list may only appear as derived steps.
const discoverabilityAppServer = `
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const buildReply = ${JSON.stringify(reply(BUILD_INTRO, BUILD_STEPS))};
const planReply = ${JSON.stringify(reply(PLAN_INTRO, PLAN_STEPS))};
let threadId = "tools-offer-thread";
let turnSequence = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "tools-offer-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const turnId = "tools-offer-turn-" + turnSequence;
  const turn = { id: turnId, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  const text = message.params.collaborationMode?.mode === "plan" ? planReply : buildReply;
  send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { id: turnId + "-answer", type: "agentMessage", text, phase: "final_answer" } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
});
`;

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "tools-offer",
    initialState: "conversation",
    codexAppServerSource: discoverabilityAppServer,
    // Fetch is only offered for a repository with a remote.
    beforeLaunch: async ({ workspaceDirectory, testDirectory }) => {
      const remote = join(testDirectory, "remote.git");
      await execFileAsync("git", ["init", "-q", "--bare", remote], { cwd: testDirectory, timeout: 10_000 });
      await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: workspaceDirectory, timeout: 10_000 });
    },
  });
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app.close();
});

async function capture(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await app.page.mouse.move(0, 0);
  await app.page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

function turnModes(): string[] {
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return (database.prepare("SELECT interaction_mode FROM agent_turns ORDER BY requested_at, id").all() as Array<{ interaction_mode: string }>)
      .map(({ interaction_mode: mode }) => mode);
  } finally {
    database.close();
  }
}

async function openPalette(): Promise<Locator> {
  const page = app.page;
  await page.getByRole("textbox", { name: "Message", exact: true }).focus();
  await page.keyboard.press(`${PRIMARY}+K`);
  const dialog = page.getByRole("dialog", { name: "Search Inertia" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Search commands, projects, chats, and messages" })).toBeFocused();
  return dialog;
}

function paletteOption(group: Locator, label: string): Locator {
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
  return group.getByRole("option").filter({ has: group.page().locator("strong", { hasText: exact }) });
}

function surfaceTab(panel: Locator, surface: string): Locator {
  return panel.locator(`[data-workspace-tab="${surface}"]`);
}

async function blurActiveElement(): Promise<void> {
  await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test("the command palette offers the chat's surfaces and Git actions", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "light");

  const dialog = await openPalette();
  const search = dialog.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
  // Chat commands join the list only once the user types.
  await expect(dialog.getByRole("group", { name: "Surfaces" })).toHaveCount(0);
  await search.pressSequentially("open");
  await expect(search).toHaveValue("open");
  const surfaces = dialog.getByRole("group", { name: "Surfaces" });
  await expect(surfaces).toBeVisible();
  await expect(surfaces.getByRole("option").locator("strong")).toHaveText(SURFACE_COMMANDS);
  await capture(info, "palette-surfaces-light");

  await paletteOption(surfaces, "Open Plan").click();
  await expect(dialog).toHaveCount(0);
  const panel = page.locator(".workspace-panel");
  await expect(panel).toBeVisible();
  await expect(surfaceTab(panel, "plan")).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveAttribute("data-active-workspace-tool", "plan");
  await expect(panel.getByRole("region", { name: "Implementation plan" })).toBeVisible();

  const gitDialog = await openPalette();
  const gitSearch = gitDialog.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
  await gitSearch.pressSequentially("git");
  await expect(gitSearch).toHaveValue("git");
  const git = gitDialog.getByRole("group", { name: "Git" });
  await expect(paletteOption(git, "Commit…")).toBeVisible();
  await expect(paletteOption(git, "Fetch")).toBeVisible();
  await expect(paletteOption(git, "Switch branch…")).toBeVisible();
  await capture(info, "palette-git-light");
  await page.keyboard.press("Escape");
  await expect(gitDialog).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

test("the open-surface shortcut opens the surface menu and its letters choose a surface", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "light");
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Plan");
  await expect(surfaceTab(panel, "plan")).toHaveAttribute("aria-selected", "true");

  await page.getByRole("textbox", { name: "Message", exact: true }).focus();
  await page.keyboard.press(`${PRIMARY}+G`);
  const menu = page.getByRole("menu", { name: "Add panel surface" });
  await expect(menu).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add panel surface" })).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem", { name: /^Files/u })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(
    document.activeElement?.closest('[role="menu"][aria-label="Add panel surface"]'),
  ))).toBe(true);
  await capture(info, "open-surface-menu-light");

  await page.keyboard.press("F");
  await expect(menu).toBeHidden();
  await expect(surfaceTab(panel, "files")).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveAttribute("data-active-workspace-tool", "files");
  expect(app.rendererErrors).toEqual([]);
});

test("Settings → Keyboard lists the open-surface shortcut", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "light");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("main", { name: "Settings" });
  await expect(settings).toBeVisible();
  const keyboard = page.getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Keyboard", exact: true });
  await keyboard.click();
  await expect(keyboard).toHaveAttribute("aria-current", "page");

  const row = page.locator('[data-setting-id="shortcut-open-surface"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("Open a surface");
  await expect(row.locator("kbd")).toHaveText(process.platform === "darwin" ? "⌘" : "Ctrl");
  const key = row.getByRole("combobox", { name: "Open a surface key" });
  await expect(key).toHaveValue("g");
  await expect(key.locator("option:checked")).toHaveText("G");
  await row.scrollIntoViewIfNeeded();
  await blurActiveElement();
  await capture(info, "keyboard-open-surface-light");

  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});

test("the Plan tab derives steps only from Plan-mode replies and never tracks them", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await setAppearanceInPlace(app, "light");
  const composer = page.getByRole("region", { name: "Message composer" });
  const mode = composer.getByRole("button", { name: /^Choose work mode/u });
  // With Workspace tools open the composer folds its settings into "More
  // composer options"; close the panel while using the mode control, as
  // plan-progress does, and reopen it to read the Plan tab.
  await closeWorkspaceTools(page);
  await expect(mode).toHaveAccessibleName(/Current mode: Build/u);

  await composer.getByRole("textbox", { name: "Message" }).fill("Make the workspace tools easier to find.");
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(BUILD_INTRO, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(turnModes).toEqual(["build"]);
  await expect(mode).toBeEnabled({ timeout: 30_000 });

  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Plan");
  const plan = panel.getByRole("region", { name: "Implementation plan" });
  await expect(plan.getByRole("heading", { level: 3, name: "No plan yet" })).toBeVisible();
  await expect(plan.locator(".plan-steps")).toHaveCount(0);
  await expect(plan.getByText("Derived from the reply", { exact: true })).toHaveCount(0);
  await expect(surfaceTab(panel, "plan")).toHaveAttribute("aria-label", "Plan");
  await expect(surfaceTab(panel, "plan").locator(".workspace-panel-badge")).toHaveCount(0);

  await closeWorkspaceTools(page);
  await mode.click();
  await page.getByRole("menu", { name: "Work mode" }).getByRole("menuitemradio", { name: /^Plan/u }).click();
  await expect(mode).toHaveAccessibleName(/Current mode: Plan/u);
  await composer.getByRole("textbox", { name: "Message" }).fill("Plan how to make the workspace tools easier to find.");
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(PLAN_INTRO, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(turnModes).toEqual(["build", "plan"]);
  await expect(mode).toBeEnabled({ timeout: 30_000 });
  // Let the turn's change summary settle so both captures show the same transcript.
  await expect(page.getByText("Capturing changes…", { exact: true })).toHaveCount(0, { timeout: 30_000 });
  await ensureWorkspaceTools(page);

  await selectWorkspaceTool(panel, "Plan");
  await expect(plan.getByText("Derived from the reply", { exact: true })).toBeVisible();
  await expect(plan.locator(".plan-source-note")).toContainText("The provider didn't report a plan.");
  await expect(plan.locator(".plan-source-note")).toContainText("aren't tracked");
  const steps = plan.locator(".plan-steps > li");
  await expect(steps.locator(".plan-step-title")).toHaveText(PLAN_STEPS.map((step, index) => `${index + 1}. ${step}`));
  await expect.poll(() => steps.evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-plan-step-status")))).toEqual(PLAN_STEPS.map(() => "pending"));
  await expect(plan.locator('[data-plan-step-status="completed"]')).toHaveCount(0);
  await expect(plan.getByText(/\d+ of \d+ complete/u)).toHaveCount(0);
  await expect(surfaceTab(panel, "plan")).toHaveAttribute("aria-label", "Plan");
  await expect(surfaceTab(panel, "plan").locator(".workspace-panel-badge")).toHaveCount(0);

  await blurActiveElement();
  await app.expectNoViewportOverflow();
  await capture(info, "plan-derived-light");
  await setAppearanceInPlace(app, "dark");
  await expect(plan.getByText("Derived from the reply", { exact: true })).toBeVisible();
  await app.expectNoViewportOverflow();
  await capture(info, "plan-derived-dark");
  await setAppearanceInPlace(app, "light");
  expect(app.rendererErrors).toEqual([]);
});

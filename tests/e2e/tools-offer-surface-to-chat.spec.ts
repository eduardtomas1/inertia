// @inertia-e2e-resource primary-display
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { closeWorkspaceTools, ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const FIXED_NOW = Date.parse("2026-10-19T12:00:00.000Z");
const PRIMARY = process.platform === "darwin" ? "Meta" : "Control";
const BUILD_INTRO = "Build finished. I changed three things:";
const BUILD_STEPS = [
  "Linked file paths in the terminal",
  "Added line selection to the file preview",
  "Offered tasks from chat messages",
];
const PLAN_INTRO = "Here is how I would connect the surfaces to the chat:";
const PLAN_STEPS = [
  "Send terminal selections to the prompt",
  "Ask about selected lines in Files",
  "Create tasks from plan steps",
];
const reply = (intro: string, steps: readonly string[]): string =>
  [intro, "", ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n");

// A dedicated, untracked source file gives content search a term that no
// other fixture file contains and gives line selection a known excerpt.
const NOTES_PATH = "src/surface-notes.ts";
const SEARCH_TERM = "tidewater";
const NOTES_LINES = [
  "// Surfaces that hand context back to the chat.",
  "export const tidewaterSurfaces = [\"Files\", \"Terminal\", \"Tasks\"];",
  "export const tidewaterReady = true;",
  "export const unrelated = 0;",
];
const TERMINAL_MARKER = "Inertia terminal link check";

const surfaceAppServer = `
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const buildReply = ${JSON.stringify(reply(BUILD_INTRO, BUILD_STEPS))};
const planReply = ${JSON.stringify(reply(PLAN_INTRO, PLAN_STEPS))};
let threadId = "surface-to-chat-thread";
let turnSequence = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "surface-to-chat-fixture" } });
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
  const turnId = "surface-to-chat-turn-" + turnSequence;
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
    name: "surface-to-chat",
    initialState: "conversation",
    codexAppServerSource: surfaceAppServer,
    beforeLaunch: async ({ workspaceDirectory }) => {
      await mkdir(join(workspaceDirectory, "src"), { recursive: true });
      await writeFile(join(workspaceDirectory, NOTES_PATH), `${NOTES_LINES.join("\n")}\n`, "utf8");
    },
  });
  await app.page.clock.setFixedTime(FIXED_NOW);
  // Native menus cannot be read from the renderer: record each popup in the
  // main process and choose its items there, as edit-context-menu does.
  await app.electronApp.evaluate(({ Menu }) => {
    Reflect.set(globalThis, "surfaceToChatMenus", []);
    Menu.prototype.popup = function (options) {
      (Reflect.get(globalThis, "surfaceToChatMenus") as Electron.Menu[]).push(this);
      Reflect.set(globalThis, "surfaceToChatMenuWindow", options?.window);
    };
  });
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

function composerInput(): Locator {
  return app.page.getByRole("region", { name: "Message composer" }).getByRole("textbox", { name: "Message", exact: true });
}

async function clearComposer(): Promise<void> {
  await composerInput().fill("");
  await expect(composerInput()).toHaveValue("");
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

function nativeMenuCount(): Promise<number> {
  return app.electronApp.evaluate(() =>
    (Reflect.get(globalThis, "surfaceToChatMenus") as Electron.Menu[]).length);
}

function nativeMenuLabels(): Promise<string[]> {
  return app.electronApp.evaluate(() => {
    const menu = (Reflect.get(globalThis, "surfaceToChatMenus") as Electron.Menu[]).at(-1);
    return (menu?.items ?? [])
      .filter((item) => item.type !== "separator" && item.label !== "Inspect element")
      .map((item) => item.label);
  });
}

async function chooseNativeMenuItem(label: string): Promise<void> {
  await app.electronApp.evaluate((_electron, wanted) => {
    const menu = (Reflect.get(globalThis, "surfaceToChatMenus") as Electron.Menu[]).at(-1);
    const item = menu?.items.find((entry) => entry.label === wanted);
    if (!item?.enabled) throw new Error(`The native "${wanted}" item is unavailable.`);
    const window = Reflect.get(globalThis, "surfaceToChatMenuWindow") as Electron.BrowserWindow;
    item.click({} as Electron.KeyboardEvent, window, window.webContents);
  }, label);
}

async function sendTurn(mode: "Build" | "Plan", text: string, expectedModes: string[]): Promise<void> {
  const page = app.page;
  const composer = page.getByRole("region", { name: "Message composer" });
  const modeButton = composer.getByRole("button", { name: /^Choose work mode/u });
  // With Workspace tools open the composer folds its mode control into
  // "More composer options"; close the panel while choosing the mode.
  await closeWorkspaceTools(page);
  await expect(modeButton).toBeEnabled({ timeout: 30_000 });
  if (!(await modeButton.getAttribute("aria-label"))?.includes(`Current mode: ${mode}`)) {
    await modeButton.click();
    await page.getByRole("menu", { name: "Work mode" }).getByRole("menuitemradio", { name: new RegExp(`^${mode}`, "u") }).click();
  }
  await expect(modeButton).toHaveAccessibleName(new RegExp(`Current mode: ${mode}`, "u"));
  await composerInput().fill(text);
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect.poll(turnModes).toEqual(expectedModes);
  await expect(modeButton).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText("Capturing changes…", { exact: true })).toHaveCount(0, { timeout: 30_000 });
}

function taskNotice(): Locator {
  return app.page.locator(".task-created-notice");
}

test("Files searches contents and adds a selected line range to the prompt", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await setAppearanceInPlace(app, "light");
  await clearComposer();
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Files");
  const files = panel.getByRole("region", { name: "Project files" });
  await expect(files).toBeVisible();
  const showExplorer = files.getByRole("button", { name: "Show file explorer" });
  if (await showExplorer.isVisible().catch(() => false)) await showExplorer.click();

  const searchIn = files.getByRole("group", { name: "Search in" });
  await expect(searchIn.getByRole("button", { name: "Names", exact: true })).toHaveAttribute("aria-pressed", "true");
  await searchIn.getByRole("button", { name: "Contents", exact: true }).click();
  await expect(searchIn.getByRole("button", { name: "Contents", exact: true })).toHaveAttribute("aria-pressed", "true");
  const search = files.getByRole("searchbox", { name: "Search file contents" });
  await expect(search).toHaveAttribute("placeholder", "Search in files");
  await search.fill(SEARCH_TERM);

  const results = files.getByRole("list", { name: "Content search results" });
  await expect(results).toHaveAttribute("aria-busy", "false");
  const rows = results.getByRole("button");
  await expect(rows).toHaveCount(2);
  const first = results.getByRole("button", { name: `${NOTES_PATH}, line 2: ${NOTES_LINES[1]}`, exact: true });
  await expect(first).toBeVisible();
  await expect(first.locator(".file-content-result-location")).toContainText("surface-notes.ts");
  await expect(first.locator(".file-content-result-line")).toHaveText("Line 2");
  await expect(first.locator(".file-content-result-location")).toContainText("src");
  await expect(files.getByText(`2 matches for “${SEARCH_TERM}”`)).toBeVisible();
  await expect(first.locator(".file-content-result-snippet")).toHaveText(NOTES_LINES[1]!);
  await expect(first.locator(".file-content-result-snippet mark")).toHaveText(SEARCH_TERM);
  await expect(results.getByRole("button", { name: `${NOTES_PATH}, line 3: ${NOTES_LINES[2]}`, exact: true })).toBeVisible();
  await search.blur();
  await capture(info, "files-content-search-light");
  await setAppearanceInPlace(app, "dark");
  await expect(first).toBeVisible();
  await capture(info, "files-content-search-dark");
  await setAppearanceInPlace(app, "light");

  await first.click();
  const code = files.getByLabel(`Contents of ${NOTES_PATH}`, { exact: true });
  await expect(code).toBeVisible();
  await expect(files.locator(".file-preview-line.is-referenced")).toHaveAttribute("data-source-line", "2");
  await code.getByRole("button", { name: "Select line 1", exact: true }).click();
  await code.getByRole("button", { name: "Select line 3", exact: true }).click({ modifiers: ["Shift"] });
  await expect(code.getByRole("button", { name: /^Select line \d+$/u, pressed: true })).toHaveCount(3);
  const popover = files.getByRole("toolbar", { name: `Selected lines 1-3 of ${NOTES_PATH}` });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Lines 1-3");
  await expect(popover.getByRole("button", { name: "Ask about", exact: true })).toBeVisible();
  await expect(popover.getByRole("button", { name: "Add to prompt", exact: true })).toBeVisible();
  await capture(info, "files-line-selection-light");

  await popover.getByRole("button", { name: "Add to prompt", exact: true }).click();
  await expect(popover).toBeHidden();
  await expect(composerInput()).toHaveValue([
    `${NOTES_PATH} lines 1-3:`,
    "```",
    ...NOTES_LINES.slice(0, 3),
    "```",
  ].join("\n"));
  await expect(composerInput()).toBeFocused();
  await clearComposer();
  expect(app.rendererErrors).toEqual([]);
});

test("the terminal adds a selection to the prompt and finds text with the find bar", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await setAppearanceInPlace(app, "light");
  await clearComposer();
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Terminal");
  const surface = page.locator(".terminal-surface-slot");
  const session = surface.locator(".terminal-session-slot:not([hidden]) .terminal-panel");
  await expect(session).toHaveAttribute("data-terminal-state", "ready");
  const add = page.getByRole("button", { name: "Add selection to prompt", exact: true });
  await expect(add).toBeDisabled();
  await expect(page.getByRole("button", { name: "Find in terminal", exact: true })).toBeVisible();

  // Drive the real pty. The typed command never contains the marker as one
  // run of text, so the row that ends with it is the shell's output (a
  // redrawn prompt may share that row).
  const input = session.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.insertText(process.platform === "win32"
    ? `echo ${TERMINAL_MARKER}`
    : `printf '%s %s\\n' 'Inertia terminal' 'link check'`);
  await page.keyboard.press("Enter");
  const rows = session.locator(".xterm-rows > div");
  const outputRow = async (): Promise<{ row: number; column: number }> => await rows.evaluateAll((elements, marker) => {
    const texts = elements.map((element) => (element.textContent ?? "").replace(/\u00a0/gu, " ").trimEnd());
    const row = texts.findIndex((text) => text.endsWith(marker) && !text.includes("printf") && !text.includes("echo"));
    return { row, column: row < 0 ? -1 : texts[row]!.length - marker.length };
  }, TERMINAL_MARKER);
  await expect.poll(async () => (await outputRow()).row, { timeout: 30_000 }).toBeGreaterThanOrEqual(0);

  // Select the marker with the pointer, as a person would: from its first
  // cell to the end of the row, whose trailing blanks the excerpt drops.
  const { row, column } = await outputRow();
  const cellWidth = await session.locator(".xterm-char-measure-element").first()
    .evaluate((element) => element.getBoundingClientRect().width / (element.textContent ?? "").length);
  const box = (await rows.nth(row).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + column * cellWidth + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 4 });
  await page.mouse.move(box.x + box.width - 2, y, { steps: 4 });
  await page.mouse.up();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(composerInput()).toHaveValue(/^Terminal output \(Terminal 1\):\n```text\n/u);
  await expect(composerInput()).toHaveValue(
    `Terminal output (Terminal 1):\n\`\`\`text\n${TERMINAL_MARKER}\n\`\`\``,
  );
  await capture(info, "terminal-add-selection-light");

  await input.focus();
  await page.keyboard.press(`${PRIMARY}+F`);
  const findBar = surface.getByRole("search", { name: "Terminal find" });
  const find = findBar.getByRole("textbox", { name: "Find in terminal" });
  await expect(find).toBeVisible();
  await expect(find).toBeFocused();
  await find.pressSequentially("link check");
  await expect(find).toHaveValue("link check");
  await expect(findBar.getByText("No matches", { exact: true })).toHaveCount(0);
  await expect(findBar.getByRole("button", { name: "Next match", exact: true })).toBeEnabled();
  await capture(info, "terminal-find-light");
  await page.keyboard.press("Escape");
  await expect(findBar).toHaveCount(0);
  await clearComposer();
  expect(app.rendererErrors).toEqual([]);
});

test("tasks are created from a chat message and from a plan step", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await setAppearanceInPlace(app, "light");
  await clearComposer();
  await sendTurn("Build", "Connect the surfaces to the chat.", ["build"]);

  const answer = page.getByRole("article", { name: "Final assistant answer" }).filter({ hasText: BUILD_INTRO }).last();
  await expect(answer).toBeVisible();
  const before = await nativeMenuCount();
  await answer.getByText(BUILD_INTRO, { exact: true }).click({ button: "right" });
  await expect.poll(nativeMenuCount).toBe(before + 1);
  expect(await nativeMenuLabels()).toEqual(["Copy message", "Copy as Markdown", "Create task from message"]);
  await chooseNativeMenuItem("Create task from message");

  const notice = taskNotice();
  await expect(notice).toBeVisible();
  await expect(notice).toHaveRole("status");
  await expect(notice.getByText("Task created", { exact: true })).toBeVisible();
  await expect(notice.getByText(BUILD_INTRO, { exact: true })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Open tasks", exact: true })).toBeVisible();
  await capture(info, "task-created-notice-light");

  await notice.getByRole("button", { name: "Open tasks", exact: true }).click();
  await expect(notice).toHaveCount(0);
  const view = page.getByRole("main", { name: "Tasks" });
  await expect(view).toBeVisible();
  const row = view.locator(".task-row", { hasText: BUILD_INTRO });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("checkbox", { name: BUILD_INTRO, exact: true })).not.toBeChecked();
  await expect(row.locator(".task-status")).toHaveText("Done");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.expectNoViewportOverflow();
  await capture(info, "tasks-from-chat-light");

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(view).toBeHidden();
  await expect(composerInput()).toBeVisible();

  await sendTurn("Plan", "Plan how to connect the surfaces to the chat.", ["build", "plan"]);
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Plan");
  const plan = panel.getByRole("region", { name: "Implementation plan" });
  await expect(plan.locator(".plan-steps > li .plan-step-title"))
    .toHaveText(PLAN_STEPS.map((step, index) => `${index + 1}. ${step}`));
  const stepOne = plan.locator(".plan-steps > li").first();
  await stepOne.hover();
  const createTask = stepOne.getByRole("button", { name: `Create task from step 1: ${PLAN_STEPS[0]}`, exact: true });
  await expect(createTask).toBeVisible();
  await createTask.click();
  await expect(notice).toBeVisible();
  await expect(notice.getByText("Task created", { exact: true })).toBeVisible();
  await expect(notice.getByText(PLAN_STEPS[0]!, { exact: true })).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss task confirmation" }).click();
  await expect(notice).toHaveCount(0);

  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const tasks = database.prepare(`
      SELECT todos.title AS title, todos.note AS note, conversations.title AS chat
      FROM todos JOIN conversations ON conversations.id = todos.conversation_id
      ORDER BY todos.created_at, todos.title
    `).all() as Array<{ title: string; note: string; chat: string }>;
    expect(tasks.map(({ title }) => title)).toEqual([BUILD_INTRO, PLAN_STEPS[0]]);
    expect(tasks[0]!.note).toContain(BUILD_STEPS[0]);
    expect(tasks[1]!.note).toMatch(/^From the plan in /u);
  } finally {
    database.close();
  }

  // Leave the composer in Build for the next scenario.
  await closeWorkspaceTools(page);
  const modeButton = page.getByRole("region", { name: "Message composer" }).getByRole("button", { name: /^Choose work mode/u });
  await modeButton.click();
  await page.getByRole("menu", { name: "Work mode" }).getByRole("menuitemradio", { name: /^Build/u }).click();
  await expect(modeButton).toHaveAccessibleName(/Current mode: Build/u);
  expect(app.rendererErrors).toEqual([]);
});

test("Attachments filters sent files and re-attaches one to the message", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await setAppearanceInPlace(app, "light");
  await clearComposer();
  await closeWorkspaceTools(page);
  const composer = page.getByRole("region", { name: "Message composer" });
  const pending = page.getByRole("list", { name: "Attachments", exact: true });

  await app.electronApp.evaluate(({ dialog }, paths) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: paths, bookmarks: [] }));
  }, [app.attachmentImagePath]);
  await composer.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
  await expect(pending.getByText("preview.png", { exact: true })).toBeVisible();
  const modes = turnModes();
  await composerInput().fill("Here is the surface screenshot.");
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(pending).toHaveCount(0);
  await expect.poll(turnModes).toEqual([...modes, "build"]);
  await expect(page.getByRole("list", { name: "Request attachments", exact: true })
    .getByRole("button", { name: "Preview attachment preview.png" })).toBeVisible();
  await expect(composer).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  await expect(page.getByText("Capturing changes…", { exact: true })).toHaveCount(0, { timeout: 30_000 });

  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Attachments");
  const surface = panel.getByRole("region", { name: "Attachments" });
  await expect(surface.getByRole("heading", { name: "1 attachment" })).toBeVisible();
  const filters = surface.getByRole("group", { name: "Show attachments" });
  await expect(filters.getByRole("button")).toHaveText(["All", "Images", "Documents", "Text"]);
  await expect(filters.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  const gallery = surface.getByRole("list", { name: "Chat attachments" });
  await filters.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(filters.getByRole("button", { name: "Documents", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(gallery).toHaveCount(0);
  await filters.getByRole("button", { name: "Images", exact: true }).click();
  await expect(filters.getByRole("button", { name: "Images", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(gallery.getByRole("button", { name: "Preview attachment preview.png" })).toBeVisible();

  const reattach = surface.getByRole("button", { name: "Re-attach preview.png to the message", exact: true });
  await expect(reattach).toBeEnabled();
  await expect(reattach).toHaveText("Re-attach");
  await reattach.click();
  await expect(surface.locator(".attachments-surface-status")).toHaveText("Added preview.png to the message.");
  await expect(pending.getByText("preview.png", { exact: true })).toBeVisible();
  await expect(pending.locator('[data-attachment-pending="true"]')).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Remove attachment preview.png" })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await capture(info, "attachments-reattach-light");

  await composer.getByRole("button", { name: "Remove attachment preview.png" }).click();
  await expect(pending).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

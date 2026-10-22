// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const FIXED_NOW = Date.parse("2026-10-12T12:00:00.000Z");
const ANSWER = "Removed the CleanShot files from Downloads.";
const TURN_GATE = "tasks-turn-complete";
const FAIL_ONCE_TITLE = "Rebuild the flaky export";
const FAILED_ONCE = "tasks-failed-once";
const FAILURE = "The export script crashed.";

const tasksAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadSequence = 0;
let turnSequence = 0;
const completeWhenReleased = (threadId, turnId) => {
  if (!fs.existsSync(path.join(process.cwd(), ".git", ${JSON.stringify(TURN_GATE)}))) {
    setTimeout(() => completeWhenReleased(threadId, turnId), 50);
    return;
  }
  send({ method: "turn/completed", params: {
    threadId,
    turn: { id: turnId, status: "completed", items: [], error: null },
  } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "tasks-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal: null } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadSequence += 1;
    const threadId = message.params.threadId || "tasks-thread-" + process.pid + "-" + threadSequence;
    send({ id: message.id, result: {
      thread: { id: threadId }, cwd: process.cwd(), model: "fixture",
      serviceTier: null, initialTurnsPage: null,
    } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const threadId = message.params.threadId;
  const turnId = "tasks-turn-" + process.pid + "-" + turnSequence;
  send({ id: message.id, result: {
    turn: { id: turnId, status: "inProgress", items: [], error: null },
  } });
  send({ method: "turn/started", params: {
    threadId,
    turn: { id: turnId, status: "inProgress", items: [], error: null },
  } });
  const prompt = (message.params.input || []).filter((item) => item.type === "text")
    .map((item) => item.text).join("\\n");
  const failedOnce = path.join(process.cwd(), ".git", ${JSON.stringify(FAILED_ONCE)});
  if (prompt.includes(${JSON.stringify(FAIL_ONCE_TITLE)}) && !fs.existsSync(failedOnce)) {
    fs.writeFileSync(failedOnce, "failed");
    send({ method: "turn/completed", params: {
      threadId,
      turn: { id: turnId, status: "failed", items: [], error: { message: ${JSON.stringify(FAILURE)} } },
    } });
    return;
  }
  send({ method: "item/agentMessage/delta", params: {
    threadId, turnId, itemId: "tasks-answer", delta: ${JSON.stringify(ANSWER)},
  } });
  completeWhenReleased(threadId, turnId);
});
`;

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "tasks", initialState: "conversation", codexAppServerSource: tasksAppServer });
  const session = await app.page.context().newCDPSession(app.page);
  await session.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app.close();
});

async function capture(info: TestInfo, name: string, clip?: Locator): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await app.page.mouse.move(0, 0);
  const box = clip ? await clip.boundingBox() : null;
  await app.page.screenshot({
    path,
    animations: "disabled",
    ...(box ? { clip: { x: 0, y: 0, width: box.x + box.width, height: box.y + box.height + 12 } } : {}),
  });
  await info.attach(name, { path, contentType: "image/png" });
}

function expectWithinPixel(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

async function expectTasksRowBetweenNewChatAndSearch(tasks: Locator): Promise<void> {
  const sidebar = app.page.locator(".sidebar");
  const newChat = await sidebar.locator(".sidebar-primary-row").getByRole("button", { name: "New chat", exact: true }).boundingBox();
  const row = await tasks.boundingBox();
  const search = await sidebar.locator(".sidebar-search-wrap").boundingBox();
  expectWithinPixel(row!.height, newChat!.height);
  expectWithinPixel(row!.x, newChat!.x);
  expectWithinPixel(row!.x + row!.width, search!.x + search!.width);
  expectWithinPixel(row!.y, newChat!.y + newChat!.height + 2);
  expectWithinPixel(search!.y, row!.y + row!.height + 2);
}

async function expectAlignedHandOff(agent: Locator): Promise<void> {
  const boxes = await agent.locator(".selected-model-chip, .task-handoff-control").evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        top: Math.round(bounds.top),
        height: Math.round(bounds.height),
      };
    }));
  const [model, reasoning, ...rest] = boxes;
  const speed = rest.length === 3 ? rest.shift() : undefined;
  const [project, folder] = rest;
  expect(model && reasoning && project && folder).toBeTruthy();
  for (const { height } of boxes) expectWithinPixel(height, model!.height);
  expectWithinPixel(project!.left, model!.left);
  expectWithinPixel(folder!.right, model!.right);
  expectWithinPixel(project!.top, folder!.top);
  expectWithinPixel(project!.right - project!.left, folder!.right - folder!.left);
  expectWithinPixel(reasoning!.left, model!.left);
  if (speed) {
    expectWithinPixel(speed.right, model!.right);
    expectWithinPixel(speed.top, reasoning!.top);
  } else {
    expectWithinPixel(reasoning!.right, model!.right);
  }
}

test("adds, orders, schedules and finishes tasks from the sidebar", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  const destination = page.locator(".sidebar").getByRole("button", { name: "Tasks", exact: true });
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  await expectTasksRowBetweenNewChatAndSearch(destination);
  const view = page.getByRole("main", { name: "Tasks" });
  await expect(view.getByText("Add anything you need to do", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-header")).toContainText("Tasks");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await app.expectNoViewportOverflow();
    await capture(info, `tasks-empty-${theme}`);
  }
  await capture(info, "tasks-sidebar-button-light", page.locator(".sidebar-project-navigation"));

  const add = view.getByRole("textbox", { name: "Add a task" });
  await add.fill("Implement remote control");
  await add.press("Enter");
  await expect(add).toHaveValue("");
  await expect(add).toBeFocused();
  await add.fill("Clean the downloads folder");
  await add.press("Enter");
  await expect(view.getByText("2 to do", { exact: true })).toBeVisible();
  const list = view.getByRole("list", { name: "To do" });
  await expect(list.getByRole("checkbox")).toHaveCount(2);
  await expect(list.getByRole("checkbox").first()).toHaveAttribute("aria-label", "Mark as done: Implement remote control");

  await view.getByRole("button", { name: /^Clean the downloads folder/u }).click();
  const detail = view.getByRole("complementary", { name: "Task details" });
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue("Clean the downloads folder");
  const agent = detail.getByRole("group", { name: "Hand it to an agent" });
  await expect(agent).toBeVisible();

  await detail.getByRole("button", { name: "Priority", exact: true }).click();
  await capture(info, "tasks-priority-menu-light");
  await page.getByRole("menu", { name: "Priority" }).getByRole("menuitemradio", { name: "Urgent", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  await expect(list.getByRole("checkbox").first()).toHaveAttribute("aria-label", "Mark as done: Clean the downloads folder");
  await expect(list.locator(".task-row").first().locator(".task-urgent")).toBeVisible();

  await detail.getByRole("button", { name: "Due date", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Due" });
  await expect(picker).toBeVisible();
  await expect(page.getByRole("menu", { name: "Due date" })).toHaveCount(0);
  await picker.getByRole("button", { name: "Tomorrow, Tue 13 Oct", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(detail.getByRole("button", { name: "Due date: Tomorrow" })).toBeVisible();
  await expect(list.locator(".task-row").first()).toContainText("Tomorrow");
  await expect(list.getByRole("checkbox").first())
    .toHaveAttribute("aria-label", "Mark as done: Clean the downloads folder (Tomorrow)");

  const note = detail.getByRole("textbox", { name: "Note" });
  await note.fill("Only the CleanShot files");
  await note.press("Tab");
  await detail.getByRole("button", { name: "Close task details" }).click();
  await expect(detail).toBeHidden();
  await expect(view.locator(".task-detail")).toHaveCount(0);
  await view.getByRole("button", { name: /^Clean the downloads folder/u }).click();
  await expect(detail.getByRole("textbox", { name: "Note" })).toHaveValue("Only the CleanShot files");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await app.expectNoViewportOverflow();
    await expectAlignedHandOff(agent);
    await capture(info, `tasks-list-detail-${theme}-1440x1100`);
  }

  await app.resizeWindow(760, 600);
  await expect(detail).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await app.expectNoViewportOverflow();
    await expectAlignedHandOff(agent);
    await capture(info, `tasks-detail-${theme}-760x600`);
  }

  await app.resizeWindow(1440, 1100);
  await view.getByRole("checkbox", { name: "Mark as done: Implement remote control" }).click();
  await expect(view.getByText("1 to do", { exact: true })).toBeVisible();
  const done = view.getByRole("button", { name: "Done 1", exact: true });
  await expect(done).toHaveAttribute("aria-expanded", "false");
  await done.click();
  await expect(view.getByRole("list", { name: "Done" }).getByRole("checkbox", { name: "Mark as not done: Implement remote control" })).toBeChecked();
  await setAppearanceInPlace(app, "dark");
  await capture(info, "tasks-done-dark");
  await setAppearanceInPlace(app, "light");

  await view.locator(".task-row").first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Clean the downloads folder" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Rename", "Hand to agent…", "Mark as done", "Delete"]);
  await capture(info, "tasks-row-menu-light");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  expect(app.rendererErrors).toEqual([]);
});

interface TodoRow {
  conversationId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  completedAt: string | null;
}

function readTodo(title: string): TodoRow {
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`
      SELECT conversation_id AS conversationId, due_date AS dueDate, due_time AS dueTime, completed_at AS completedAt
      FROM todos WHERE title = ?
    `).get(title) as TodoRow;
  } finally {
    database.close();
  }
}

function conversationExists(conversationId: string): boolean {
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return (database.prepare("SELECT COUNT(*) AS count FROM conversations WHERE id = ?").get(conversationId) as { count: number }).count === 1;
  } finally {
    database.close();
  }
}

async function openTasksWithNewTask(title: string): Promise<{ view: Locator; detail: Locator; row: Locator; destination: Locator }> {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  const view = page.getByRole("main", { name: "Tasks" });
  const detail = view.getByRole("complementary", { name: "Task details" });
  const destination = page.locator(".sidebar .sidebar-tasks-action");
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  const add = view.getByRole("textbox", { name: "Add a task" });
  await add.fill(title);
  await add.press("Enter");
  const row = view.locator(".task-row", { hasText: title });
  await row.getByRole("button", { name: new RegExp(`^${title}`, "u") }).click();
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue(title);
  return { view, detail, row, destination };
}

test("Start hands the task to an agent and keeps you in Tasks", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  const title = "Sort the CleanShot captures";
  const { view, detail, row, destination } = await openTasksWithNewTask(title);
  const note = detail.getByRole("textbox", { name: "Note" });
  await note.fill("Only the CleanShot files");
  await note.press("Tab");
  await detail.getByRole("group", { name: "Hand it to an agent" }).getByRole("button", { name: "Start", exact: true }).click();

  const word = row.locator(".task-status");
  const openChat = detail.getByRole("button", { name: "Open chat", exact: true });
  await expect(word).toHaveText("Working…");
  await expect(word).toHaveClass(/\bis-live\b/u);
  await expect(view).toBeVisible();
  await expect(page.locator(".workspace-header")).toContainText("Tasks");
  await expect(row.getByRole("checkbox")).toHaveAttribute("aria-label", `Mark as done: ${title} (Working…)`);
  await expect(detail.getByRole("group", { name: "Hand it to an agent" })).toHaveCount(0);
  await expect(detail.locator(".task-well-headline")).toHaveText(/ is working on it$/u);
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(openChat).not.toHaveAttribute("aria-disabled", "true");
  await expect(openChat).toBeFocused();

  const conversationId = readTodo(title).conversationId!;
  expect(conversationId).toBeTruthy();
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const first = database.prepare(`
      SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1
    `).get(conversationId) as { content: string };
    expect(first.content).toBe(`${title}\n\nOnly the CleanShot files`);
  } finally {
    database.close();
  }

  await expect(destination).toHaveAccessibleName("Tasks");
  await writeFile(join(app.workspaceDirectory, ".git", TURN_GATE), "go");
  await expect(word).toHaveText("Ready for you");
  await expect(word).toHaveClass(/\bis-completed\b/u);
  await expect(word).not.toHaveClass(/\bis-live\b/u);
  await expect(row.getByRole("checkbox")).toHaveAttribute("aria-label", `Mark as done: ${title} (Ready for you)`);
  await expect(detail.locator(".task-well-headline")).toHaveText(/^Finished/u);
  await expect(detail.getByRole("button", { name: "Mark as done", exact: true })).toBeVisible();
  await expect(view.locator(".tasks-heading p")).toHaveText(/^1 needs you\b/u);
  await expect(destination).toHaveAccessibleName("Tasks, 1 needs you");
  await expect(destination.locator(".sidebar-tasks-count")).toHaveText("1");
  await expectTasksRowBetweenNewChatAndSearch(destination);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.expectNoViewportOverflow();
  await capture(info, "tasks-started-light");

  await openChat.click();
  await expect(view).toBeHidden();
  const heading = page.getByRole("heading", { name: title, level: 1 });
  await expect(heading).toBeVisible();
  const userMessages = page.locator(".message.is-user");
  await expect(userMessages).toHaveCount(1);
  await expect(userMessages.first()).toContainText(title);
  await expect(userMessages.first()).toContainText("Only the CleanShot files");
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  const taskLink = page.locator(".workspace-header").getByRole("button", { name: "Task", exact: true });
  await expect(taskLink).toHaveAccessibleDescription(title);
  await taskLink.click();
  await expect(view).toBeVisible();
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue(title);

  await detail.getByRole("button", { name: "Mark as done", exact: true }).click();
  const open = view.getByRole("list", { name: "To do" });
  await expect(open.locator(".task-row", { hasText: title })).toHaveCount(0);
  const doneToggle = view.locator(".tasks-done-toggle");
  if (await doneToggle.getAttribute("aria-expanded") === "false") await doneToggle.click();
  const doneList = view.getByRole("list", { name: "Done" });
  await expect(doneList.getByRole("checkbox", { name: `Mark as not done: ${title}` })).toBeChecked();
  await expect(destination).toHaveAccessibleName("Tasks");
  await expect(detail.locator(".task-well-headline")).toHaveText(/^Done · /u);
  expect(readTodo(title).completedAt).not.toBeNull();
  await detail.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(word).toHaveText("Ready for you");
  await expect(doneList.locator(".task-row", { hasText: title })).toHaveCount(0);
  expect(readTodo(title).completedAt).toBeNull();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator(".activity-thread-select", { hasText: title }).first().click({ button: "right" });
  await page.getByRole("menu", { name: `Thread actions for ${title}` }).getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.locator(".activity-thread-select", { hasText: title })).toHaveCount(0);
  await expect(view).toBeVisible();
  await expect(word).toHaveCount(0);
  await row.getByRole("button", { name: new RegExp(`^${title}`, "u") }).click();
  await expect(detail.getByRole("group", { name: "Hand it to an agent" })).toBeVisible();
  await expect(openChat).toHaveCount(0);
  expect(readTodo(title).conversationId).toBeNull();
  expect(conversationExists(conversationId)).toBe(false);
  expect(app.rendererErrors).toEqual([]);
});

test("Try again hands a failed task to a second chat", async ({ browserName: _browserName }) => {
  const page = app.page;
  const { view, detail, row, destination } = await openTasksWithNewTask(FAIL_ONCE_TITLE);
  await detail.getByRole("group", { name: "Hand it to an agent" }).getByRole("button", { name: "Start", exact: true }).click();
  const word = row.locator(".task-status");
  await expect(word).toHaveText("Failed");
  await expect(word).toHaveClass(/\bis-failed\b/u);
  await expect(view).toBeVisible();
  await expect(detail.locator(".task-well-headline")).toHaveText("Failed");
  await expect(destination).toHaveAccessibleName(/^Tasks, \d+ needs? you$/u);
  const failedChat = readTodo(FAIL_ONCE_TITLE).conversationId!;
  expect(failedChat).toBeTruthy();

  await detail.getByRole("button", { name: "Try again", exact: true }).click();
  const handOff = detail.getByRole("group", { name: "Hand it to an agent" });
  await expect(handOff).toBeVisible();
  await expect(detail.locator(".task-well-headline")).toHaveText("Failed");
  const start = handOff.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeFocused();
  await writeFile(join(app.workspaceDirectory, ".git", TURN_GATE), "go");
  await start.click();

  await expect(word).toHaveText("Ready for you");
  await expect(handOff).toHaveCount(0);
  const secondChat = readTodo(FAIL_ONCE_TITLE).conversationId!;
  expect(secondChat).toBeTruthy();
  expect(secondChat).not.toBe(failedChat);
  expect(conversationExists(failedChat)).toBe(true);
  await expect(page.locator(".activity-thread-select", { hasText: FAIL_ONCE_TITLE })).toHaveCount(2);
  await detail.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(view).toBeHidden();
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-header").getByRole("button", { name: "Task", exact: true }))
    .toHaveAccessibleDescription(FAIL_ONCE_TITLE);
  expect(app.rendererErrors).toEqual([]);
});

test("the due picker sets a day and a time", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  const title = "Book the dentist";
  const { view, detail, row } = await openTasksWithNewTask(title);
  const chip = detail.getByRole("button", { name: "Due date", exact: true });
  await chip.click();
  const picker = page.getByRole("dialog", { name: "Due" });
  await expect(picker).toBeVisible();
  const box = (await picker.boundingBox())!;
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expectWithinPixel(box.x + box.width / 2, viewport.width / 2);
  expect(box.y).toBeGreaterThan(0);
  expect(box.y + box.height).toBeLessThan(viewport.height);
  await expect(picker.getByRole("grid", { name: "October 2026" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Monday 12 October 2026", exact: true })).toBeFocused();
  const time = picker.getByRole("textbox", { name: "Time" });
  await expect(time).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(chip).toBeFocused();
  expect(readTodo(title).dueDate).toBeNull();

  await chip.click();
  await picker.getByRole("button", { name: "Friday 16 October 2026", exact: true }).click();
  await expect(time).toBeEnabled();
  await time.fill("15:00");
  await capture(info, "tasks-due-picker-light");
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await expect(picker).toBeHidden();

  const label = /^Fri 3:00\sPM$/u;
  await expect(row.locator(".task-due")).toHaveText(label);
  await expect(detail.locator(".task-chip").first()).toHaveText(label);
  await expect(row.getByRole("checkbox")).toHaveAttribute("aria-label", /^Mark as done: Book the dentist \(Fri 3:00\sPM\)$/u);
  await expect.poll(() => readTodo(title)).toMatchObject({ dueDate: "2026-10-16", dueTime: "15:00" });

  await detail.getByRole("button", { name: /^Due date: Fri/u }).click();
  await expect(picker.getByRole("button", { name: "Friday 16 October 2026", exact: true })).toBeFocused();
  await expect(time).toHaveValue(/^3:00\sPM$/u);
  await time.fill("25:00");
  await time.press("Enter");
  await expect(picker.getByRole("alert")).toHaveText("Use a time like 15:00");
  await expect(picker.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
  await picker.getByRole("button", { name: "Clear time", exact: true }).click();
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await expect(row.locator(".task-due")).toHaveText("Fri");
  await expect.poll(() => readTodo(title)).toMatchObject({ dueDate: "2026-10-16", dueTime: null });
  await expect(view.locator(".task-row", { hasText: title })).toHaveCount(1);
  expect(app.rendererErrors).toEqual([]);
});

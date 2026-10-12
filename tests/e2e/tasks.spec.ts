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
let threadId = "tasks-thread";
let turnSequence = 0;
const completeWhenReleased = (turnId) => {
  if (!fs.existsSync(path.join(process.cwd(), ".git", ${JSON.stringify(TURN_GATE)}))) {
    setTimeout(() => completeWhenReleased(turnId), 50);
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
    threadId = message.params.threadId || threadId;
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
  const turnId = "tasks-turn-" + turnSequence;
  send({ id: message.id, result: {
    turn: { id: turnId, status: "inProgress", items: [], error: null },
  } });
  send({ method: "turn/started", params: {
    threadId,
    turn: { id: turnId, status: "inProgress", items: [], error: null },
  } });
  send({ method: "item/agentMessage/delta", params: {
    threadId, turnId, itemId: "tasks-answer", delta: ${JSON.stringify(ANSWER)},
  } });
  completeWhenReleased(turnId);
});
`;

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "tasks", initialState: "conversation", codexAppServerSource: tasksAppServer });
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

async function expectTasksRowBetweenNewChatAndSearch(tasks: Locator): Promise<void> {
  const sidebar = app.page.locator(".sidebar");
  const newChat = await sidebar.locator(".sidebar-primary-row").getByRole("button", { name: "New chat", exact: true }).boundingBox();
  const row = await tasks.boundingBox();
  const search = await sidebar.locator(".sidebar-search-wrap").boundingBox();
  expect(row!.height).toBeCloseTo(newChat!.height, 1);
  expect(row!.x).toBeCloseTo(newChat!.x, 1);
  expect(row!.x + row!.width).toBeCloseTo(search!.x + search!.width, 1);
  expect(row!.y).toBeCloseTo(newChat!.y + newChat!.height + 2, 1);
  expect(search!.y).toBeCloseTo(row!.y + row!.height + 2, 1);
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
  expect(new Set(boxes.map(({ height }) => height)).size).toBe(1);
  expect(project!.left).toBe(model!.left);
  expect(folder!.right).toBe(model!.right);
  expect(project!.top).toBe(folder!.top);
  expect(Math.abs((project!.right - project!.left) - (folder!.right - folder!.left))).toBeLessThanOrEqual(1);
  expect(reasoning!.left).toBe(model!.left);
  if (speed) {
    expect(speed.right).toBe(model!.right);
    expect(speed.top).toBe(reasoning!.top);
  } else {
    expect(reasoning!.right).toBe(model!.right);
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
  await expect(list.getByRole("checkbox").first()).toHaveAttribute("aria-label", "Implement remote control");

  await view.getByRole("button", { name: /^Clean the downloads folder/u }).click();
  const detail = view.getByRole("complementary", { name: "Task details" });
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue("Clean the downloads folder");
  const agent = detail.getByRole("group", { name: "Hand it to an agent" });
  await expect(agent).toBeVisible();

  await detail.getByRole("button", { name: "Priority", exact: true }).click();
  await capture(info, "tasks-priority-menu-light");
  await page.getByRole("menu", { name: "Priority" }).getByRole("menuitemradio", { name: "Urgent", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  await expect(list.getByRole("checkbox").first()).toHaveAttribute("aria-label", "Clean the downloads folder");
  await expect(list.locator(".task-row").first().locator(".task-urgent")).toBeVisible();

  await detail.getByRole("button", { name: "Due date", exact: true }).click();
  await page.getByRole("menu", { name: "Due date" }).getByRole("menuitemradio", { name: "Tomorrow", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Due date: Tomorrow" })).toBeVisible();
  await expect(list.locator(".task-row").first()).toContainText("Tomorrow");

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
  await view.getByRole("checkbox", { name: "Implement remote control" }).click();
  await expect(view.getByText("1 to do", { exact: true })).toBeVisible();
  const done = view.getByRole("button", { name: "Done 1", exact: true });
  await expect(done).toHaveAttribute("aria-expanded", "false");
  await done.click();
  await expect(view.getByRole("list", { name: "Done" }).getByRole("checkbox", { name: "Implement remote control" })).toBeChecked();
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

test("Start hands the task to an agent", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  const title = "Clean the downloads folder";
  const view = page.getByRole("main", { name: "Tasks" });
  const detail = view.getByRole("complementary", { name: "Task details" });
  await expect(detail.getByRole("textbox", { name: "Title" })).toHaveValue(title);
  await detail.getByRole("group", { name: "Hand it to an agent" }).getByRole("button", { name: "Start", exact: true }).click();

  await expect(view).toBeHidden();
  const heading = page.getByRole("heading", { name: title, level: 1 });
  await expect(heading).toBeVisible();
  const userMessages = page.locator(".message.is-user");
  await expect(userMessages).toHaveCount(1);
  await expect(userMessages.first()).toContainText(title);
  await expect(userMessages.first()).toContainText("Only the CleanShot files");
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  let conversationId: string;
  try {
    const linked = database.prepare("SELECT conversation_id AS id FROM todos WHERE title = ?").get(title) as { id: string };
    conversationId = linked.id;
    const first = database.prepare(`
      SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1
    `).get(conversationId) as { content: string };
    expect(first.content).toBe(`${title}\n\nOnly the CleanShot files`);
  } finally {
    database.close();
  }
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();

  const destination = page.locator(".sidebar").getByRole("button", { name: "Tasks", exact: true });
  await destination.click();
  const row = view.locator(".task-row", { hasText: title });
  await expect(row.locator(".task-status")).toHaveText("Working");
  await row.getByRole("button", { name: new RegExp(`^${title}`, "u") }).click();
  await expect(detail.getByRole("group", { name: "Hand it to an agent" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Open chat", exact: true })).toBeVisible();
  await expect(detail.locator(".task-status")).toHaveText("Working");

  await writeFile(join(app.workspaceDirectory, ".git", TURN_GATE), "go");
  await expect(row.locator(".task-status")).toHaveText("Done");
  await expect(detail.locator(".task-status")).toHaveText("Done");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.expectNoViewportOverflow();
  await capture(info, "tasks-started-light");

  await detail.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(view).toBeHidden();
  await expect(heading).toBeVisible();

  await destination.click();
  await expect(row.locator(".task-status")).toHaveText("Done");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator(".activity-thread-select", { hasText: title }).first().click({ button: "right" });
  await page.getByRole("menu", { name: `Thread actions for ${title}` }).getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.locator(".activity-thread-select", { hasText: title })).toHaveCount(0);
  await expect(view).toBeVisible();
  await expect(row.locator(".task-status")).toHaveCount(0);
  await row.getByRole("button", { name: new RegExp(`^${title}`, "u") }).click();
  await expect(detail.getByRole("group", { name: "Hand it to an agent" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Open chat", exact: true })).toHaveCount(0);
  const unlinked = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    expect(unlinked.prepare("SELECT conversation_id AS id FROM todos WHERE title = ?").get(title)).toEqual({ id: null });
    expect(unlinked.prepare("SELECT COUNT(*) AS count FROM conversations WHERE id = ?").get(conversationId)).toEqual({ count: 0 });
  } finally {
    unlinked.close();
  }
  expect(app.rendererErrors).toEqual([]);
});

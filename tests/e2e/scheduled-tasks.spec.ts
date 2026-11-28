// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";

const scheduledAppServer = `
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadSequence = 0;
let turnSequence = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "scheduled-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "config/read") return send({ id: message.id, result: { config: {} } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadSequence += 1;
    const threadId = message.params.threadId || "sched-thread-" + process.pid + "-" + threadSequence;
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const threadId = message.params.threadId;
  const turnId = "sched-turn-" + process.pid + "-" + turnSequence;
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg-" + turnId, delta: "Scheduled task completed cleanly." } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
});
`;

let activeApp: AppFixture | undefined;
let bodyFailure: { error: unknown } | undefined;

test.afterEach(async () => {
  const app = activeApp;
  const failure = bodyFailure;
  activeApp = undefined;
  bodyFailure = undefined;
  if (app) await closeElectronAfterTest(() => app.close(), () => test.info(), failure);
});

test("creates, pauses, resumes, runs now, and deletes a scheduled task from the Schedules view", async () => {
  test.setTimeout(90_000);
  const app = activeApp = await createAppFixture({
    name: "scheduled-tasks",
    initialState: "conversation",
    codexAppServerSource: scheduledAppServer,
  });
  try {
    const page = app.page;
    const tasksNav = page.getByRole("button", { name: "Tasks", exact: true });
    const schedulesNav = page.getByRole("button", { name: "Schedules", exact: true });
    const libraryNav = page.getByRole("button", { name: "Library", exact: true });
    await expect(schedulesNav).toBeVisible({ timeout: 20_000 });
    const [tasksBox, schedulesBox, libraryBox] = await Promise.all([
      tasksNav.boundingBox(),
      schedulesNav.boundingBox(),
      libraryNav.boundingBox(),
    ]);
    expect(tasksBox).not.toBeNull();
    expect(schedulesBox).not.toBeNull();
    expect(libraryBox).not.toBeNull();
    expect(schedulesBox!.height).toBeLessThanOrEqual(36);
    expect(schedulesBox!.y - (tasksBox!.y + tasksBox!.height)).toBeLessThanOrEqual(8);
    expect(libraryBox!.y - (schedulesBox!.y + schedulesBox!.height)).toBeLessThanOrEqual(8);
    await schedulesNav.click();

    await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "New schedule" }).click();

    await page.getByLabel("Title").fill("Nightly health check");
    await page.getByLabel("Prompt").fill("Inspect repository status and report a concise summary.");
    await page.getByRole("button", { name: "Create schedule" }).click();

    const taskCard = page.locator(".scheduled-task-card", { hasText: "Nightly health check" });
    await expect(taskCard).toBeVisible({ timeout: 15_000 });
    await expect(taskCard).toContainText("Active");

    // Pause and resume
    await taskCard.getByRole("button", { name: "Pause" }).click();
    await expect(taskCard).toContainText("Paused", { timeout: 10_000 });
    await taskCard.getByRole("button", { name: "Resume" }).click();
    await expect(taskCard).toContainText("Active", { timeout: 10_000 });

    await taskCard.getByRole("button", { name: "Run now" }).click();
    await expect(page.locator("main").getByText("Scheduled task completed cleanly.")).toBeVisible({ timeout: 20_000 });
    await schedulesNav.click();
    await expect(taskCard).toBeVisible({ timeout: 15_000 });
    const recentRunsButton = taskCard.getByRole("button", { name: /Recent runs \(1\)/i });
    await expect(recentRunsButton).toBeVisible({ timeout: 15_000 });
    await recentRunsButton.click();
    const runsPanel = taskCard.locator(".scheduled-runs-panel");
    await expect(runsPanel).toBeVisible({ timeout: 10_000 });
    await expect(runsPanel.locator(".scheduled-run-state")).toContainText(/completed/i, { timeout: 20_000 });

    // Inline 2-step delete confirmation
    await taskCard.getByRole("button", { name: "Delete" }).click();
    await taskCard.getByRole("button", { name: "Confirm delete" }).click();
    await expect(taskCard).toHaveCount(0, { timeout: 10_000 });
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
});

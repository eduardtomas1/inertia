// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { focusAppWindow } from "./support/window-focus";

const TITLE = "Release coordination";
const TASKS = {
  a: { title: "Audit changelog", task: "Audit the changelog entries for the 2.4 release. [child-a]",
    result: "The changelog lists 14 entries; two are missing issue links." },
  b: { title: "Review dependencies", task: "Review the dependency updates in the lockfile. [child-b]",
    result: "Three minor updates; none change a public API." },
  c: { title: "Check licences", task: "Check the licences of the new runtime dependencies. [child-c]",
    result: "All new runtime dependencies use MIT or Apache-2.0." },
} as const;
const PARENT_PROMPTS = {
  a: "Coordinate the 2.4 release audit. [parent-a]",
  b: "Delegate the dependency review. [parent-b]",
  c: "Delegate the licence check. [parent-c]",
} as const;
const QUEUED_PROMPT = "Summarise what is left before tagging. [queued]";
const NATIVE_PROMPT = "Survey the parsers with a helper agent. [native]";
const WAKE_ANSWER = "Read the delegated results and updated the release checklist.";

const appServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const root = path.join(process.cwd(), ".git");
const capture = (entry) => fs.appendFileSync(path.join(root, "delegation-capture.jsonl"), JSON.stringify(entry) + "\\n");
const gate = (name, then) => {
  if (fs.existsSync(path.join(root, "delegation-gate-" + name))) return then();
  setTimeout(() => gate(name, then), 50);
};
const TASKS = ${JSON.stringify(TASKS)};
let threadCounter = 0;
let turnCounter = 0;
const live = new Map();
const toolCalls = new Map();
const say = (turn, text) => {
  const itemId = turn.id + "-answer";
  send({ method: "item/agentMessage/delta", params: { threadId: turn.threadId, turnId: turn.id, itemId, delta: text } });
};
const complete = (turn, status) => {
  if (turn.settled) return;
  turn.settled = true;
  live.delete(turn.id);
  send({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.id, status, items: [], error: null } } });
};
const finish = (turn, text) => {
  if (turn.settled) return;
  say(turn, text);
  complete(turn, "completed");
};
const delegate = (turn, key) => {
  const id = "delegate-" + turn.id;
  toolCalls.set(id, (result) => {
    capture({ kind: "tool-result", key, success: result.success, text: (result.contentItems || []).map((item) => item.text || "").join("") });
    if (turn.settled) return;
    say(turn, "Delegated " + TASKS[key].title.toLowerCase() + ".");
    gate("parent-" + key, () => complete(turn, "completed"));
  });
  send({ id, method: "item/tool/call", params: { threadId: turn.threadId, turnId: turn.id, callId: "call-" + turn.id,
    tool: "inertia_delegate_task", arguments: { task: TASKS[key].task, title: TASKS[key].title, mode: "async", wake: "always" } } });
};
const native = (turn) => {
  const child = "native-parser-survey";
  const call = { type: "collabAgentToolCall", id: "spawn-" + turn.id, tool: "spawnAgent", senderThreadId: turn.threadId,
    receiverThreadIds: [child], prompt: "List every parser that reads token usage.", agentsStates: { [child]: { status: "running" } } };
  send({ method: "item/started", params: { threadId: turn.threadId, turnId: turn.id, item: call } });
  send({ method: "turn/started", params: { threadId: child, turn: { id: child + "-turn", status: "inProgress", items: [], error: null } } });
  send({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.id, item: call } });
  send({ method: "item/completed", params: { threadId: child, turnId: child + "-turn",
    item: { id: child + "-answer", type: "agentMessage", text: "Found three parsers in src/server/provider." } } });
  send({ method: "turn/completed", params: { threadId: child, turn: { id: child + "-turn", status: "completed", items: [], error: null } } });
  finish(turn, "The helper found three parsers.");
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "delegation-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "config/read") return send({ id: message.id, result: { config: {} } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") {
    return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadCounter += 1;
    const threadId = message.params.threadId || "delegation-thread-" + process.pid + "-" + threadCounter;
    capture({ kind: message.method, threadId, tools: (message.params.dynamicTools || []).map((tool) => tool.name) });
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture", cwd: process.cwd(), serviceTier: null } });
  }
  if (message.method === "turn/steer") {
    capture({ kind: "steer-refused" });
    return send({ id: message.id, error: { code: -32600, message: "The fixture does not accept steering." } });
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    const turn = live.get(message.params.turnId);
    if (turn) complete(turn, "interrupted");
    return;
  }
  if (message.method === "turn/start") {
    const prompt = (message.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
    turnCounter += 1;
    const turn = { id: "delegation-turn-" + process.pid + "-" + turnCounter, threadId: message.params.threadId, settled: false };
    live.set(turn.id, turn);
    const body = { id: turn.id, status: "inProgress", items: [], error: null };
    send({ id: message.id, result: { turn: body } });
    send({ method: "turn/started", params: { threadId: turn.threadId, turn: body } });
    const wake = /^(Delegated task "[^\\n]*|\\d+(?: of \\d+)? delegated tasks [^\\n]*)$/mu.exec(prompt);
    const child = /\\[child-([abc])\\]/u.exec(prompt);
    const parent = /\\[parent-([abc])\\]/u.exec(prompt);
    if (wake) {
      capture({ kind: "wake", firstLine: wake[1] });
      return finish(turn, ${JSON.stringify(WAKE_ANSWER)});
    }
    if (child) {
      capture({ kind: "child", key: child[1] });
      return gate("child-" + child[1], () => finish(turn, TASKS[child[1]].result));
    }
    if (parent) {
      capture({ kind: "parent", key: parent[1] });
      return delegate(turn, parent[1]);
    }
    if (prompt.includes("[native]")) return native(turn);
    if (prompt.includes("[queued]")) return finish(turn, "Two release notes still need issue links.");
    return finish(turn, "Fixture answer.");
  }
  if (message.id !== undefined && toolCalls.has(message.id) && (message.result || message.error)) {
    const resume = toolCalls.get(message.id);
    toolCalls.delete(message.id);
    return resume(message.result || { success: false, contentItems: [{ type: "inputText", text: JSON.stringify(message.error) }] });
  }
  if (message.id !== undefined && message.method) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;

interface CaptureEntry {
  kind: string;
  key?: string;
  tools?: string[];
  firstLine?: string;
  success?: boolean;
  text?: string;
}

let app!: AppFixture;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "delegation-wake",
    initialState: "conversation",
    codexAppServerSource: appServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const conversationId = store.shellSnapshot().activeConversationId;
        if (!conversationId) throw new Error("The delegation fixture requires an active chat.");
        store.updateConversation(conversationId, { title: TITLE });
      } finally {
        store.close();
      }
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

function captured(): CaptureEntry[] {
  const path = join(app.workspaceDirectory, ".git", "delegation-capture.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as CaptureEntry);
}

function wakes(): string[] {
  return captured().filter(({ kind }) => kind === "wake").map(({ firstLine }) => firstLine ?? "");
}

async function open(name: string): Promise<void> {
  await writeFile(join(app.workspaceDirectory, ".git", `delegation-gate-${name}`), "open", { flag: "wx" });
}

async function capture(info: TestInfo, name: string, assertStage: () => Promise<void>): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await expect(app.page.getByText("Capturing changes…", { exact: true })).toHaveCount(0);
    await assertStage();
    await expect(app.page.locator(".response-turn.is-settling")).toHaveCount(0);
    await expect(app.page.getByText("Capturing changes…", { exact: true })).toHaveCount(0);
    const path = info.outputPath(`${name}-${theme}.png`);
    await app.page.screenshot({ path, animations: "disabled" });
    await info.attach(`${name}-${theme}`, { path, contentType: "image/png" });
  }
}

function panel(): Locator {
  return app.page.getByRole("region", { name: "Delegated work" });
}

function taskRow(title: string): Locator {
  return panel().locator("li.delegation-task").filter({ has: app.page.getByText(title, { exact: true }) });
}

function queue(): Locator {
  return app.page.getByRole("list", { name: "Queued messages" });
}

function completionCards(): Locator {
  return app.page.getByRole("article", { name: /^Delegated results: / });
}

async function sendPrompt(text: string): Promise<void> {
  await app.page.getByRole("textbox", { name: "Message" }).fill(text);
  await app.page.getByRole("button", { name: "Send message", exact: true }).click();
}

async function approveDelegation(info: TestInfo | null, key: keyof typeof TASKS, screenshot: string | null): Promise<void> {
  const approval = app.page.getByRole("region", { name: `Delegate “${TASKS[key].title}”` });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("delegated task · wakes this chat on result");
  if (info && screenshot) {
    await capture(info, screenshot, async () => {
      await expect(approval).toContainText("delegated task · wakes this chat on result");
      await approval.scrollIntoViewIfNeeded();
    });
  }
  await approval.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(approval).toHaveCount(0);
  await expect.poll(() => captured().filter(({ kind, key: entry }) => kind === "tool-result" && entry === key)
    .map(({ success }) => success)).toEqual([true]);
}

test("delegates a task, pins its result first in the queue and continues the parent once", async ({ browserName: _browserName }, info) => {
  test.setTimeout(170_000);
  const { page } = app;
  await app.resizeWindow(1440, 960);
  await focusAppWindow(app.electronApp, page);
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();

  await sendPrompt(PARENT_PROMPTS.a);
  await expect.poll(() => captured().find(({ kind }) => kind === "thread/start")?.tools ?? [])
    .toContain("inertia_delegate_task");
  await approveDelegation(info, "a", "delegation-approval");
  await expect(page.getByText("Delegated audit changelog.", { exact: true })).toBeVisible();
  await expect.poll(() => captured().some(({ kind, key }) => kind === "child" && key === "a")).toBe(true);
  await expect(taskRow(TASKS.a.title)).toContainText("Working");
  await expect(taskRow(TASKS.a.title)).toContainText("Will continue this chat");

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(QUEUED_PROMPT);
  await composer.press("Tab");
  await expect(queue()).toContainText(QUEUED_PROMPT);

  await open("child-a");
  await expect(taskRow(TASKS.a.title)).toContainText("Result ready");
  await expect(queue()).toContainText("Delegated results");
  await expect(queue()).toContainText("1 of 2");
  await expect(queue().getByRole("button", { name: "Send queued message now" })).toHaveCount(0);
  expect(captured().some(({ kind }) => kind === "steer-refused")).toBe(true);
  expect(wakes()).toEqual([]);
  await capture(info, "delegation-queue-pinned", async () => {
    await expect(queue()).toContainText("Delegated results");
    await expect(queue()).toContainText("1 of 2");
    await expect(page.getByText("Delegated audit changelog.", { exact: true })).toHaveCount(1);
  });

  await open("parent-a");
  await expect(page.getByText(WAKE_ANSWER, { exact: true })).toBeVisible();
  await expect(page.getByText("Two release notes still need issue links.", { exact: true })).toBeVisible();
  await expect(queue()).toHaveCount(0);
  const card = completionCards();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(`Delegated task "${TASKS.a.title}" finished`);
  expect(wakes()).toEqual([`Delegated task "${TASKS.a.title}" finished`]);
  await expect(taskRow(TASKS.a.title)).toContainText("Delivered");
  await card.getByRole("button", { name: "Show results" }).click();
  await expect(card.getByRole("list", { name: "Delivered delegated tasks" })).toContainText(TASKS.a.result);
  await capture(info, "delegation-completion-card", async () => {
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("list", { name: "Delivered delegated tasks" })).toContainText(TASKS.a.result);
  });
  await page.waitForTimeout(1_500);
  expect(wakes()).toHaveLength(1);
  await expect(completionCards()).toHaveCount(1);
});

test("Stop dismisses a waiting delivery and Continue with results sends it by hand", async ({ browserName: _browserName }, info) => {
  test.setTimeout(150_000);
  const { page } = app;
  await sendPrompt(PARENT_PROMPTS.b);
  await approveDelegation(null, "b", null);
  await expect.poll(() => captured().some(({ kind, key }) => kind === "child" && key === "b")).toBe(true);
  await expect(taskRow(TASKS.b.title)).toContainText("Working");
  await expect(taskRow(TASKS.a.title)).toContainText("Delivered");
  await capture(info, "delegation-panel-running-delivered", async () => {
    await panel().scrollIntoViewIfNeeded();
    await expect(taskRow(TASKS.b.title)).toContainText("Working");
    await expect(taskRow(TASKS.a.title)).toContainText("Delivered");
  });

  await open("child-b");
  await expect(taskRow(TASKS.b.title)).toContainText("Result ready");
  await expect(queue()).toContainText("Delegated results");
  await page.getByRole("button", { name: "Stop agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
  await expect(queue()).toHaveCount(0);
  await expect(taskRow(TASKS.b.title)).toContainText("Dismissed");
  await expect(taskRow(TASKS.b.title)).not.toContainText("Will continue this chat");
  await expect(panel().getByRole("button", { name: "Continue with results" })).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(wakes()).toHaveLength(1);
  await expect(completionCards()).toHaveCount(1);
  await capture(info, "delegation-stop-dismissed", async () => {
    await panel().scrollIntoViewIfNeeded();
    await expect(taskRow(TASKS.b.title)).toContainText("Dismissed");
  });

  await panel().getByRole("button", { name: "Continue with results" }).click();
  await expect(panel().getByRole("status")).toContainText("Sent 1 result to this chat.");
  await expect.poll(() => wakes()).toEqual([
    `Delegated task "${TASKS.a.title}" finished`,
    `Delegated task "${TASKS.b.title}" finished`,
  ]);
  await expect(completionCards()).toHaveCount(2);
  await expect(completionCards().nth(1)).toContainText(`Delegated task "${TASKS.b.title}" finished`);
  await expect(taskRow(TASKS.b.title)).toContainText("Delivered");
});

test("a restart keeps a held delivery and sending it continues the parent once", async ({ browserName: _browserName }, info) => {
  test.setTimeout(170_000);
  await sendPrompt(PARENT_PROMPTS.c);
  await approveDelegation(null, "c", null);
  await expect.poll(() => captured().some(({ kind, key }) => kind === "child" && key === "c")).toBe(true);
  await open("child-c");
  await expect(taskRow(TASKS.c.title)).toContainText("Result ready");
  await expect(queue()).toContainText("Delegated results");
  expect(wakes()).toHaveLength(2);

  await app.restart();
  await focusAppWindow(app.electronApp, app.page);
  await expect(app.page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
  await expect(taskRow(TASKS.c.title)).toContainText("Result ready");
  await expect(queue()).toContainText("Delegated results");
  await expect(panel()).toContainText("Finished results are queued to continue this chat.");
  await app.page.waitForTimeout(3_000);
  expect(wakes()).toHaveLength(2);
  await capture(info, "delegation-restart-held", async () => {
    await expect(queue().getByRole("button", { name: "Send delegated results now" })).toBeVisible();
    await expect(taskRow(TASKS.c.title)).toContainText("Result ready");
  });

  await queue().getByRole("button", { name: "Send delegated results now" }).click();
  await expect.poll(() => wakes()).toHaveLength(3);
  expect(wakes()[2]).toBe(`Delegated task "${TASKS.c.title}" finished`);
  await expect(completionCards()).toHaveCount(3);
  await expect(taskRow(TASKS.c.title)).toContainText("Delivered");
  await expect(queue()).toHaveCount(0);
  await app.page.waitForTimeout(1_500);
  expect(wakes()).toHaveLength(3);
});

test("shows the automatic wake setting in Settings", async ({ browserName: _browserName }, info) => {
  const { page } = app;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const group = page.getByRole("region", { name: "Delegated tasks" });
  const toggle = group.getByRole("switch", { name: "Continue chats automatically when delegated tasks finish" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await capture(info, "delegation-settings-toggle", async () => {
    await group.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
});

test("opens the observed child panel from a turn's agents line", async ({ browserName: _browserName }, info) => {
  const { page } = app;
  await sendPrompt(NATIVE_PROMPT);
  await expect(page.getByText("The helper found three parsers.", { exact: true })).toBeVisible();
  const details = page.getByRole("button", { name: "Agent details" }).last();
  await details.click();
  const observed = page.getByRole("region", { name: "Provider-managed agents" }).last();
  await expect(observed).toContainText("Provider-managed · read-only");
  await expect(observed).toContainText("Completed");
  await expect(observed).toContainText("Found three parsers in src/server/provider.");
  await expect(observed).toContainText("Stop unavailable:");
  await capture(info, "observed-child-panel", async () => {
    await observed.scrollIntoViewIfNeeded();
    await expect(observed).toContainText("Provider-managed · read-only");
  });
});

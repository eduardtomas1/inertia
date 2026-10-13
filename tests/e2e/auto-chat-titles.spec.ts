// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const evidenceDirectory = process.env.INERTIA_AUTO_TITLES_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_AUTO_TITLES_EVIDENCE_DIR)
  : null;

const firstPrompt = "Fix the flaky retry in src/server/git.ts when the remote is offline, please look at it";
const quickTitle = "Fix the flaky retry in src/server/git.ts";
const generatedTitle = "Flaky retry in git.ts";
const providerOutput = "Looked at the retry path.";

const titlesAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const gitDirectory = path.join(process.cwd(), ".git");
const record = (entry) => fs.appendFileSync(path.join(gitDirectory, "title-requests.jsonl"),
  JSON.stringify({ ...entry, at: Date.now() }) + "\\n");
const titleThreads = new Set();
let threadId = "auto-titles-thread";
let turnSequence = 0;
const turn = (id, status) => ({ id, status, items: [], error: null });
const answerTitle = (titleThreadId, turnId) => {
  if (!fs.existsSync(path.join(gitDirectory, "title-release"))) {
    setTimeout(() => answerTitle(titleThreadId, turnId), 50);
    return;
  }
  send({ method: "item/completed", params: {
    threadId: titleThreadId, turnId, completedAtMs: Date.now(),
    item: { type: "agentMessage", id: "title-message", text: JSON.stringify({ title: ${JSON.stringify(generatedTitle)} }), phase: "final_answer" },
  } });
  send({ method: "turn/completed", params: { threadId: titleThreadId, turn: turn(turnId, "completed") } });
  record({ method: "title/answered" });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "auto-titles-fixture" } });
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
  if (message.method === "config/read") {
    record({ method: message.method });
    send({ id: message.id, result: { config: {} } });
    return;
  }
  if (message.method === "thread/start" && message.params.threadSource === "thread_title") {
    record({ method: "title/thread/start", params: message.params });
    const titleThreadId = "title-thread-" + process.pid;
    titleThreads.add(titleThreadId);
    send({ id: message.id, result: {
      thread: { id: titleThreadId, ephemeral: message.params.ephemeral === true },
      model: message.params.model || "fixture", modelProvider: "openai", serviceTier: null, cwd: process.cwd(),
      approvalPolicy: "never", approvalsReviewer: "user", reasoningEffort: null,
      sandbox: message.params.sandbox === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    } });
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
  const turnId = "auto-titles-turn-" + process.pid + "-" + turnSequence;
  if (titleThreads.has(message.params.threadId)) {
    record({ method: "title/turn/start", params: message.params });
    send({ id: message.id, result: { turn: turn(turnId, "inProgress") } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: turn(turnId, "inProgress") } });
    answerTitle(message.params.threadId, turnId);
    return;
  }
  send({ id: message.id, result: { turn: turn(turnId, "inProgress") } });
  send({ method: "turn/started", params: { threadId, turn: turn(turnId, "inProgress") } });
  send({ method: "item/agentMessage/delta", params: {
    threadId, turnId, itemId: "answer-" + turnSequence, delta: ${JSON.stringify(providerOutput)},
  } });
  send({ method: "turn/completed", params: { threadId, turn: turn(turnId, "completed") } });
  record({ method: "chat/turn/completed" });
});
`;

interface RecordedRequest {
  method: string;
  params?: Record<string, unknown>;
  at: number;
}

async function recordedRequests(app: AppFixture): Promise<RecordedRequest[]> {
  const text = await readFile(join(app.workspaceDirectory, ".git", "title-requests.jsonl"), "utf8")
    .catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedRequest);
}

async function recordedMethods(app: AppFixture): Promise<string[]> {
  return (await recordedRequests(app)).map(({ method }) => method);
}

async function releaseTitle(app: AppFixture): Promise<void> {
  await writeFile(join(app.workspaceDirectory, ".git", "title-release"), "release\n", "utf8");
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function activeRow(page: Page): Locator {
  return page.getByRole("complementary", { name: "Project navigation", exact: true })
    .locator(".activity-thread.is-active .activity-thread-select");
}

async function expectTitle(page: Page, title: string): Promise<void> {
  await expect(activeRow(page)).toHaveAttribute("aria-label", new RegExp(`^${escaped(title)},`, "u"));
  await expect(activeRow(page)).toContainText(title);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
}

async function startNewChat(app: AppFixture): Promise<void> {
  await app.page.getByRole("complementary", { name: "Project navigation", exact: true })
    .getByRole("button", { name: "New chat", exact: true }).click();
  await expect(activeRow(app.page)).toHaveAttribute("aria-label", /^New chat,/u);
  await expect(app.page.getByRole("heading", { name: "What should we build in Inertia?" })).toBeVisible();
}

async function sendMessage(app: AppFixture, request: string, typed = false): Promise<void> {
  const composer = app.page.getByRole("region", { name: "Message composer" });
  const editor = composer.getByRole("textbox", { name: "Message" });
  if (typed) {
    await editor.click();
    await editor.pressSequentially(request, { delay: 12 });
  } else {
    await editor.fill(request);
  }
  await composer.getByRole("button", { name: "Send message" }).click();
}

async function expectCompletedTurn(app: AppFixture, request: string): Promise<void> {
  const turn = app.page.locator("[data-turn-id]").filter({
    has: app.page.getByText(request, { exact: true }),
  });
  await expect(turn.locator('[data-turn-status="completed"]')).toBeVisible();
  await expect(turn.getByText(providerOutput, { exact: true })).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (!evidenceDirectory) return;
  await expect(page.getByText(/^Capturing changes/u)).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: join(evidenceDirectory, `${name}.png`), animations: "disabled" });
}

function recordFrames(page: Page): () => Promise<void> {
  if (!evidenceDirectory) return async () => undefined;
  const directory = join(evidenceDirectory, "title-gif-frames");
  let recording = true;
  const loop = (async () => {
    await mkdir(directory, { recursive: true });
    const started = Date.now();
    for (let frame = 0; recording; frame += 1) {
      const due = started + frame * 200;
      await new Promise((settle) => setTimeout(settle, Math.max(0, due - Date.now())));
      await page.screenshot({ path: join(directory, `frame-${String(frame).padStart(4, "0")}.png`) });
    }
  })();
  return async () => {
    recording = false;
    await loop;
  };
}

async function openTitledApp(name: string): Promise<AppFixture> {
  const app = await createAppFixture({ name, initialState: "conversation", codexAppServerSource: titlesAppServer });
  await setAppearanceInPlace(app, "light");
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
  return app;
}

test("replaces the quick title with the generated Codex title once, after the first turn", async () => {
  const app = await openTitledApp("auto-chat-titles");
  try {
    const { page } = app;
    await startNewChat(app);
    const stopFrames = recordFrames(page);
    await sendMessage(app, firstPrompt, Boolean(evidenceDirectory));
    await expectTitle(page, quickTitle);
    await expectCompletedTurn(app, firstPrompt);
    await expect.poll(() => recordedMethods(app)).toContain("title/turn/start");
    await expectTitle(page, quickTitle);
    if (evidenceDirectory) await page.waitForTimeout(1_000);
    await capture(page, "after-quick-title");
    await releaseTitle(app);
    await expectTitle(page, generatedTitle);
    if (evidenceDirectory) await page.waitForTimeout(1_200);
    await stopFrames();
    await capture(page, "after-generated-title");

    const requests = await recordedRequests(app);
    const opened = requests.find(({ method }) => method === "title/thread/start")!;
    expect(opened.params).toMatchObject({ ephemeral: true, threadSource: "thread_title", sandbox: "read-only" });
    expect(opened.params).not.toHaveProperty("model");
    const started = requests.find(({ method }) => method === "title/turn/start")!;
    expect(started.params).toMatchObject({ effort: "low", outputSchema: { required: ["title"] } });
    expect(started.params).not.toHaveProperty("model");
    expect(JSON.stringify(started.params?.input)).toContain(JSON.stringify(firstPrompt).slice(1, -1));
    const settledAt = requests.find(({ method }) => method === "chat/turn/completed")!.at;
    expect(opened.at).toBeGreaterThanOrEqual(settledAt);

    const followUp = "Also check the timeout path";
    await sendMessage(app, followUp);
    await expectCompletedTurn(app, followUp);
    await expect.poll(async () => (await recordedMethods(app))
      .filter((method) => method === "chat/turn/completed").length).toBe(2);
    const secondSettledAt = Date.now();
    await expect.poll(async () => ({
      threads: (await recordedMethods(app)).filter((method) => method === "title/thread/start").length,
      waited: Date.now() - secondSettledAt >= 3_000,
    }), { intervals: [250] }).toEqual({ threads: 1, waited: true });
    await expectTitle(page, generatedTitle);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("keeps a rename made while the generated title is still pending", async () => {
  const app = await openTitledApp("auto-chat-titles-rename");
  try {
    const { page } = app;
    await startNewChat(app);
    await sendMessage(app, firstPrompt);
    await expectTitle(page, quickTitle);
    await expectCompletedTurn(app, firstPrompt);
    await expect.poll(() => recordedMethods(app)).toContain("title/turn/start");

    await activeRow(page).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename thread" }).click();
    const rename = page.getByRole("textbox", { name: `Rename ${quickTitle}` });
    await rename.fill("Offline remote retry");
    await rename.press("Enter");
    await expectTitle(page, "Offline remote retry");

    await releaseTitle(app);
    await expect.poll(() => recordedMethods(app)).toContain("title/answered");
    const followUp = "Also check the timeout path";
    await sendMessage(app, followUp);
    await expectCompletedTurn(app, followUp);
    await expectTitle(page, "Offline remote retry");
    expect((await recordedMethods(app)).filter((method) => method === "title/thread/start")).toHaveLength(1);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";
import { waitForTranscriptSettled } from "./support/stable-sample";

const streamStopGate = "inertia-reader-position-stop";

const streamingAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const stopGate = path.join(process.cwd(), ".git", "${streamStopGate}");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "reader-position-thread";
const turnId = "reader-position-turn";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "reader-position-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "config/read") return send({ id: message.id, result: { config: {} } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") {
    return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  }
  if (message.method !== "turn/start") return;
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  let index = 0;
  const tick = () => {
    if (fs.existsSync(stopGate) || index >= 600) {
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      return;
    }
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId,
        turnId,
        itemId: "reader-position-answer",
        delta: "Streaming reader paragraph " + index + ". " + "The answer keeps growing below the reader. ".repeat(3) + "\\n\\n",
      },
    });
    index += 1;
    setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
});
`;

function readPosition(transcript: Locator) {
  return transcript.evaluate((element) => ({
    top: Math.round(element.scrollTop),
    gap: Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
  }));
}

async function expectReaderStaysAt(page: Page, transcript: Locator, top: number): Promise<void> {
  const deadline = Date.now() + 1_600;
  while (Date.now() < deadline) {
    expect((await readPosition(transcript)).top).toBe(top);
    await page.waitForTimeout(100);
  }
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
}

test("keeps the reader's position near the end of a completed or streaming answer and rejoins the live stream with End", async () => {
  test.setTimeout(120_000);
  const app = await createAppFixture({
    name: "reader-position",
    initialState: "conversation",
    codexAppServerSource: streamingAppServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      try {
        const conversationId = store.shellSnapshot().activeConversationId!;
        store.updateConversation(conversationId, { title: "Reader position fixture" });
        for (let index = 0; index < 4; index += 1) {
          const at = new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString();
          const { turn } = store.beginAgentTurn({
            id: randomUUID(), conversationId, runId: randomUUID(),
            content: `Reader position request ${index}`, providerId: "codex",
            harnessId: "codex-app-server", backendProfileId: "builtin:openai",
            model: "provider-default", reasoningEffort: "high", interactionMode: "build",
            accessMode: "supervised", configurationRevision: 0,
            association: "authoritative", requestedAt: at,
          });
          const body = Array.from({ length: 30 }, (_, line) =>
            `Completed answer ${index} paragraph ${line}. ${"Readers move through this text. ".repeat(4)}`).join("\n\n");
          const answer = store.createMessage(conversationId, body, "assistant", [], turn.id, at);
          store.updateAgentTurnLifecycle(turn.id, {
            status: "completed", startedAt: at, completedAt: at, updatedAt: at,
            terminalAssistantMessageId: answer.id, terminalReason: "provider-completed",
          });
        }
      } finally { store.close(); }
    },
  });
  try {
    await app.resizeWindow(1440, 920);
    const { page } = app;
    await expect(page.getByRole("heading", { name: "Reader position fixture", level: 1 })).toBeVisible();
    const transcript = page.getByLabel("Thread transcript");
    const jumpToLatest = page.getByRole("button", { name: "Jump to latest" });
    await waitForTranscriptSettled(transcript);
    await expect.poll(async () => (await readPosition(transcript)).gap).toBeLessThanOrEqual(2);
    await transcript.hover({ position: { x: 400, y: 300 } });

    await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await readPosition(transcript)).gap).toBeGreaterThanOrEqual(98);
    await expectReaderStaysAt(page, transcript, (await readPosition(transcript)).top);

    await page.mouse.wheel(0, 400);
    await expect(jumpToLatest).toHaveCount(0);
    await expect.poll(async () => (await readPosition(transcript)).gap).toBeLessThanOrEqual(2);
    for (let step = 0; step < 3; step += 1) {
      await page.mouse.wheel(0, -30);
      await page.waitForTimeout(60);
    }
    await expectReaderStaysAt(page, transcript, (await readPosition(transcript)).top);

    await page.mouse.wheel(0, -2_000);
    await page.waitForTimeout(300);
    const nearEnd = (await readPosition(transcript)).gap - 60;
    await page.mouse.wheel(0, nearEnd);
    await expect.poll(async () => (await readPosition(transcript)).gap).toBeLessThanOrEqual(62);
    await expectReaderStaysAt(page, transcript, (await readPosition(transcript)).top);

    await page.mouse.wheel(0, 400);
    await expect(jumpToLatest).toHaveCount(0);
    await expect.poll(async () => (await readPosition(transcript)).gap).toBeLessThanOrEqual(2);

    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill("Stream a long answer.");
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/^Streaming reader paragraph 25\./u)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await readPosition(transcript)).gap).toBeLessThanOrEqual(2);
    await expect(jumpToLatest).toHaveCount(0);

    await transcript.hover({ position: { x: 400, y: 300 } });
    await page.mouse.wheel(0, -60);
    await expect(jumpToLatest).toBeVisible();
    const streamingTop = (await readPosition(transcript)).top;
    await expectReaderStaysAt(page, transcript, streamingTop);
    expect((await readPosition(transcript)).gap).toBeGreaterThan(120);

    await transcript.focus();
    await page.keyboard.press("End");
    await expect(jumpToLatest).toHaveCount(0);
    await page.waitForTimeout(1_000);
    await expect.poll(async () => (await readPosition(transcript)).gap).toBeLessThanOrEqual(2);
    await expect(jumpToLatest).toHaveCount(0);

    await writeFile(join(app.workspaceDirectory, ".git", streamStopGate), "stop\n", "utf8");
    await expect(composer.getByRole("button", { name: "Stop agent" })).toHaveCount(0, { timeout: 20_000 });
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

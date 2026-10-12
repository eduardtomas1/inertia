// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

const rejectionMarker = "reject-saved-session";
const turnLog = "session-continuity-turns.jsonl";
const threadLog = "session-continuity-threads.json";

const sessionProvider = `
const fs = require("node:fs");
const path = require("node:path");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const threadsPath = path.join(process.cwd(), ${JSON.stringify(threadLog)});
const threads = () => fs.existsSync(threadsPath) ? JSON.parse(fs.readFileSync(threadsPath, "utf8")) : [];
let threadId = null;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "session-continuity-fixture" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/resume") {
    if (fs.existsSync(path.join(process.cwd(), ${JSON.stringify(rejectionMarker)}))) {
      return send({ id: message.id, error: { code: -32600, message: "no rollout found for thread id " + message.params.threadId } });
    }
    threadId = message.params.threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  }
  if (message.method === "thread/start") {
    const known = threads();
    threadId = "continuity-thread-" + (known.length + 1);
    fs.writeFileSync(threadsPath, JSON.stringify([...known, threadId]));
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  }
  if (message.method !== "turn/start") return;
  const prompt = (message.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
  fs.appendFileSync(path.join(process.cwd(), ${JSON.stringify(turnLog)}), JSON.stringify({ threadId, prompt }) + "\\n");
  const turnId = "continuity-turn-" + Date.now();
  const turn = { id: turnId, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "continuity-answer", delta: "Answered on " + threadId + "." } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;

let app: AppFixture | undefined;
test.afterEach(async () => { await app?.close(); });

async function send(fixture: AppFixture, content: string): Promise<void> {
  const routeReadiness = fixture.page.locator(".composer .provider-readiness");
  await expect.poll(async () => await routeReadiness.allTextContents()).toEqual([]);
  await fixture.page.getByRole("textbox", { name: "Message" }).fill(content);
  await fixture.page.getByRole("button", { name: "Send message", exact: true }).click();
}

async function recordedTurns(fixture: AppFixture): Promise<Array<{ threadId: string; prompt: string }>> {
  const source = await readFile(join(fixture.workspaceDirectory, turnLog), "utf8");
  return source.trim().split("\n").map((line) => JSON.parse(line) as { threadId: string; prompt: string });
}

test("a rejected saved session is replaced inside the turn with the chat's history restored", async () => {
  app = await createAppFixture({
    name: "session-continuity",
    initialState: "conversation",
    codexAppServerSource: sessionProvider,
    workspaceGit: false,
  });
  const recoveryNotes = app.page.locator('[aria-label="Provider session"]');

  await send(app, "Keep the public API unchanged while you refactor.");
  await expect(app.page.getByText("Answered on continuity-thread-1.", { exact: true })).toBeVisible();
  await send(app, "Continue with the refactor.");
  await expect(app.page.getByText("Answered on continuity-thread-1.", { exact: true })).toHaveCount(2);
  await expect(recoveryNotes).toHaveCount(0);

  await writeFile(join(app.workspaceDirectory, rejectionMarker), "");
  await send(app, "What constraint did I give you?");
  await expect(app.page.getByText("Answered on continuity-thread-2.", { exact: true })).toBeVisible();
  await expect(recoveryNotes).toHaveCount(1);
  await expect(recoveryNotes).toContainText("New provider session");
  await expect(recoveryNotes).toContainText("Saved session no longer available · 4 earlier messages restored");

  const turns = await recordedTurns(app);
  expect(turns.map(({ threadId }) => threadId)).toEqual([
    "continuity-thread-1",
    "continuity-thread-1",
    "continuity-thread-2",
  ]);
  expect(turns[1]!.prompt).not.toContain("Keep the public API unchanged");
  expect(turns[2]!.prompt).toContain("What constraint did I give you?");
  expect(turns[2]!.prompt).toContain("Keep the public API unchanged while you refactor.");
  expect(turns[2]!.prompt).toContain("Answered on continuity-thread-1.");
  expect(turns[2]!.prompt).toContain("restored because this provider session does not have them");
  expect(turns[2]!.prompt.split("What constraint did I give you?")).toHaveLength(2);

  await rm(join(app.workspaceDirectory, rejectionMarker));
  await send(app, "Thanks, carry on.");
  await expect(app.page.getByText("Answered on continuity-thread-2.", { exact: true })).toHaveCount(2);
  await expect(recoveryNotes).toHaveCount(1);
  expect((await recordedTurns(app)).at(-1)).toMatchObject({ threadId: "continuity-thread-2" });
  expect((await recordedTurns(app)).at(-1)!.prompt).not.toContain("Keep the public API unchanged");

  const databasePath = join(app.testDirectory, "data", "inertia.sqlite");
  const durable = (): { turns: unknown[]; sessions: unknown[] } => {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      return {
        turns: database.prepare(`
          SELECT continuation_reason_code AS reason, provider_session_before AS before,
            provider_session_after AS after, session_recovery_json AS recovery, status
          FROM agent_turns ORDER BY requested_at ASC
        `).all(),
        sessions: database.prepare(
          "SELECT provider_session_id AS session FROM conversations WHERE provider_session_id IS NOT NULL",
        ).all(),
      };
    } finally {
      database.close();
    }
  };
  await expect.poll(durable).toEqual({
    turns: [
      { reason: "first-turn", before: null, after: "continuity-thread-1", recovery: null, status: "completed" },
      { reason: "same-continuation", before: "continuity-thread-1", after: "continuity-thread-1", recovery: null, status: "completed" },
      {
        reason: "stale-provider-session",
        before: null,
        after: "continuity-thread-2",
        recovery: JSON.stringify({ restoredMessageCount: 4, omittedMessageCount: 0 }),
        status: "completed",
      },
      { reason: "same-continuation", before: "continuity-thread-2", after: "continuity-thread-2", recovery: null, status: "completed" },
    ],
    sessions: [{ session: "continuity-thread-2" }],
  });

  await recoveryNotes.scrollIntoViewIfNeeded();
  const screenshot = test.info().outputPath("new-provider-session.png");
  await app.page.screenshot({ animations: "disabled", path: screenshot });
  await test.info().attach("new-provider-session", { path: screenshot, contentType: "image/png" });

  await app.restart();
  const restored = app.page.locator('[aria-label="Provider session"]');
  await expect(restored).toHaveCount(1);
  await expect(restored).toContainText("4 earlier messages restored");
  expect(app.rendererErrors).toEqual([]);
});

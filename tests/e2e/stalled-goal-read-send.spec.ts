// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { createAppFixture } from "./support/app-fixture";

const providerSessionId = "44444444-4444-4444-8444-444444444444";
const markerPrefix = "stalled-goal-read-";

const stalledGoalReadAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const markerDirectory = path.join(process.cwd(), ".git");
const markerPrefix = "${markerPrefix}";
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};
const pendingGoalReads = () => fs.readdirSync(markerDirectory)
  .filter((name) => name.startsWith(markerPrefix))
  .map((name) => Number(name.slice(markerPrefix.length)))
  .filter(alive).length;
let threadId = "${providerSessionId}";
let turnIndex = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    return send({ id: message.id, result: { userAgent: "stalled-goal-read-fixture" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "config/read") return send({ id: message.id, result: { config: {} } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") {
    return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
  if (message.method === "thread/goal/get") {
    fs.writeFileSync(path.join(markerDirectory, markerPrefix + process.pid), "");
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  }
  if (message.method !== "turn/start") return;
  turnIndex += 1;
  const turnId = "stalled-goal-read-turn-" + turnIndex;
  const turn = { id: turnId, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "stalled-goal-read-answer", delta: "Goal reads still open: " + pendingGoalReads() } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;

test("a send goes through while a Codex goal read is still unanswered", async () => {
  test.setTimeout(60_000);
  const app = await createAppFixture({
    name: "stalled-goal-read-send",
    initialState: "conversation",
    claudeAuthSource: "process.exit(1);",
    codexAppServerSource: stalledGoalReadAppServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const conversationId = store.shellSnapshot().activeConversationId;
      if (!conversationId) throw new Error("The fixture has no conversation.");
      const selection = providerNativeModelSelection({ providerId: "codex" });
      store.updateConversation(conversationId, {
        modelSelection: selection,
        continuationIdentity: continuationIdentityForSelection(selection, null, false),
        providerSessionId,
      });
      store.close();
    },
  });
  try {
    const { page } = app;
    const markerDirectory = join(app.workspaceDirectory, ".git");
    await expect.poll(async () => (await readdir(markerDirectory))
      .some((name) => name.startsWith(markerPrefix))).toBe(true);

    await page.getByRole("textbox", { name: "Message" })
      .fill("Send while the goal read is open");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText(/^Goal reads still open: [1-9]\d*$/u)).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

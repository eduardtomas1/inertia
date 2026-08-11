import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import {
  createAppFixture,
  type RuntimeTestSnapshot,
} from "./support/app-fixture";

const providerSessionId = "33333333-3333-4333-8333-333333333333";

const goalAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const statePath = path.join(
  process.cwd(),
  ".git",
  "goal-reliability-state.json",
);
let threadId = "${providerSessionId}";
let turnId = "goal-turn-1";
const readGoal = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return null; }
};
const writeGoal = (goal) => fs.writeFileSync(statePath, JSON.stringify(goal));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "goal-reliability-fixture" } });
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
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal: readGoal() } });
    return;
  }
  if (message.method === "thread/goal/clear") {
    try { fs.unlinkSync(statePath); } catch {}
    send({ id: message.id, result: {} });
    send({ method: "thread/goal/cleared", params: { threadId } });
    return;
  }
  if (message.method !== "thread/goal/set") return;
  const activeGoal = {
    threadId,
    objective: message.params.objective,
    status: "active",
    tokenBudget: message.params.tokenBudget ?? null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1800000000,
    updatedAt: 1800000000,
  };
  writeGoal(activeGoal);
  send({ id: message.id, result: { goal: activeGoal } });
  send({ method: "thread/goal/updated", params: { threadId, goal: activeGoal } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "goal-message-1", delta: "First automatic goal turn." } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
  setTimeout(() => {
    turnId = "goal-turn-2";
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "goal-message-2", delta: " Second automatic goal turn." } });
    const completedGoal = {
      ...activeGoal,
      status: "complete",
      tokensUsed: 9000,
      timeUsedSeconds: 8,
      updatedAt: 1800000008,
    };
    writeGoal(completedGoal);
    send({ method: "thread/goal/updated", params: { threadId, turnId, goal: completedGoal } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
  }, 50);
});
`;

test("runs and persists a budgeted native goal across automatic turns", async () => {
  const app = await createAppFixture({
    name: "goal-reliability",
    initialState: "conversation",
    codexAppServerSource: goalAppServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const selection = nativeModelSelection({ providerId: "codex" });
      const continuationIdentity = continuationIdentityForSelection(
        selection,
        null,
        false,
      );
      const conversationId = store.shellSnapshot().activeConversationId;
      if (!conversationId) throw new Error("Goal fixture has no conversation.");
      store.updateConversation(conversationId, {
        modelSelection: selection,
        continuationIdentity,
        providerSessionId,
      });
      store.close();
    },
  });

  try {
    await app.resizeWindow(1280, 860);
    const { page } = app;
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("/goal");
    await page.getByRole("option", { name: /^\/goal/u }).click();
    const goalControl = page.getByRole("region", { name: "Codex goal" });
    await expect(goalControl).toBeVisible();
    await goalControl.getByRole("textbox", { name: "Objective" })
      .fill("Ship the reliable goal flow");
    await goalControl.getByRole("spinbutton", {
      name: "Token budget (optional)",
    }).fill("12000");
    await goalControl.getByRole("button", { name: "Set Codex goal" })
      .click();

    await expect(page.getByText("/goal Ship the reliable goal flow", {
      exact: true,
    })).toBeVisible();
    await expect(page.getByText("Second automatic goal turn.", {
      exact: false,
    })).toBeVisible({ timeout: 15_000 });

    await composer.fill("/goal");
    await page.getByRole("option", { name: /^\/goal/u }).click();
    await expect(goalControl.getByText("Ship the reliable goal flow", {
      exact: true,
    })).toBeVisible();
    await expect(goalControl.getByText("Complete", { exact: true }))
      .toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Open workspace tools" }).click();
    const tools = page.getByRole("complementary", { name: "Workspace tools" });
    await tools.getByRole("tab", { name: /^Goal/u }).click();
    await expect(tools.getByRole("progressbar", {
      name: "Goal token budget used",
    })).toHaveAttribute("aria-valuenow", "75");

    const before = await app.runtimeSnapshot();
    await app.electronApp.evaluate(() => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        crash: () => RuntimeTestSnapshot;
      } | undefined;
      if (!runtime) throw new Error("The test runtime supervisor is unavailable");
      runtime.crash();
    });
    await expect.poll(async () => {
      const current = await app.runtimeSnapshot();
      return current.phase === "ready" && current.generation > before.generation;
    }, { timeout: 10_000 }).toBe(true);
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-connection-status",
      "online",
    );
    await expect(tools.getByText("Ship the reliable goal flow", {
      exact: true,
    })).toBeVisible({ timeout: 10_000 });
    await expect(tools.getByText("Complete", { exact: true })).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

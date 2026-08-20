import { expect, test, type Locator } from "@playwright/test";
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
import {
  ensureWorkspaceTools,
  selectWorkspaceTool,
} from "./support/workspace-tools";

const providerSessionId = "33333333-3333-4333-8333-333333333333";

async function expectResumeGoalState(tools: Locator): Promise<void> {
  const resumeGoal = tools.getByRole("button", { name: "Resume goal" });
  const safetyWarning = tools.getByText(
    /Changes are unavailable in recovery safety mode/u,
  );
  await expect.poll(async () => {
    const [safetyLocked, resumeEnabled] = await Promise.all([
      safetyWarning.isVisible(),
      resumeGoal.isEnabled(),
    ]);
    return safetyLocked ? !resumeEnabled : resumeEnabled;
  }).toBe(true);
  if (await safetyWarning.isVisible()) {
    await expect(resumeGoal).toBeDisabled();
  } else {
    await expect(resumeGoal).toBeEnabled();
  }
}

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
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return null; }
};
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
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
    send({ id: message.id, result: { goal: readState()?.goal ?? null } });
    return;
  }
  if (message.method === "thread/goal/clear") {
    try { fs.unlinkSync(statePath); } catch {}
    send({ id: message.id, result: {} });
    send({ method: "thread/goal/cleared", params: { threadId } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
    return;
  }
  if (message.method !== "thread/goal/set") return;
  const previous = readState();
  const activationCount = (previous?.activationCount ?? 0) + 1;
  turnId = "goal-turn-" + activationCount;
  const activeGoal = {
    threadId,
    objective: message.params.objective || previous?.goal?.objective,
    status: "active",
    tokenBudget: message.params.tokenBudget !== undefined
      ? message.params.tokenBudget
      : previous?.goal?.tokenBudget ?? null,
    tokensUsed: activationCount * 1000,
    timeUsedSeconds: activationCount,
    createdAt: 1800000000,
    updatedAt: 1800000000 + activationCount,
  };
  writeState({ activationCount, goal: activeGoal });
  send({ id: message.id, result: { goal: activeGoal } });
  send({ method: "thread/goal/updated", params: { threadId, goal: activeGoal } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  const output = activationCount === 1
    ? "First-action goal run is active."
    : "Resumed goal run is active.";
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "goal-message-" + activationCount, delta: output } });
});
`;

test("starts a sessionless goal and recovers it after Stop and runtime crash", async () => {
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
    await expect(goalControl).toBeVisible({ timeout: 15_000 });
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
    await expect(page.getByText("First-action goal run is active.", {
      exact: true,
    })).toBeVisible({ timeout: 15_000 });

    const tools = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(tools, "Goal");
    await expect(tools.getByRole("button", { name: "Pause" })).toBeVisible();

    await page.getByRole("button", { name: "Stop agent", exact: true }).click();
    await expect(tools.getByRole("button", { name: "Resume goal" }))
      .toBeVisible({ timeout: 10_000 });
    await tools.getByRole("button", { name: "Resume goal" }).click();
    await expect(page.getByText("Resumed goal run is active.", {
      exact: true,
    })).toBeVisible({ timeout: 15_000 });
    await expect(tools.getByRole("button", { name: "Pause" })).toBeVisible();

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
    await expect(tools.getByText("Active", { exact: true })).toBeVisible();
    await expect(tools.getByRole("button", { name: "Resume goal" }))
      .toBeVisible({ timeout: 10_000 });
    await expectResumeGoalState(tools);
    await expect(tools.getByText(/no Inertia run is connected/u))
      .toBeVisible();

    await page.reload();
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-connection-status",
      "online",
    );
    const reloadedTools = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(reloadedTools, "Goal");
    await expect(reloadedTools.getByText("Ship the reliable goal flow", {
      exact: true,
    })).toBeVisible({ timeout: 10_000 });
    await expect(reloadedTools.getByText("Active", { exact: true }))
      .toBeVisible();
    await expect(reloadedTools.getByRole("button", { name: "Resume goal" }))
      .toBeVisible();
    await expectResumeGoalState(reloadedTools);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

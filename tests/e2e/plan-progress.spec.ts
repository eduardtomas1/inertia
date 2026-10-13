// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const FIXED_NOW = Date.parse("2026-10-13T12:00:00.000Z");
const BUILD_GATE = "plan-progress-build-complete";
const STEPS = [
  "Read the checklist the provider reports",
  "Keep the plan document in the Plan tab",
  "Show each step's reported status",
];
const PLAN = [
  "# Plan: Reflect provider progress",
  "",
  "## Context",
  "",
  "The Plan tab should follow the provider's own checklist while the plan stays readable.",
  "",
  "## Steps",
  "",
  ...STEPS.map((step, index) => `${index + 1}. ${step}`),
].join("\n");

const planAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const steps = ${JSON.stringify(STEPS)};
let threadId = "plan-progress-thread";
let turnSequence = 0;
const complete = (turnId, text) => {
  send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { id: turnId + "-answer", type: "agentMessage", text, phase: "final_answer" } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
};
const completeWhenReleased = (turnId) => {
  if (!fs.existsSync(path.join(process.cwd(), ".git", ${JSON.stringify(BUILD_GATE)}))) {
    setTimeout(() => completeWhenReleased(turnId), 50);
    return;
  }
  complete(turnId, "Two steps are done and the third is still running.");
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "plan-progress-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const turnId = "plan-progress-turn-" + turnSequence;
  const turn = { id: turnId, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  if (message.params.collaborationMode?.mode === "plan") {
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { id: turnId + "-plan", type: "plan", text: ${JSON.stringify(PLAN)} } } });
    complete(turnId, "The plan is ready.");
    return;
  }
  send({ method: "turn/plan/updated", params: { threadId, turnId, explanation: null, plan: [
    { step: steps[0], status: "completed" },
    { step: steps[1], status: "completed" },
    { step: steps[2], status: "inProgress" },
  ] } });
  completeWhenReleased(turnId);
});
`;

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "plan-progress", initialState: "conversation", codexAppServerSource: planAppServer });
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app.close();
});

async function capture(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await app.page.mouse.move(0, 0);
  await app.page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

function turnModes(): string[] {
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return (database.prepare("SELECT interaction_mode FROM agent_turns ORDER BY requested_at, id").all() as Array<{ interaction_mode: string }>)
      .map(({ interaction_mode: mode }) => mode);
  } finally {
    database.close();
  }
}

async function expectSteps(plan: Locator, statuses: readonly string[]): Promise<void> {
  const steps = plan.locator(".plan-steps > li");
  await expect(steps.locator(".plan-step-title")).toHaveText(STEPS.map((step, index) => `${index + 1}. ${step}`));
  await expect.poll(() => steps.evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-plan-step-status")))).toEqual(statuses);
}

async function expectPlanDocument(plan: Locator): Promise<void> {
  await expect(plan.getByRole("heading", { level: 2, name: "Reflect provider progress" })).toBeVisible();
  await expect(plan.locator(".plan-document h2").first()).toHaveText("Context");
  await expect(plan.locator(".plan-document")).toContainText("The Plan tab should follow the provider's own checklist");
}

test("the Plan tab keeps the plan and follows the provider's step progress", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  const composer = page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("button", { name: "Choose work mode" }).click();
  await page.getByRole("menu", { name: "Work mode" }).getByRole("menuitemradio", { name: /^Plan/u }).click();
  await composer.getByRole("textbox", { name: "Message" }).fill("Plan how the Plan tab should follow provider progress.");
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("The plan is ready.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Turn 1" }).getByRole("group", { name: "Changed by this turn" }))
    .toContainText("0 files changed", { timeout: 30_000 });

  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Plan");
  const plan = panel.getByRole("region", { name: "Implementation plan" });
  await expectPlanDocument(plan);
  await expect(plan.getByText("0 of 3 complete", { exact: true })).toBeVisible();
  await expectSteps(plan, ["pending", "pending", "pending"]);
  await capture(info, "plan-proposed-light-1440x1100");

  await plan.getByRole("button", { name: "Implement", exact: true }).click();
  await expect(page.locator(".message.is-user").last()).toContainText("Implement the plan above and validate the result.");
  expect(turnModes()).toEqual(["plan", "build"]);
  await selectWorkspaceTool(panel, "Plan");
  await expect(plan.getByText("2 of 3 complete", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expectPlanDocument(plan);
  await expectSteps(plan, ["completed", "completed", "in-progress"]);
  await expect(plan.getByRole("button", { name: "Implement", exact: true })).toHaveCount(0);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const [width, height] of [[1440, 1100], [760, 600]] as const) {
    await app.resizeWindow(width, height);
    const visiblePanel = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(visiblePanel, "Plan");
    await expect(plan.getByText("2 of 3 complete", { exact: true })).toBeVisible();
    for (const theme of ["dark", "light"] as const) {
      await setAppearanceInPlace(app, theme);
      await app.expectNoViewportOverflow();
      await capture(info, `plan-after-${theme}-${width}x${height}`);
    }
  }

  await app.resizeWindow(1440, 1100);
  await writeFile(join(app.workspaceDirectory, ".git", BUILD_GATE), "release");
  await expect(page.getByText("Two steps are done and the third is still running.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  const reloadedPanel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(reloadedPanel, "Plan");
  const reloadedPlan = reloadedPanel.getByRole("region", { name: "Implementation plan" });
  await expectPlanDocument(reloadedPlan);
  await expect(reloadedPlan.getByText("2 of 3 complete", { exact: true })).toBeVisible();
  await expectSteps(reloadedPlan, ["completed", "completed", "in-progress"]);
  expect(app.rendererErrors).toEqual([]);
});

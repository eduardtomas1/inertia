// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

// Deterministic provider boundary fixture. The real runtime constructs the
// prompt, validates every mapping, persists the result and refreshes the UI.
const provider = `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv.includes("--help")) { process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n"); process.exit(0); }
const threadId = "scope-review-fixture";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ id: message.id, result });
  if (message.method === "initialize") return reply({ userAgent: "scope-review-fixture" });
  if (message.method === "model/list") return reply({ data: [], nextCursor: null });
  if (message.method === "account/rateLimits/read") return reply({ rateLimits: null, rateLimitsByLimitId: null });
  if (message.method === "thread/goal/get") return reply({ goal: null });
  if (["thread/start", "thread/resume"].includes(message.method)) return reply({ thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null });
  if (message.method !== "turn/start") return;
  const prompt = message.params.input.filter((item) => item.type === "text").map((item) => item.text).join("\\n");
  const inventory = JSON.parse(prompt.split("Required inventory: ")[1].split("\\n")[0]);
  const brief = JSON.parse(prompt.split("Review brief: ")[1].split("\\n")[0]);
  const requirements = brief.requirements.map((_, requirementIndex) => ({ requirementIndex, evidence: [] }));
  const unexplained = [];
  const files = inventory.map((file) => {
    for (const hunk of file.hunks) {
      const target = { path: file.path, hunkId: hunk.hunkId, confidence: "medium", reason: "" };
      if (file.path === "retry.ts") requirements[0].evidence.push({ ...target, kind: "implementation", reason: "The retry limit increases from one attempt to three." });
      else if (file.path === "retry.test.ts") requirements[1].evidence.push({ ...target, kind: "test", reason: "An assertion covers the retry limit. Its execution result is unknown." });
      else unexplained.push({ ...target, reason: "Disabling authentication has no clear connection to retry handling." });
    }
    return { path: file.path, summary: "Changes visible in the complete diff.", classifications: [], hunks: file.hunks.map((hunk) => ({ hunkId: hunk.hunkId, summary: "Changed behavior.", classifications: [] })) };
  });
  const output = JSON.stringify({ overall: "Retry handling and its test were updated." + (unexplained.length ? " An authentication edit needs explanation." : ""), classifications: [], files, scopeReview: { requirements, unexplained } });
  const turn = { id: "scope-turn", status: "inProgress", items: [], error: null };
  reply({ turn });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta: output } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;

let app: AppFixture;
test.afterEach(async () => { await app?.close(); });

test("reviews the brief, drafts an unexpected-change request, and refreshes after correction", async ({ browserName: _browserName }, testInfo) => {
  app = await createAppFixture({ name: "scope-review", initialState: "conversation", codexAppServerSource: provider,
    beforeLaunch: async ({ workspaceDirectory, testDirectory }) => {
      await writeFile(join(workspaceDirectory, "retry.ts"), "export const maxAttempts = 1;\n");
      await writeFile(join(workspaceDirectory, "retry.test.ts"), "expect(maxAttempts).toBe(1);\n");
      await writeFile(join(workspaceDirectory, "auth.ts"), "export const authenticationRequired = true;\n");
      execFileSync("git", ["add", "."], { cwd: workspaceDirectory });
      execFileSync("git", ["commit", "-m", "Seed review baseline"], { cwd: workspaceDirectory });
      await writeFile(join(workspaceDirectory, "retry.ts"), "export const maxAttempts = 3;\n");
      await writeFile(join(workspaceDirectory, "retry.test.ts"), "expect(maxAttempts).toBe(3);\n");
      await writeFile(join(workspaceDirectory, "auth.ts"), "export const authenticationRequired = false;\n");
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try { store.createMessage(store.snapshot().activeConversationId!, "Add retry handling, capped at three attempts, and test the retry limit. Stop retrying when cancelled; keep other behavior unchanged.", "user"); }
      finally { store.close(); }
    } });
  const { page } = app;
  await app.resizeWindow(1600, 1100);
  await ensureWorkspaceTools(page);
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Changes");
  await page.getByRole("button", { name: "Review against request", exact: true }).click();
  const review = page.getByRole("region", { name: "Review against request", exact: true });
  await review.getByRole("textbox", { name: /Requirements/ }).fill("Retry temporary failures up to three times.\nAdd a test covering the retry limit.\nStop retrying when the request is cancelled.");
  const source = review.getByLabel("Link a user message");
  await source.selectOption({ index: 1 });
  await review.getByRole("button", { name: "Save brief", exact: true }).click();
  await review.getByRole("button", { name: "Review request", exact: true }).click();
  await expect(review.getByText("The retry limit increases from one attempt to three.")).toBeVisible();
  await expect(review.getByText("Disabling authentication has no clear connection to retry handling.")).toBeVisible();
  await expect(review.getByText(/Test changes do not mean tests ran or passed/)).toBeVisible();
  await expect(review.getByText("No visible implementation or test evidence")).toBeVisible();
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: "disabled", scale: "css" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  await capture("request-and-mapped-changes");
  await review.locator(".scope-review-unexplained").getByRole("button", { name: "Draft request" }).click();
  const request = review.getByRole("textbox", { name: "Edit request to agent" });
  await expect(request).toBeFocused();
  await request.fill("Keep authentication unchanged. Remove this unrelated change and explain the retry behavior.");
  await review.getByRole("button", { name: "Add request to prompt" }).scrollIntoViewIfNeeded();
  await capture("unexpected-change-request");
  await review.getByRole("button", { name: "Add request to prompt" }).click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toContainText("Keep authentication unchanged");
  await writeFile(join(app.workspaceDirectory, "auth.ts"), "export const authenticationRequired = true;\n");
  await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
  await expect(review.getByText("Disabling authentication has no clear connection to retry handling.")).toHaveCount(0);
  await review.getByRole("button", { name: "Review request", exact: true }).click();
  await expect(review.getByText("No unconnected changes were identified by this review.")).toBeVisible();
  await review.evaluate((element) => { element.scrollTop = 0; });
  await capture("refreshed-review-after-correction");
  await app.resizeWindow(900, 800);
  await app.expectNoViewportOverflow();
  expect(app.rendererErrors).toEqual([]);
});

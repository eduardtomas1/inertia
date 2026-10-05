// @inertia-e2e-resource isolated
import { expect, test, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../src/server/database";
import type { AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { createModelChooserFixture } from "./support/model-chooser-fixture";
import { focusAppWindow } from "./support/window-focus";

const execFileAsync = promisify(execFile);
const TITLE = "Fix the release parser";
const REQUEST = "Make the release parser accept dotted versions.";
const ANSWER = "The parser now accepts dotted versions, and the tests cover 1.2.3 and 1.2.3.4.";

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createModelChooserFixture("conversation-continuation");
});

test.afterAll(async () => {
  await app?.close();
});

function openStore(): RuntimeStore {
  return new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
}

function seedUsageLimitedChat(branch: string): string {
  const store = openStore();
  try {
    const source = store.snapshot().conversations[0]!;
    store.updateConversation(source.id, { title: TITLE, branch });
    const requestedAt = new Date(Date.now() - 60_000).toISOString();
    const failedAt = new Date(Date.now() - 30_000).toISOString();
    const run = store.createWorkspaceRun({ kind: "agent", projectId: source.projectId, conversationId: source.id,
      label: TITLE, detail: null, status: "running", port: null });
    const { turn } = store.beginAgentTurn({ conversationId: source.id, runId: run.id, content: REQUEST,
      providerId: source.providerId, modelSelection: source.modelSelection, reasoningEffort: source.reasoningEffort,
      accessMode: source.accessMode, interactionMode: source.interactionMode, configurationRevision: 0,
      association: "authoritative", requestedAt });
    store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
    store.createMessage(source.id, ANSWER, "assistant", [], turn.id, failedAt);
    store.updateAgentTurnLifecycle(turn.id, { status: "failed", terminalReason: "provider-error", completedAt: failedAt, updatedAt: failedAt });
    store.updateWorkspaceRun(run.id, { status: "failed", finishedAt: failedAt });
    store.limitResets.markUsageLimited(turn.id);
    store.updateConversation(source.id, { status: "failed" });
    store.createTurnGitArtifact({ turnId: turn.id, status: "unavailable", completeness: "unavailable",
      failureReason: "Not captured in this fixture.", absenceReason: "not-repository" });
    store.selectConversation(source.id);
    return source.id;
  } finally {
    store.close();
  }
}

async function capture(info: TestInfo, name: string): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    const path = info.outputPath(`${name}-${theme}.png`);
    await app.page.mouse.move(0, 0);
    await app.page.screenshot({ path, animations: "disabled" });
    await info.attach(`${name}-${theme}`, { path, contentType: "image/png" });
  }
}

test("continues a usage-limited chat with another model on the same checkout with its context", async ({ browserName: _browserName }, info) => {
  test.setTimeout(120_000);
  const { page } = app;
  await app.resizeWindow(1440, 920);
  const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: app.workspaceDirectory })).stdout.trim();
  expect(branch).not.toBe("");
  const sourceId = seedUsageLimitedChat(branch);
  const before = await app.runtimeSnapshot();
  await app.recycleRuntime();
  await expect.poll(async () => {
    const current = await app.runtimeSnapshot();
    return current.phase === "ready" && current.generation > before.generation;
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  await focusAppWindow(app.electronApp, page);
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();

  const row = page.getByRole("region", { name: "Message composer" }).getByRole("group", { name: "Usage limit" });
  const continueElsewhere = row.getByRole("button", { name: "Continue with another model", exact: true });
  await expect(row.getByText("Usage limit reached", { exact: true })).toBeVisible();
  await expect(continueElsewhere).toBeEnabled();
  await capture(info, "continuation-limited-row");

  await continueElsewhere.focus();
  await page.keyboard.press("Enter");
  const chooser = page.getByRole("dialog", { name: "Choose model" });
  const search = chooser.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeFocused();
  await search.fill("Kimi K3");
  const kimi = chooser.getByRole("grid", { name: "Model results" }).locator(".model-chooser-row-option")
    .filter({ hasText: /K3/u }).filter({ hasText: /Kimi/u, hasNotText: /256K/u });
  await expect(kimi).toBeEnabled();
  await kimi.click();

  const offer = page.getByRole("alertdialog", { name: /^Continue in a new chat with .*K3.*\?$/u });
  await expect(offer).toContainText("Start a new chat to use a different provider.");
  await expect(offer.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await capture(info, "continuation-offer");
  await offer.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(offer).toBeHidden();

  await expect.poll(() => {
    const store = openStore();
    try {
      return store.snapshot().activeConversationId;
    } finally {
      store.close();
    }
  }).not.toBe(sourceId);
  const store = openStore();
  try {
    const destinationId = store.snapshot().activeConversationId!;
    const source = store.conversation(sourceId);
    expect(store.conversation(destinationId)).toMatchObject({
      projectId: source.projectId,
      providerId: "claude",
      branch,
      worktreePath: source.worktreePath,
      providerSessionId: null,
    });
    expect(store.hasConversationMessages(destinationId)).toBe(false);
    expect(store.contextPackets.list(destinationId)).toMatchObject([{
      sourceConversationId: sourceId,
      workspaceRelation: "same-workspace",
      messageCount: 2,
      consumedMessageId: null,
    }]);
  } finally {
    store.close();
  }

  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  const carried = page.getByRole("button", { name: new RegExp(`From ${TITLE}`, "u") });
  await expect(carried).toContainText("2 messages");
  await carried.click();
  const preview = page.getByRole("region", { name: "Shared chat context" });
  await expect(preview).toContainText(REQUEST);
  await expect(preview).toContainText(ANSWER);
  await capture(info, "continuation-new-chat");
  expect(app.rendererErrors).toEqual([]);
});

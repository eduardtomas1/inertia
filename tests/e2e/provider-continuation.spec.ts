// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeWorkspaceTools } from "./support/workspace-tools";

let app!: AppFixture;
let sourceId = "";
let sourceBranch = "";
test.beforeAll(async () => {
  app = await createAppFixture({
    name: "provider-continuation", initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        sourceId = store.shellSnapshot().activeConversationId!;
        sourceBranch = execFileSync("git", ["branch", "--show-current"], { cwd: workspaceDirectory, encoding: "utf8" }).trim();
        store.updateConversation(sourceId, { title: "Make retries safe", branch: sourceBranch, providerSessionId: "source-codex-session" });
        const turn = store.beginAgentTurn({
          id: randomUUID(), conversationId: sourceId, runId: randomUUID(),
          content: "Keep retries idempotent and preserve the existing cursor format.",
          providerId: "codex", harnessId: "codex-app-server", backendProfileId: "builtin:openai", model: "provider-default", reasoningEffort: "",
          interactionMode: "build", accessMode: "supervised", configurationRevision: 0, association: "authoritative", requestedAt: "2026-09-30T09:00:00.000Z",
        }).turn;
        const answer = store.createMessage(sourceId, "The retry state now persists after each batch. Next, verify restart recovery and add the missing regression test.", "assistant", [], turn.id, "2026-09-30T09:01:00.000Z");
        store.updateAgentTurnLifecycle(turn.id, { status: "completed", completedAt: answer.createdAt, updatedAt: answer.createdAt, terminalAssistantMessageId: answer.id, terminalReason: "provider-completed" });
      } finally { store.close(); }
    },
  });
  // Only discovery readiness is stubbed; creation, context, and checkout checks
  // use the real runtime. No real provider is launched by this draft workflow.
  await app.page.routeWebSocket(/.*/u, (route) => {
    route.connectToServer().onMessage((data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      const snapshot = event.type === "server.welcome" || event.type === "snapshot.updated" ? event.snapshot
        : event.type === "runtime.event" && event.event.type === "snapshot.updated" ? event.event.snapshot : null;
      if (snapshot) snapshot.providers = snapshot.providers.map((provider) => provider.id === "claude"
        ? { ...provider, available: true, installState: "installed", authState: "authenticated", canRun: true } : provider);
      route.send(JSON.stringify(event));
    });
  });
  await app.page.reload();
});
test.afterAll(async () => { await app?.close(); });

test("continues a provider-bound chat with selected context, retains drafts, and survives restart", async ({ browserName: _browserName }, testInfo) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await closeWorkspaceTools(page);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Preserve unrelated changes.");
  await page.getByRole("button", { name: /^Choose model\./u }).click();
  const chooser = page.getByRole("dialog", { name: "Choose model" });
  await chooser.getByRole("button", { name: /^Claude, \d+ models?$/u }).click();
  await chooser.getByRole("gridcell").first().click();
  await page.getByRole("button", { name: "Continue with context", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Continue with/u });
  await expect(dialog.getByText("The retry state now persists", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "2 of 2 messages selected" })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Next instruction (optional)" }).fill("Review restart recovery and add the regression test.");
  const preview = testInfo.outputPath("provider-continuation-preview.png");
  await page.screenshot({ path: preview, animations: "disabled" });
  await testInfo.attach("provider-continuation-preview", { path: preview, contentType: "image/png" });
  await app.resizeWindow(760, 800);
  await expect(dialog.getByRole("button", { name: "Create continuation" })).toBeVisible();
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { fits: element.scrollWidth <= element.clientWidth + 1, left: rect.left, right: rect.right, width: innerWidth, bottom: rect.bottom, height: innerHeight };
  });
  expect(geometry.fits).toBe(true);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  await dialog.getByRole("button", { name: "Create continuation" }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue("Preserve unrelated changes.\n\nReview restart recovery and add the regression test.");
  await expect(page.getByRole("button", { name: /From Make retries safe/u })).toBeVisible();
  await app.resizeWindow(1440, 920);
  const destination = testInfo.outputPath("provider-continuation-draft.png");
  await page.screenshot({ path: destination, animations: "disabled" });
  await testInfo.attach("provider-continuation-draft", { path: destination, contentType: "image/png" });
  const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
  let targetId = "";
  try {
    targetId = store.shellSnapshot().activeConversationId!;
    expect(targetId).not.toBe(sourceId);
    expect(store.conversation(targetId)).toMatchObject({ providerId: "claude", branch: sourceBranch, worktreePath: null, providerSessionId: null, continuationIdentity: null });
    expect(store.hasConversationMessages(targetId)).toBe(false);
    expect(store.hasConversationTurns(targetId)).toBe(false);
    expect(store.contextPackets.list(targetId)).toEqual([expect.objectContaining({ sourceConversationId: sourceId, messageCount: 2, consumedMessageId: null })]);
    expect(store.conversation(sourceId)).toMatchObject({ providerId: "codex", providerSessionId: "source-codex-session" });
  } finally { store.close(); }
  const restarted = await app.restart();
  await expect(restarted.page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Preserve unrelated changes.\n\nReview restart recovery and add the regression test.");
  await expect(restarted.page.getByRole("button", { name: /From Make retries safe/u })).toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});

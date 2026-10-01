// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
let projectId: string;
let conversationId: string;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "project-memory", initialState: "conversation", workspaceGit: false, beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
    const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
    try {
      const snapshot = store.shellSnapshot();
      projectId = snapshot.projects[0].id;
      conversationId = snapshot.conversations[0].id;
      const requestedAt = new Date(Date.now() - 5000).toISOString();
      const completedAt = new Date().toISOString();
      const { turn } = store.beginAgentTurn({ id: randomUUID(), conversationId, runId: randomUUID(),
        content: "Keep the invoice calculation consistent with the previous billing cycle.",
        providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
        model: "gpt-5.6", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised",
        configurationRevision: 1, association: "authoritative", requestedAt });
      const answer = store.createMessage(conversationId, "Use the saved proration snapshot. Direct event queries miss previous-cycle plan changes.", "assistant", [], turn.id, completedAt);
      store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: requestedAt,
        completedAt, updatedAt: completedAt, terminalAssistantMessageId: answer.id, terminalReason: "provider-completed" });
      store.updateProject(projectId, { name: "Billing workspace" });
      store.updateSettings({ theme: "dark" });
    } finally { store.close(); }
  } });
});
test.afterEach(async ({ browserName: _browserName }, info) => {
  if (info.status !== info.expectedStatus && app) {
    await info.attach("Project memory failure state", { body: (await app.page.locator("body").innerText()).slice(0, 16000), contentType: "text/plain" });
    await info.attach("Project memory failure view", { body: await app.page.screenshot(), contentType: "image/png" });
  }
});
test.afterAll(async () => { await app?.close(); });

test("curates a message, inspects its source and context, and persists chat exclusions after restart", async ({ browserName: _browserName }, info) => {
  await app.resizeWindow(1280, 920);
  let page = app.page;
  await page.getByRole("button", { name: "Remember for this project", exact: true }).first().click();
  let dialog = page.getByRole("dialog", { name: "Project memory", exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill("Preserve billing history");
  await dialog.getByLabel("Rule or decision", { exact: true }).fill("Use the saved proration snapshot when calculating invoices.");
  await dialog.getByLabel("Why it matters", { exact: true }).fill("Querying billing events directly misses previous-cycle plan changes. Keep the regression test for mid-cycle upgrades.");
  const editorPath = info.outputPath("remember-for-project-dark.png");
  await dialog.screenshot({ path: editorPath, animations: "disabled" });
  await info.attach("Remember for this project", { path: editorPath, contentType: "image/png" });
  await dialog.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Preserve billing history", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: /^From /u }).click();
  await expect.poll(() => dialog.locator(".project-memory-source-preview, [role=alert]").count()).toBeGreaterThan(0);
  expect(await dialog.getByRole("alert").allTextContents()).toEqual([]);
  await expect(dialog.locator(".project-memory-source-preview")).toBeVisible();
  await dialog.getByRole("button", { name: "Inspect included context", exact: true }).click();
  await expect(dialog.getByLabel("Included project context")).toContainText("previous-cycle plan changes");
  const panelPath = info.outputPath("rules-and-decisions-dark.png");
  await page.screenshot({ path: panelPath, animations: "disabled" });
  await info.attach("Rules and decisions with source and context", { path: panelPath, contentType: "image/png" });
  await app.expectNoViewportOverflow();
  await dialog.getByRole("checkbox", { name: "Use in this chat", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Use in this chat", exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel("Included project context")).not.toContainText("previous-cycle plan changes");
  await dialog.getByRole("button", { name: "Close project memory", exact: true }).click();
  await app.restart();
  page = app.page;
  await page.getByRole("button", { name: "Rules & decisions", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Project memory", exact: true });
  await expect(dialog.getByRole("checkbox", { name: "Use in this chat", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Edit Preserve billing history", exact: true }).click();
  await dialog.getByLabel("Why it matters", { exact: true }).fill("The mid-cycle upgrade regression test documents this choice.");
  await dialog.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(dialog.getByText("The mid-cycle upgrade regression test documents this choice.", { exact: true })).toBeVisible();
  const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
  try {
    const state = store.projectMemory.load({ projectId, conversationId });
    expect(state.entries[0].source?.conversationId).toBe(conversationId);
    expect(state.disabledIds).toEqual([state.entries[0].id]);
    expect(store.projectMemory.load({ projectId }).context).toContain("mid-cycle upgrade regression test");
  } finally { store.close(); }
  expect(app.rendererErrors).toEqual([]);
});

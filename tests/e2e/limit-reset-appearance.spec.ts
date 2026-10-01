// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { queuedRouteIdentity } from "../../src/server/persistence/queued-message-repository";
import { createAppFixture } from "./support/app-fixture";

// Persisted pending-plan fixture; actual scheduling/provider execution is covered
// by limit-reset.spec and the ordinary-admission integration tests.
for (const theme of ["light", "dark"] as const) {
  test(`shows the persisted reset plan and snooze action in ${theme}`, async () => {
    const info = test.info();
    const app = await createAppFixture({ name: `limit-reset-${theme}`, initialState: "conversation", workspaceGit: false,
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
        try {
          const conversation = store.snapshot().conversations[0]!;
          store.updateConversation(conversation.id, { title: "Add search filters" });
          const run = store.createWorkspaceRun({ kind: "agent", projectId: conversation.projectId, conversationId: conversation.id, label: "Add search filters", detail: null, status: "running", port: null });
          const turn = store.beginAgentTurn({ conversationId: conversation.id, runId: run.id,
            content: "Add filters for project and status, and keep the search results easy to scan.",
            providerId: conversation.providerId, modelSelection: conversation.modelSelection, model: "gpt-6-astra",
            reasoningEffort: conversation.reasoningEffort, accessMode: conversation.accessMode, interactionMode: conversation.interactionMode,
            configurationRevision: 0, association: "authoritative" }).turn;
          store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: turn.requestedAt });
          store.updateAgentTurnLifecycle(turn.id, { status: "failed", terminalReason: "provider-error", completedAt: new Date().toISOString() });
          store.updateWorkspaceRun(run.id, { status: "failed", finishedAt: new Date().toISOString() });
          store.updateConversation(conversation.id, { status: "failed" });
          store.createTurnGitArtifact({ turnId: turn.id, status: "unavailable", completeness: "unavailable",
            failureReason: "This workspace is not a Git repository.", absenceReason: "not-repository" });
          const resetsAt = new Date(Date.now() + 4 * 3_600_000).toISOString();
          store.limitResets.save({ id: randomUUID(), conversationId: conversation.id, failedTurnId: turn.id,
            routeIdentity: queuedRouteIdentity(store.conversation(conversation.id)), accountIdentity: "fixture-account",
            resetsAt, nextAttemptAt: resetsAt, attempts: 0, state: "waiting", error: null, turnId: null });
          store.updateSettings({ theme });
        } finally { store.close(); }
      },
    });
    try {
      await app.resizeWindow(1440, 1000);
      const { page } = app;
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByText("Resume scheduled", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel resume", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Snooze until reset", exact: true })).toBeVisible();
      await app.expectNoViewportOverflow();
      const banner = await page.getByRole("region", { name: "Usage limit" }).boundingBox();
      const composer = await page.getByRole("region", { name: "Message composer" }).boundingBox();
      expect(banner!.width).toBeCloseTo(composer!.width - 24, 0);
      expect(banner!.x).toBeCloseTo(composer!.x + 12, 0);
      await page.screenshot({ path: info.outputPath(`limit-reset-${theme}.png`), animations: "disabled" });
      await app.resizeWindow(1000, 800);
      await app.expectNoViewportOverflow();
      await page.screenshot({ path: info.outputPath(`limit-reset-${theme}-narrow.png`), animations: "disabled" });
      expect(app.rendererErrors).toEqual([]);
    } finally { await app.close(); }
  });
}

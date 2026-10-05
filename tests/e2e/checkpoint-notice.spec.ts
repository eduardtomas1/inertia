// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import type { Conversation } from "../../src/shared/contracts";
import { createAppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const STARTED_AT = Date.parse("2026-10-05T09:00:00.000Z");

function completedTurn(
  store: RuntimeStore,
  conversation: Conversation,
  content: string,
  answer: string,
  minute: number,
): { turnId: string; runId: string } {
  const requestedAt = new Date(STARTED_AT + minute * 60_000).toISOString();
  const completedAt = new Date(STARTED_AT + (minute + 1) * 60_000).toISOString();
  const run = store.createWorkspaceRun({ kind: "agent", projectId: conversation.projectId,
    conversationId: conversation.id, label: conversation.title, detail: null, status: "running", port: null });
  const { turn } = store.beginAgentTurn({ conversationId: conversation.id, runId: run.id, content,
    providerId: conversation.providerId, modelSelection: conversation.modelSelection,
    reasoningEffort: conversation.reasoningEffort, interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode, configurationRevision: 0, association: "authoritative", requestedAt });
  const reply = store.createMessage(conversation.id, answer, "assistant", [], turn.id, completedAt);
  store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
  store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalReason: "provider-completed",
    terminalAssistantMessageId: reply.id, completedAt, updatedAt: completedAt });
  store.updateWorkspaceRun(run.id, { status: "succeeded", finishedAt: completedAt });
  return { turnId: turn.id, runId: run.id };
}

test("says No checkpoint for this turn beside a request whose checkpoint failed", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({
    name: "checkpoint-notice",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try {
        const conversation = store.snapshot().conversations[0]!;
        const saved = completedTurn(store, conversation, "Rename the config loader.",
          "Renamed the loader and updated its two callers.", 0);
        const checkpoint = store.addCheckpoint({ conversationId: conversation.id,
          ref: "refs/inertia/checkpoints/notice/saved", label: "Before turn 1", turnIndex: 1,
          filesChanged: 0, insertions: 0, deletions: 0 });
        store.associateCheckpointWithTurn(checkpoint.id, conversation.id, saved.runId, saved.turnId);
        const missing = completedTurn(store, conversation, "Add the release script.",
          "Added scripts/release.mjs and documented it in the README.", 5);
        store.addActivity({ conversationId: conversation.id, runId: missing.runId, turnId: missing.turnId,
          kind: "status", title: "No checkpoint for this turn",
          detail: "Checkpoint operation timed out.", status: "completed",
          createdAt: new Date(STARTED_AT + 5 * 60_000 + 1_000).toISOString() });
      } finally { store.close(); }
    },
  });
  try {
    const { page } = app;
    await app.resizeWindow(1440, 920);
    const requests = page.locator(".turn-user-request");
    await expect(requests).toHaveCount(2);
    await expect(requests.nth(0).getByRole("button", { name: "Revert" })).toBeVisible();
    await expect(requests.nth(0)).not.toContainText("No checkpoint for this turn");
    const notice = requests.nth(1).getByText("No checkpoint for this turn", { exact: true });
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("title", "Checkpoint operation timed out.");
    await expect(requests.nth(1).getByRole("button", { name: "Revert" })).toHaveCount(0);
    await expect(page.getByText("No checkpoint for this turn")).toHaveCount(1);

    for (const [theme, width, height] of [
      ["light", 1440, 920],
      ["dark", 1440, 920],
      ["light", 760, 600],
      ["dark", 760, 600],
    ] as const) {
      await app.resizeWindow(width, height);
      await setAppearanceInPlace(app, theme);
      await notice.scrollIntoViewIfNeeded();
      const name = `checkpoint-notice-${theme}-${width}x${height}.png`;
      const path = testInfo.outputPath(name);
      await page.screenshot({ path, animations: "disabled", scale: "css" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
    await app.expectNoViewportOverflow();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

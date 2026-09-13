// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

test("shows the persisted remote device on the desktop transcript after startup", async ({ browserName: _browserName }, testInfo) => {
  const deviceId = "33333333-3333-4333-8333-333333333333";
  const app = await createAppFixture({
    name: "private-connect-message-origin", initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try {
        const conversation = store.snapshot().conversations[0]!;
        const { turn } = store.beginAgentTurn({
          conversationId: conversation.id, runId: randomUUID(), content: "Please check the latest build. Sent from my paired browser.",
          privateConnectDeviceId: deviceId, providerId: conversation.providerId,
          modelSelection: conversation.modelSelection, reasoningEffort: conversation.reasoningEffort,
          interactionMode: conversation.interactionMode, accessMode: conversation.accessMode,
          configurationRevision: 0, association: "authoritative",
        });
        store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: turn.requestedAt,
          completedAt: turn.requestedAt, updatedAt: turn.requestedAt });
      } finally { store.close(); }
    },
  });
  try {
    await app.resizeWindow(1440, 920);
    const origin = app.page.getByTitle(`Private Connect device ${deviceId}`, { exact: true });
    await expect(origin).toBeVisible();
    await expect(origin).toHaveText("Private Connect · 33333333");
    const screenshot = testInfo.outputPath("private-connect-message-origin.png");
    await app.page.locator(".turn-user-request").screenshot({ animations: "disabled", path: screenshot });
    await testInfo.attach("private-connect-message-origin", { path: screenshot, contentType: "image/png" });
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

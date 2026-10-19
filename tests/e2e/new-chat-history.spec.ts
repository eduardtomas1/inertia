// @inertia-e2e-resource isolated
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
test.beforeAll(async () => {
  app = await createAppFixture({ name: "new-chat-history", initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const conversationId = store.shellSnapshot().activeConversationId!;
        for (let index = 0; index < 85; index++) {
          const at = new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString();
          const { turn } = store.beginAgentTurn({ id: randomUUID(), runId: randomUUID(), conversationId,
            content: `History request ${index}`, providerId: "codex", harnessId: "codex-app-server",
            backendProfileId: "native:codex:app-server", model: "test", reasoningEffort: "",
            interactionMode: "build", accessMode: "supervised", configurationRevision: 0,
            association: "authoritative", requestedAt: at });
          const message = store.createMessage(conversationId, `History answer ${index}.`, "assistant", [], turn.id, at);
          store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalReason: "provider-completed",
            terminalAssistantMessageId: message.id, startedAt: at, completedAt: at, updatedAt: at });
        }
      } finally { store.close(); }
    } });
});
test.afterAll(async () => { await app?.close(); });

test("starts a new chat without offering the previous chat's earlier messages", async () => {
  const { page } = app;
  const loadEarlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await expect(loadEarlier).toBeAttached();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: /What should we build/u })).toBeVisible();
  await expect(loadEarlier).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

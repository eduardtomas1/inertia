// @inertia-e2e-resource isolated
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
test.beforeAll(async () => {
  app = await createAppFixture({ name: "paged-history-focus", initialState: "conversation",
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

test("keyboard activation of Load earlier messages keeps focus in the transcript", async () => {
  const { page } = app;
  const transcript = page.getByLabel("Thread transcript", { exact: true });
  const feed = (turns: number) => page.getByRole("feed", { name: `${turns} conversation turns`, exact: true });
  await expect(feed(40)).toBeAttached();
  await transcript.press("Home");
  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await earlier.scrollIntoViewIfNeeded();
  await earlier.focus();
  await expect(earlier).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(feed(80)).toBeAttached();
  await expect(earlier).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(feed(85)).toBeAttached();
  await expect(page.getByRole("button", { name: /earlier messages/u })).toHaveCount(0);
  await expect(transcript).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});

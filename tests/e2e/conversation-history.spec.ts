// @inertia-e2e-resource isolated
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
const turns: string[] = [];
test.beforeAll(async () => {
  app = await createAppFixture({ name: "paged-history", initialState: "conversation",
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
          const message = store.createMessage(conversationId, `History answer ${index}.\n\n${"A saved explanation. ".repeat(24)}`, "assistant", [], turn.id, at);
          store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalReason: "provider-completed",
            terminalAssistantMessageId: message.id, startedAt: at, completedAt: at, updatedAt: at });
          turns.push(turn.id);
        }
      } finally { store.close(); }
    } });
});
test.afterAll(async () => { await app?.close(); });

test("loads older pages without moving the reading position or losing the oldest turn", async () => {
  const { page } = app;
  const transcript = page.getByLabel("Thread transcript", { exact: true });
  await transcript.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await earlier.scrollIntoViewIfNeeded();
  const anchor = page.locator(`[data-turn-id="${turns[45]}"]`).first();
  await expect(anchor).toBeInViewport();
  let before = 0;
  await expect.poll(async () => {
    const bounds = await anchor.boundingBox();
    if (bounds) before = bounds.y;
    return Boolean(bounds);
  }).toBe(true);
  await earlier.click();
  await expect(page.getByRole("button", { name: "Loading earlier messages…" })).toHaveCount(0);
  await expect.poll(async () => {
    const bounds = await anchor.boundingBox();
    return bounds ? Math.abs(bounds.y - before) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(4);
  await earlier.scrollIntoViewIfNeeded();
  await earlier.click();
  await expect(earlier).toHaveCount(0);
  await transcript.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
  const oldest = page.locator(`[data-turn-id="${turns[0]}"]`).first();
  await oldest.scrollIntoViewIfNeeded();
  await expect(oldest).toBeInViewport();
  await app.expectNoViewportOverflow();
  expect(app.rendererErrors).toEqual([]);
});

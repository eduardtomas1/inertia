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

test("loads older pages without moving the reading position or losing the oldest turn", async ({ browserName: _browserName }, info) => {
  const { page } = app;
  const transcript = page.getByLabel("Thread transcript", { exact: true });
  // Begin after the initial latest-answer navigation has mounted its target.
  await expect(page.locator(`[data-turn-id="${turns.at(-1)}"]`).first()).toBeInViewport();
  await transcript.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await earlier.scrollIntoViewIfNeeded();
  const anchor = page.locator(`[data-turn-id="${turns[45]}"]`).first();
  await expect(anchor).toBeInViewport();
  let before = 0;
  const positions: unknown[] = [];
  const observe = async () => {
    const position = await transcript.evaluate((scroll) => {
      const bounds = scroll.getBoundingClientRect();
      return { at: performance.now(), scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight,
        viewport: { top: bounds.top, height: bounds.height },
        rows: [...scroll.querySelectorAll<HTMLElement>("[data-response-row-id]")].map((row) => ({
          id: row.dataset.responseRowId, top: row.getBoundingClientRect().top,
          height: row.getBoundingClientRect().height,
        })) };
    });
    positions.push(position);
    return position;
  };
  await expect.poll(async () => {
    const bounds = await anchor.boundingBox();
    if (bounds) before = bounds.y;
    return Boolean(bounds);
  }).toBe(true);
  await observe();
  await earlier.click();
  await expect(page.getByRole("button", { name: "Loading earlier messages…" })).toHaveCount(0);
  try {
    await expect.poll(async () => {
      const position = await observe();
      const row = position.rows.find(({ id }) => id === turns[45]);
      return row ? Math.abs(row.top - before) : Number.POSITIVE_INFINITY;
    }).toBeLessThan(4);
  } finally {
    await info.attach("prepend-positions", { body: JSON.stringify({ anchor: turns[45], before, positions }, null, 2), contentType: "application/json" });
    await info.attach("prepend-viewport", { body: await page.screenshot(), contentType: "image/png" });
  }
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

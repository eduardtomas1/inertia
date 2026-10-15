// @inertia-e2e-resource isolated
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { readFromTranscriptStart } from "./support/conversation-history";

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

test("loads older pages at the transcript start without moving the reading position or losing the oldest turn", async ({ browserName: _browserName }, info) => {
  const { page } = app;
  const transcript = page.getByLabel("Thread transcript", { exact: true });
  const feed = (count: number) => page.getByRole("feed", { name: `${count} conversation turns`, exact: true });
  await expect(page.locator(`[data-turn-id="${turns.at(-1)}"]`).first()).toBeInViewport();
  await expect(feed(40)).toBeAttached();
  await transcript.evaluate((scroll, anchorId) => {
    const samples: { count: number; top: number | null }[] = [];
    Reflect.set(window, "__historySamples", samples);
    const sample = () => {
      const label = scroll.querySelector('[role="feed"]')?.getAttribute("aria-label") ?? "";
      const row = scroll.querySelector<HTMLElement>(`[data-response-row-id="${anchorId}"]`);
      samples.push({ count: Number(/^(\d+) /u.exec(label)?.[1] ?? 0),
        top: row ? row.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null });
      if (samples.length < 3_000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, turns[45]);
  await transcript.evaluate((scroll) => {
    scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    scroll.scrollTop = 0;
  });
  await expect(feed(80)).toBeAttached();
  await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toBeAttached();
  let samples: { count: number; top: number | null }[] = [];
  try {
    await expect.poll(async () => {
      samples = await page.evaluate(() => Reflect.get(window, "__historySamples") as { count: number; top: number | null }[]);
      const before = samples.filter(({ count, top }) => count === 40 && top !== null).at(-1);
      const after = samples.filter(({ count, top }) => count === 80 && top !== null).at(-1);
      return before && after ? Math.abs(after.top! - before.top!) : Number.POSITIVE_INFINITY;
    }).toBeLessThan(4);
  } finally {
    await info.attach("prepend-positions", { body: JSON.stringify({ anchor: turns[45], samples }, null, 2), contentType: "application/json" });
    await info.attach("prepend-viewport", { body: await page.screenshot(), contentType: "image/png" });
  }
  await readFromTranscriptStart(page);
  await expect(feed(turns.length)).toBeAttached();
  await expect(page.getByRole("button", { name: /earlier messages/u })).toHaveCount(0);
  const oldest = page.locator(`[data-turn-id="${turns[0]}"]`).first();
  await expect(async () => {
    await transcript.press("Home");
    await expect(oldest).toBeInViewport({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await app.expectNoViewportOverflow();
  expect(app.rendererErrors).toEqual([]);
});

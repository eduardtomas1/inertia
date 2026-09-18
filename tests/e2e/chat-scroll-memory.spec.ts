// @inertia-e2e-resource primary-display
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

for (const turnCount of [4, 80]) {
test(`returns to the same historical row after navigating through an empty chat (${turnCount} turns)`, async () => {
  const app = await createAppFixture({
    name: "scroll-memory", initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const shell = store.shellSnapshot();
        const conversation = store.conversation(shell.activeConversationId!);
        store.updateConversation(conversation.id, { title: "Scroll history A" });
        store.createConversation(conversation.projectId, "Scroll empty B", { modelSelection: conversation.modelSelection });
        for (let index = 0; index < turnCount; index += 1) {
          const at = new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString();
          const { turn } = store.beginAgentTurn({
            id: randomUUID(), conversationId: conversation.id, runId: randomUUID(),
            content: `Request ${index}: preserve this reader position.`, providerId: "codex",
            harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
            model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
            configurationRevision: 0, association: "authoritative", requestedAt: at,
          });
          const answer = store.createMessage(conversation.id, `Answer ${index}.\n\n${"Historical context remains visible. ".repeat(24)}`, "assistant", [], turn.id, at);
          store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: at, completedAt: at, updatedAt: at, terminalAssistantMessageId: answer.id, terminalReason: "provider-completed" });
        }
        store.selectConversation(conversation.id);
      } finally { store.close(); }
    },
  });
  try {
    const page = app.page;
    await app.resizeWindow(1440, 920);
    const transcript = page.getByLabel("Thread transcript");
    await expect(page.getByRole("heading", { name: "Scroll history A", level: 1 })).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(120);
    if (turnCount > 4) {
      await expect(transcript.getByRole("feed", { name: `${turnCount} conversation turns` })).toBeVisible();
    } else {
      await expect(transcript.locator(".response-static-item")).toHaveCount(turnCount);
    }
    await page.bringToFront();
    await transcript.hover();
    await page.mouse.wheel(0, turnCount > 4 ? -2_800 : -600);
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    const position = () => transcript.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>("[data-response-row-id]")]
        .find((item) => item.getBoundingClientRect().bottom > top + 8);
      return { id: row?.dataset.responseRowId, offset: row ? row.getBoundingClientRect().top - top : 0, scrollTop: element.scrollTop };
    });
    await expect.poll(async () => (await position()).scrollTop).toBeGreaterThan(100);
    let lastTop = -1;
    let stable = 0;
    await expect.poll(async () => {
      const current = (await position()).scrollTop;
      stable = Math.abs(current - lastTop) < 1 ? stable + 1 : 0;
      lastTop = current;
      return stable;
    }).toBeGreaterThanOrEqual(3);
    const before = await position();
    expect(before.id).toBeTruthy();
    await page.locator(".activity-thread-select").filter({ hasText: "Scroll empty B" }).click();
    await expect(page.getByRole("heading", { name: "Scroll empty B", level: 1 })).toBeVisible();
    await page.locator(".activity-thread-select").filter({ hasText: "Scroll history A" }).click();
    await expect(page.getByRole("heading", { name: "Scroll history A", level: 1 })).toBeVisible();
    await expect.poll(async () => (await position()).id).toBe(before.id);
    await expect.poll(async () => Math.abs((await position()).offset - before.offset)).toBeLessThan(3);
    await page.getByRole("button", { name: "Jump to latest" }).click();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(120);
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

}

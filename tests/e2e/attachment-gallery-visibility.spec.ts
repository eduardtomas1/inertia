// @inertia-e2e-resource primary-display
import { createCanvas } from "@napi-rs/canvas";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

test("keeps offscreen gallery originals unloaded and opens a retained 40-megapixel image by keyboard", async ({ browserName: _browserName }, testInfo) => {
  const largeId = randomUUID();
  const app = await createAppFixture({
    name: "gallery-visibility", initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const canvas = createCanvas(8_000, 5_000);
      canvas.getContext("2d").fillRect(0, 0, 8_000, 5_000);
      const large = canvas.toBuffer("image/png");
      const small = await readFile(join(testDirectory, "preview.png"));
      const data = join(testDirectory, "data");
      const files = await ConversationAttachmentStore.open(data);
      const store = new RuntimeStore(join(data, "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const conversationId = store.shellSnapshot().activeConversationId!;
        for (let index = 0; index < 60; index += 1) {
          const id = index === 0 ? largeId : randomUUID();
          const bytes = index === 0 ? large : small;
          const attachments = await files.retain([{
            attachment: { id, path: id, name: `gallery-${index}.png`, mimeType: "image/png", size: bytes.length }, bytes,
          }]);
          const at = new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString();
          const { turn } = store.beginAgentTurn({
            id: randomUUID(), conversationId, runId: randomUUID(), content: `Image ${index}`,
            attachments, providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
            model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
            configurationRevision: 0, association: "authoritative", requestedAt: at,
          });
          const reply = store.createMessage(conversationId, "Saved image.", "assistant", [], turn.id, at);
          store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: at, completedAt: at, updatedAt: at,
            terminalAssistantMessageId: reply.id, terminalReason: "provider-completed" });
        }
      } finally { store.close(); await files.close(); }
    },
  });
  try {
    const { page } = app;
    const memorySamples: Array<{ stage: string; workingSetKiB: number }> = [];
    const sampleMemory = async (stage: string): Promise<void> => {
      const workingSetKiB = await app.electronApp.evaluate(({ app }) => app.getAppMetrics()
        .reduce((total, metric) => total + metric.memory.workingSetSize, 0));
      memorySamples.push({ stage, workingSetKiB });
    };
    await app.resizeWindow(1440, 920);
    // Recent attachments live in the right panel's Attachments surface.
    await selectWorkspaceTool(await ensureWorkspaceTools(page), "Attachments");
    const gallery = page.getByRole("list", { name: "Chat attachments" });
    await expect(gallery.getByRole("listitem")).toHaveCount(60);
    const first = gallery.getByRole("button", { name: "Preview attachment gallery-59.png" });
    const last = gallery.getByRole("button", { name: "Preview attachment gallery-0.png" });
    await expect.poll(() => first.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(last.locator("img")).toHaveCount(0);
    await sampleMemory("retained gallery; 40 MP original offscreen");

    const mountedImagesAreVisible = () => gallery.evaluate((list) => {
      const clip = list.parentElement!.getBoundingClientRect();
      const images = [...list.querySelectorAll("img")];
      return images.length > 0 && images.length < 60 && images.every((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom >= clip.top && rect.top <= clip.bottom
          && rect.bottom >= 0 && rect.top <= innerHeight;
      });
    });
    await expect.poll(mountedImagesAreVisible).toBe(true);
    // All buttons remain focusable. Native focus scrolls the last tile into
    // view, which loads its original without decoding the intervening rows.
    await last.focus();
    await expect(last).toBeFocused();
    await expect(first.locator("img")).toHaveCount(0);
    await expect.poll(() => last.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(8_000);
    await expect(last.locator("img")).toHaveAttribute("src", `inertia://bundle/attachment-preview/${largeId}`);
    await expect.poll(mountedImagesAreVisible).toBe(true);
    await page.keyboard.press("Enter");
    const preview = page.getByRole("dialog", { name: "gallery-0.png" });
    await expect(preview).toBeVisible();
    const stage = preview.getByRole("group", { name: /^Zoomable preview of / });
    await expect.poll(() => stage.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(8_000);
    await sampleMemory("40 MP original visible in gallery and preview");
    await stage.focus();
    await page.keyboard.press("+");
    await expect(stage.getByLabel("Zoom level")).toHaveText("150%");
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(last).toBeFocused();
    await first.focus();
    await expect(last.locator("img")).toHaveCount(0);
    await expect.poll(mountedImagesAreVisible).toBe(true);
    await sampleMemory("40 MP preview closed and gallery image offscreen");
    await testInfo.attach("image-memory-samples", { body: JSON.stringify(memorySamples, null, 2), contentType: "application/json" });
    await app.expectNoViewportOverflow();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

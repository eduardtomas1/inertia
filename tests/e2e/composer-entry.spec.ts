// @inertia-e2e-resource primary-display
import { expect, test, type Page } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

async function expectPaintedComposer(page: Page, png: Buffer): Promise<void> {
  const bounds = (await page.getByRole("region", { name: "Message composer" }).boundingBox())!;
  // The old pseudo-element still reported a computed gradient after losing its
  // painted box during a context-card transition. Inspect rendered pixels.
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixel = (x: number) => [...context.getImageData(Math.round(x), Math.round(bounds.y + 34), 1, 1).data].slice(0, 3);
  const outside = pixel(bounds.x - 5);
  const border = pixel(bounds.x + 1);
  expect(Math.max(...border.map((value, index) => Math.abs(value - outside[index]!))))
    .toBeGreaterThan(5);
}

for (const theme of ["dark", "light"] as const) {
  test(`new draft has a painted, clickable composer and can reference a chat (${theme})`, async () => {
    const testInfo = test.info();
    let sourceId = "";
    const app = await createAppFixture({
      name: `composer-entry-${theme}`, initialState: "conversation", windowDisplay: "primary",
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
          { recoverInterruptedRuns: false });
        try {
          sourceId = store.shellSnapshot().activeConversationId!;
          store.updateSettings({ theme, colorTheme: "inertia" });
          store.updateConversation(sourceId, { title: "Architecture decisions" });
          store.createMessage(sourceId, "Keep context sharing explicit and scoped to its destination.", "assistant");
        } finally { store.close(); }
      },
    });
    try {
      const { page } = app;
      await app.resizeWindow(1440, 900);
      await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
      const editor = page.getByLabel("Message", { exact: true });
      await expect(editor).toBeVisible();
      await page.getByRole("heading", { name: "What should we build today?" }).click();
      const empty = await page.screenshot({ animations: "disabled", scale: "css",
        path: testInfo.outputPath(`composer-empty-${theme}.png`) });
      await testInfo.attach(`Empty new-chat composer (${theme})`, { body: empty, contentType: "image/png" });
      await expectPaintedComposer(page, empty);
      const zone = page.locator(".composer-input-zone");
      // Click the empty input padding, not a scripted focus or textarea.fill().
      await zone.click({ position: { x: 6, y: 8 } });
      await expect(editor).toBeFocused();
      await page.keyboard.type("Review @Architecture");
      await expect(editor).toHaveValue("Review @Architecture");
      await page.getByRole("option", { name: /Architecture decisions/u }).click();
      const chip = page.getByRole("button", { name: /From Architecture decisions/u });
      await expect(chip).toBeVisible();
      await expect(editor).toHaveValue("Review ");
      await expect(editor).toBeFocused();
      await page.keyboard.type("the selected decisions");
      await expect(editor).toHaveValue("Review the selected decisions");
      await chip.click();
      await expect(page.getByRole("region", { name: "Shared chat context" }))
        .toContainText("Keep context sharing explicit and scoped to its destination.");
      await page.getByRole("button", { name: "Close preview" }).click();
      await page.getByRole("heading", { name: /^What should we build/u }).click();
      const png = await page.screenshot({ animations: "disabled", scale: "css",
        path: testInfo.outputPath(`composer-reference-${theme}.png`) });
      await testInfo.attach(`Composer and chat reference (${theme})`, { body: png, contentType: "image/png" });
      await expectPaintedComposer(page, png);
      await app.expectNoViewportOverflow();

      const readTarget = () => {
        const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory,
          { recoverInterruptedRuns: false });
        try {
          const snapshot = store.shellSnapshot();
          const id = snapshot.activeConversationId!;
          const detail = store.conversationDetail(id);
          if (!detail) throw new Error("The referenced draft did not become a durable chat.");
          return { id, detail, count: snapshot.conversations.length };
        } finally { store.close(); }
      };
      const target = readTarget();
      expect(target.id).not.toBe(sourceId);
      expect(target.count).toBe(2);
      expect(target.detail.messages).toEqual([]);
      expect(target.detail.contextPackets).toHaveLength(1);
      expect(target.detail.contextPackets?.[0]).toMatchObject({ sourceConversationId: sourceId,
        targetConversationId: target.id, consumedMessageId: null });
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(() => readTarget().detail.contextPackets?.[0]?.consumedMessageId).toEqual(expect.any(String));
      const sent = readTarget();
      expect(sent.count).toBe(2);
      expect(sent.detail.messages.find(({ id }) => id === sent.detail.contextPackets?.[0]?.consumedMessageId))
        .toMatchObject({ content: "Review the selected decisions", role: "user" });
      // The other entry point creates a saved empty chat. Exercise the exact
      // Agents-panel layout from the report as well as the unsaved home draft.
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await expect(page.getByRole("heading", { name: "What should we build in Inertia?" })).toBeVisible();
      const panel = await ensureWorkspaceTools(page);
      await selectWorkspaceTool(panel, "Agents");
      await expect(panel.getByText("No provider-reported subagents in this conversation.")).toBeVisible();
      const savedEmpty = await page.screenshot({ animations: "disabled", scale: "css",
        path: testInfo.outputPath(`composer-agents-${theme}.png`) });
      await expectPaintedComposer(page, savedEmpty);
      await zone.click({ position: { x: 6, y: 8 } });
      await page.keyboard.type("Typing with the Agents panel open");
      await expect(editor).toHaveValue("Typing with the Agents panel open");
      expect(app.rendererErrors).toEqual([]);
    } finally { await app.close(); }
  });
}

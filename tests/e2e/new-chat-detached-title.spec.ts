// @inertia-e2e-resource primary-display
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

for (const [storedTitle, windowTitle] of [
  ["Review this change\nand its tests", "Review this change and its tests"],
  ["🌍".repeat(64), "🌍".repeat(60)],
]) {
  test(`opens a new chat with a ${storedTitle.includes("\n") ? "multiline" : "long Unicode"} stored title`, async () => {
    const fixture = await createAppFixture({
      name: "new-chat-detached-title",
      initialState: "conversation",
      windowDisplay: "primary",
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(
          join(testDirectory, "data", "inertia.sqlite"),
          workspaceDirectory,
          { recoverInterruptedRuns: false },
        );
        try {
          const conversationId = store.shellSnapshot().activeConversationId;
          if (!conversationId) throw new Error("Detached title fixture requires a chat.");
          store.updateConversation(conversationId, { title: storedTitle });
        } finally {
          store.close();
        }
      },
    });
    try {
      const draft = "Keep my unsent message\nexactly as written.";
      await fixture.page.getByRole("textbox", { name: "Message" }).fill(draft);
      const opened = fixture.electronApp.waitForEvent("window");
      await fixture.page.getByRole("button", { name: /Open .* in a new window/u }).click();
      const popup = await opened;
      await expect(popup.locator(".detached-chat-shell")).toBeVisible();
      await expect(popup.getByRole("textbox", { name: "Message" })).toHaveValue(draft);
      await expect.poll(() => fixture.electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.getTitle()),
      )).toContain(`${windowTitle} — Inertia`);
      expect(fixture.rendererErrors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}

// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

test("manages retained files across chats, persists disk settings and confirms cleanup", async ({ browserName: _browserName }, testInfo) => {
  const ids: string[] = [];
  const app = await createAppFixture({ name: "global-attachment-storage", initialState: "conversation",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const root = join(testDirectory, "data");
      const bytes = await readFile(join(testDirectory, "preview.png"));
      const files = await ConversationAttachmentStore.open(root);
      const database = new RuntimeStore(join(root, "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const snapshot = database.shellSnapshot();
        const conversations = [snapshot.activeConversationId!, database.createConversation(snapshot.activeProjectId!, "Other images").id];
        for (const conversationId of conversations) {
          const id = randomUUID(); ids.push(id);
          const retentionId = randomUUID();
          const attachments = await files.retain([{ attachment: { id, path: id, name: "preview.png", mimeType: "image/png", size: bytes.length }, bytes }], undefined, retentionId);
          files.acceptRetention(retentionId);
          database.createMessage(conversationId, "Saved reference", "user", attachments);
          if (conversationId !== snapshot.activeConversationId) database.archiveConversation(conversationId, true);
        }
      } finally { database.close(); await files.close(); }
    },
  });
  try {
    let page = app.page;
    const open = async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Archive & data", exact: true }).click();
    };
    await open();
    await expect(page.getByText(/2 of 65,536 files/u)).toBeVisible();
    const budget = page.getByRole("combobox", { name: "Global attachment disk budget" });
    await expect(budget).toHaveValue("16");
    await budget.selectOption("64");
    await expect(budget).toHaveValue("64");
    await budget.selectOption("2");
    await expect(budget).toHaveValue("2");
    expect((await readdir(join(app.testDirectory, "data", "conversation-attachments"))).sort()).toEqual([...ids].sort());
    await page.getByRole("button", { name: /Remove oldest files \(2/u }).click();
    await expect(page.getByRole("group", { name: "Confirm attachment deletion" })).toBeFocused();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await readdir(join(app.testDirectory, "data", "conversation-attachments"))).toHaveLength(2);
    await testInfo.attach("global-storage-settings", { body: await page.screenshot(), contentType: "image/png" });
    const metrics = await app.electronApp.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetKiB: memory.workingSetSize })));
    await testInfo.attach("storage-memory-sample", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
    page = (await app.restart()).page;
    await open();
    await expect(page.getByRole("combobox", { name: "Global attachment disk budget" })).toHaveValue("2");
    await expect(page.getByText(/2 of 65,536 files/u)).toBeVisible();
    await page.getByRole("button", { name: /Remove oldest files \(2/u }).click();
    await page.getByRole("button", { name: "Remove stored files", exact: true }).click();
    await expect(page.getByText(/Removed 2 files and freed/u)).toBeVisible();
    await expect(page.getByText(/0 of 65,536 files/u)).toBeVisible();
    expect(await readdir(join(app.testDirectory, "data", "conversation-attachments"))).toEqual([]);
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

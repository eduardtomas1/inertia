// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCheckpoint } from "../../src/server/checkpoints";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

const git = promisify(execFile);
const before = "export const revision = 'checkpoint';\n";
const later = "export const revision = 'later edits';\n";
const staged = "Keep this staged file.\n";

test("restores a checkpoint and recovers later edits through the native timeline", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({
    name: "checkpoint-recovery",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try {
        const conversation = store.snapshot().conversations[0]!;
        store.updateSettings({ confirmDestructiveActions: true });
        store.createMessage(conversation.id, "Saved work before later edits.", "assistant");
        await writeFile(join(workspaceDirectory, "sample.ts"), before);
        const checkpoint = await createCheckpoint(workspaceDirectory, testDirectory, conversation.id);
        store.addCheckpoint({ conversationId: conversation.id, ref: checkpoint.ref,
          label: "Before later edits", turnIndex: 1, filesChanged: 1, insertions: 1, deletions: 1 });
        await writeFile(join(workspaceDirectory, "sample.ts"), later);
        await writeFile(join(workspaceDirectory, "later-staged.txt"), staged);
        await git("git", ["add", "--", "later-staged.txt"], { cwd: workspaceDirectory, timeout: 10_000 });
        await writeFile(join(workspaceDirectory, "untracked.txt"), "Untracked work survives.\n");
      } finally { store.close(); }
    },
  });
  try {
    const { page, workspaceDirectory } = app;
    await app.resizeWindow(1040, 800);
    const original = page.locator(".agent-activity").filter({ hasText: "Before later edits" })
      .getByRole("button", { name: "Restore checkpoint" });
    await expect(original).toBeVisible();
    expect(await original.evaluate((button) => Number.parseFloat(getComputedStyle(button).fontSize)))
      .toBeGreaterThanOrEqual(11);
    expect((await original.boundingBox())!.height).toBeGreaterThanOrEqual(28);
    const restore = async (button: typeof original, accept: boolean) => {
      await Promise.all([
        page.waitForEvent("dialog").then(async (dialog) => {
          expect(dialog.type()).toBe("confirm");
          expect(dialog.message()).toContain("A recovery checkpoint will save current edits first.");
          if (accept) await dialog.accept(); else await dialog.dismiss();
        }),
        button.click(),
      ]);
    };
    await restore(original, false);
    await expect(original).toBeFocused();
    expect(await readFile(join(workspaceDirectory, "sample.ts"), "utf8")).toBe(later);
    expect(await readFile(join(workspaceDirectory, "later-staged.txt"), "utf8")).toBe(staged);

    await restore(original, true);
    await expect.poll(() => readFile(join(workspaceDirectory, "sample.ts"), "utf8")).toBe(before);
    await expect.poll(() => access(join(workspaceDirectory, "later-staged.txt")).then(() => true, () => false)).toBe(false);
    expect((await git("git", ["show", ":later-staged.txt"], { cwd: workspaceDirectory, timeout: 10_000 })).stdout).toBe(staged);
    expect(await readFile(join(workspaceDirectory, "untracked.txt"), "utf8")).toBe("Untracked work survives.\n");
    const recovery = page.locator(".agent-activity").filter({ hasText: "Before checkpoint restore" })
      .getByRole("button", { name: "Restore checkpoint" });
    await expect(recovery).toBeVisible();
    const screenshotPath = testInfo.outputPath("checkpoint-recovery.png");
    await page.screenshot({ path: screenshotPath, animations: "disabled", scale: "css" });
    await testInfo.attach("Checkpoint recovery timeline", { path: screenshotPath, contentType: "image/png" });
    await restore(recovery, true);
    await expect.poll(() => readFile(join(workspaceDirectory, "sample.ts"), "utf8")).toBe(later);
    await expect.poll(() => readFile(join(workspaceDirectory, "later-staged.txt"), "utf8")).toBe(staged);
    expect(await readFile(join(workspaceDirectory, "untracked.txt"), "utf8")).toBe("Untracked work survives.\n");
    await app.expectNoViewportOverflow();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { createAppFixture } from "./support/app-fixture";

test("deleting the only chat without a project returns to a real project and keeps the folder", async () => {
  let folder = "";
  let scratchRoot = "";
  const app = await createAppFixture({ name: "scratch-delete-last", initialState: "conversation",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const scratch = new ScratchWorkspace(store, join(testDirectory, "data"));
        const project = await scratch.ensureProject();
        scratchRoot = project.path;
        const chat = await scratch.createConversation(project.id, "Only scratch chat", {});
        folder = chat.worktreePath!;
        store.selectConversation(chat.id);
      } finally { store.close(); }
    },
  });
  const { page } = app;
  try {
    await app.resizeWindow(1440, 920);
    await expect(page.getByRole("heading", { name: "Only scratch chat", level: 1 })).toBeVisible();
    let message = "";
    page.once("dialog", (dialog) => { message = dialog.message(); void dialog.accept(); });
    const row = page.locator("[data-work-section='no-project'] .activity-thread-select").first();
    await row.click({ button: "right" });
    await page.getByRole("menu", { name: "Thread actions for Only scratch chat" }).getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(() => message).toBe(`Delete “Only scratch chat”? This cannot be undone. Its chat folder is kept at ${folder}.`);
    await expect(page.getByRole("heading", { name: "Only scratch chat", level: 1 })).toHaveCount(0);
    await expect(page.locator("[data-work-section='no-project']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open No project in Folder" })).toHaveCount(0);
    await expect(page.locator(".project-welcome")).toHaveCount(0);
    await expect(page.locator(".project-path-display", { hasText: scratchRoot })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Chat breadcrumb" })).not.toContainText("No project");
    expect(existsSync(folder)).toBe(true);
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

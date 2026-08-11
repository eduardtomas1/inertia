import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

test("keeps compact Work sidebar geometry", async () => {
  const app = await createAppFixture({
    name: "work-sidebar-visual",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const databasePath = join(testDirectory, "data", "inertia.sqlite");
      const store = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      const project = store.shellSnapshot().projects[0]!;
      const recent = store.createConversation(
        project.id,
        "Polish compact Work rows",
        { branch: "codex/compact-work-tab", activate: false },
      );
      const yesterday = store.createConversation(
        project.id,
        "Review provider metadata",
        { providerId: "claude", branch: "main", activate: false },
      );
      const earlier = store.createConversation(
        project.id,
        "Investigate keyboard focus behavior",
        { branch: "fix/sidebar-focus", activate: false },
      );
      const done = store.createConversation(
        project.id,
        "Remove redundant status filters",
        { branch: "codex/filter-cleanup", activate: false },
      );
      store.settleConversation(done.id, true);
      store.updateSettings({
        sidebarMode: "activity",
        providerIdentityLabels: { codex: "OpenAI", claude: "Anthropic" },
      });
      store.selectConversation(recent.id);
      store.close();

      const database = new Database(databasePath);
      database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(), yesterday.id);
      database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000).toISOString(), earlier.id);
      database.close();
    },
  });

  try {
    await app.resizeWindow(1100, 760);
    const sidebar = app.page.getByRole("complementary", {
      name: "Project navigation",
      exact: true,
    });
    await expect(sidebar.getByRole("button", { name: "Work", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    const row = sidebar.getByRole("button", { name: /^Polish compact Work rows,/u });
    await expect(row).toBeVisible();
    expect((await row.boundingBox())?.height).toBeLessThanOrEqual(48);
    await expect(sidebar.getByRole("group", { name: "Filter conversations" }))
      .toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: /Earlier 1/u }))
      .toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.getByRole("button", { name: /Done 1/u }))
      .toHaveAttribute("aria-expanded", "false");
    expect(await sidebar.locator(".project-list").evaluate((element) => (
      element.scrollWidth <= element.clientWidth
    ))).toBe(true);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

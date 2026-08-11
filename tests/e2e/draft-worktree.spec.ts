import { expect, test } from "@playwright/test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createAppFixture } from "./support/app-fixture";

test("keeps Environment available while an isolated draft worktree materializes", async () => {
  const app = await createAppFixture({
    name: "isolated-draft",
    initialState: "empty",
    initialNewThreadMode: "worktree",
  });
  try {
    await app.electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, app.workspaceDirectory);
    await app.page.getByRole("button", {
      name: "Add your first project",
    }).click();
    await expect(app.page.getByRole("heading", {
      name: "What should we work on?",
      level: 3,
    })).toBeVisible();

    const workspaceTools = app.page.getByRole("complementary", {
      name: "Workspace tools",
    });
    await expect(workspaceTools.getByRole("tab", {
      name: "Environment",
    })).toHaveAttribute("aria-selected", "true");
    await expect(workspaceTools.getByRole("tab", { name: /Changes/u }))
      .toHaveCount(0);
    await expect(workspaceTools.getByRole("tab", { name: /Files/u }))
      .toHaveCount(0);
    await expect(workspaceTools).toContainText(
      "Files, changes, and Terminal will become available after this isolated worktree is created by the first message.",
    );
    await expect(app.page.getByLabel("Terminal panel")).toHaveCount(0);

    const databasePath = join(
      app.testDirectory,
      "data",
      "inertia.sqlite",
    );
    const database = new Database(databasePath);
    const row = database.prepare("SELECT COUNT(*) AS count FROM conversations")
      .get() as { count: number };
    database.close();
    expect(row.count).toBe(0);

    await app.page.getByRole("textbox", { name: "Message" })
      .fill("Inspect this isolated worktree.");
    await app.page.getByRole("button", { name: "Send message" }).click();
    await expect(
      app.page.getByLabel("Thread transcript").getByText(
        "Inspect this isolated worktree.",
        { exact: true },
      ),
    ).toBeVisible();

    const readMaterializedConversation = (): {
      count: number;
      worktreePath: string | null;
    } => {
      const current = new Database(databasePath, { readonly: true });
      try {
        const count = (
          current.prepare("SELECT COUNT(*) AS count FROM conversations")
            .get() as { count: number }
        ).count;
        const worktreePath = (
          current.prepare(`
            SELECT worktree_path AS worktreePath
            FROM conversations
            LIMIT 1
          `).get() as { worktreePath: string | null } | undefined
        )?.worktreePath ?? null;
        return { count, worktreePath };
      } finally {
        current.close();
      }
    };
    await expect.poll(readMaterializedConversation).toMatchObject({
      count: 1,
      worktreePath: expect.any(String),
    });
    const { worktreePath } = readMaterializedConversation();
    expect(worktreePath).toBeTruthy();
    expect(worktreePath).not.toBe(app.workspaceDirectory);
    await expect.poll(
      () => stat(worktreePath!).then(
        (metadata) => metadata.isDirectory(),
        () => false,
      ),
    ).toBe(true);
    await expect(
      stat(join(worktreePath!, ".git")).then((metadata) => metadata.isFile()),
    ).resolves.toBe(true);

    const filesTab = workspaceTools.getByRole("tab", { name: /Files/u });
    await expect(filesTab).toBeVisible();
    await filesTab.click();
    await expect(
      workspaceTools.getByRole("tree", { name: "Workspace files" }),
    ).toBeVisible();
    await expect(
      workspaceTools.getByRole("treeitem", {
        name: "sample.ts",
        exact: true,
      }),
    ).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

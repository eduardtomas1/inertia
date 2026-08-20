import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

const execFileAsync = promisify(execFile);
const storedBranch = "viewed/branch";

test("shows the live branch for a mismatched project checkout", async () => {
  const app = await createAppFixture({
    name: "composer-checkout-branch",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const conversationId = store.shellSnapshot().activeConversationId;
      if (!conversationId) throw new Error("Checkout fixture has no chat.");
      store.updateConversation(conversationId, {
        branch: storedBranch,
        worktreePath: null,
      });
      store.close();
    },
  });

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["branch", "--show-current"],
      { cwd: app.workspaceDirectory },
    );
    const liveBranch = stdout.trim();
    if (!liveBranch) throw new Error("Checkout fixture is detached.");
    await expect(app.page.getByRole("button", {
      name: /Checkout context differs/u,
    })).toBeVisible();
    const checkout = app.page.getByRole("group", {
      name: "Chat checkout context",
    });
    await expect(checkout).toContainText(liveBranch);
    await expect(checkout).not.toContainText(storedBranch);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

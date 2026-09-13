// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";
import { captureBoundedFailureDiagnostic } from "../helpers/bounded-failure-diagnostic";
import { attachRuntimeLifecycleFailureDiagnostic } from "./support/runtime-lifecycle-diagnostics";

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
  } catch (error) {
    // Capture the existing safe projections before close removes this private
    // fixture. Keep the original failure and every functional deadline intact.
    await Promise.allSettled([
      attachRuntimeLifecycleFailureDiagnostic(test.info(), async () =>
        (await app.runtimeSnapshot()).websocketUrl),
      (async () => {
        const incidents = await captureBoundedFailureDiagnostic(async () => await app.page.evaluate(async () => {
          const result = await window.inertia.queryDiagnostics({ subsystem: "git", limit: 8 });
          return result.records.map(({ id, code, at, outcome, runtimeGeneration, metadata, occurrences }) => ({
            id, code, at, outcome, runtimeGeneration, metadata, occurrences,
          }));
        }), 2_000);
        await test.info().attach("git-incidents", {
          body: JSON.stringify(incidents, null, 2), contentType: "application/json",
        });
      })(),
    ]);
    throw error;
  } finally {
    await app.close();
  }
});

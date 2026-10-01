// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { prLink, prSnapshot } from "../support/pull-request-fixtures";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

// Real persisted cache through the production runtime IPC. No remote action is
// submitted by this appearance scenario; protocol/action behavior has separate coverage.
for (const theme of ["light", "dark"] as const) {
  test(`shows multiple repositories and the native stack menu in ${theme}`, async () => {
    const app = await createAppFixture({ name: `pull-request-links-${theme}`, initialState: "conversation", workspaceGit: false,
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
        try {
          const chat = store.snapshot().conversations[0]!;
          store.updateConversation(chat.id, { title: "Connect related work" });
          store.updateSettings({ theme });
          for (const link of [prLink(41), prLink(42), { ...prLink(18, "acme/docs"), stack: null,
            snapshot: { ...prSnapshot(18), title: "Document the pull request workflow", headBranch: "docs/pull-requests", baseBranch: "main", additions: 86, deletions: 4 } },
          { ...prLink(9, "acme/workspace"), stack: null, snapshot: { ...prSnapshot(9), title: "Refine workspace shortcuts", state: "merged" as const, additions: 32, deletions: 17 } }]) {
            store.pullRequests.save(chat.id, link);
          }
        } finally { store.close(); }
      },
    });
    try {
      await app.resizeWindow(1440, 1000);
      const { page } = app;
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await selectWorkspaceTool(await ensureWorkspaceTools(page), "Pull requests");
      await expect(page.getByText("4 linked", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Document the pull request workflow/u })).toBeVisible();
      await app.expectNoViewportOverflow();
      await page.screenshot({ path: test.info().outputPath(`pull-requests-${theme}.png`), animations: "disabled" });
      await page.getByRole("button", { name: /Keep related pull requests together/u }).click();
      const trigger = page.getByRole("button", { name: "Stack 43, layer 2 of 2" });
      await trigger.click();
      const menu = page.getByRole("menu", { name: "Stack 43" });
      await expect(menu.getByRole("menuitem", { name: "Merge stack (2)" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Rebase stack" })).toBeVisible();
      const bounds = await menu.boundingBox(); const panel = await page.getByRole("region", { name: "Linked pull requests" }).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
      await page.screenshot({ path: test.info().outputPath(`native-stack-${theme}.png`), animations: "disabled" });
      await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
      await app.resizeWindow(1000, 800);
      await app.expectNoViewportOverflow();
      await page.screenshot({ path: test.info().outputPath(`pull-request-detail-${theme}-narrow.png`), animations: "disabled" });
      expect(app.rendererErrors).toEqual([]);
    } finally { await app.close(); }
  });
}

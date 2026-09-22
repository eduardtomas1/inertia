// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

test("Git actions and Changes share a subfolder's containing repository and open the correct file", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({
    name: "subfolder-git",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const subfolder = join(workspaceDirectory, "src");
      await writeFile(join(subfolder, "index.ts"), "export const subfolderChange = 'correct file';\n");
      const identity = await inspectProjectIdentity(subfolder);
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const project = store.createProject("Subfolder", subfolder, identity);
        store.createConversation(project.id, "Subfolder changes");
      } finally {
        store.close();
      }
    },
  });
  try {
    const page = app.page;
    await app.resizeWindow(1440, 920);
    await expect(page.getByRole("heading", { name: "Subfolder changes", exact: true })).toBeVisible();
    await page.locator(".workspace-header")
      .getByRole("group", { name: "Git actions" })
      .getByRole("button", { name: "More Git actions" })
      .click();
    const gitMenu = page.getByRole("menu", { name: "Git actions" });
    await expect(gitMenu.locator(".git-menu-section-label")).toContainText("2 files");
    const environmentScreenshot = testInfo.outputPath("subfolder-environment.png");
    await page.screenshot({ animations: "disabled", path: environmentScreenshot });
    await testInfo.attach("subfolder-environment", { path: environmentScreenshot, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(gitMenu).toHaveCount(0);
    const tools = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(tools, "Changes");

    const changes = page.getByLabel("Workspace changes");
    await expect(changes.getByText("2 files in 1 repository", { exact: true })).toBeVisible();
    await changes.getByRole("button", { name: "Refresh changes", exact: true }).click();
    await expect(changes.getByText("2 files in 1 repository", { exact: true })).toBeVisible();
    const files = changes.getByRole("navigation", { name: "Git repositories and changed files" });
    await files.locator(".workspace-repository-file").filter({ hasText: "index.ts" }).click();
    await expect(changes.locator(".diff-line.is-addition").filter({ hasText: "subfolderChange" })).toBeVisible();
    await expect(files.getByRole("button", { name: "Open sample.ts from Subfolder" })).toBeDisabled();
    const changesScreenshot = testInfo.outputPath("subfolder-changes.png");
    await page.screenshot({ animations: "disabled", path: changesScreenshot });
    await testInfo.attach("subfolder-changes", { path: changesScreenshot, contentType: "image/png" });

    // Retain real renderer → main → runtime path validation without launching an editor.
    await app.electronApp.evaluate(({ shell }) => {
      const observed = shell as typeof shell & { subfolderOpenedPaths: string[] };
      observed.subfolderOpenedPaths = [];
      observed.openPath = async (path) => { observed.subfolderOpenedPaths.push(path); return ""; };
    });
    await files.getByRole("button", { name: "Open src/index.ts from Subfolder" }).click();
    await expect.poll(async () => await app.electronApp.evaluate(({ shell }) =>
      (shell as typeof shell & { subfolderOpenedPaths: string[] }).subfolderOpenedPaths,
    )).toEqual([await realpath(join(app.workspaceDirectory, "src", "index.ts"))]);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

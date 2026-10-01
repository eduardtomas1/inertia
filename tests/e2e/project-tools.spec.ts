// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { projectToolsCodexFixtureSource } from "../helpers/project-tools-codex-fixture";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

test("project connections persist and expose only this chat's live tools", async ({ browserName: _browserName }, info) => {
  let projectId = "";
  const app = await createAppFixture({
    name: "project-tools", initialState: "conversation", codexAppServerSource: projectToolsCodexFixtureSource,
    additionalEnvironment: { INERTIA_MCP_DOCS_TOKEN: "synthetic-test-value" },
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const snapshot = store.shellSnapshot(); const project = snapshot.projects[0]!; projectId = project.id;
        store.updateConversation(snapshot.conversations[0]!.id, { title: "Check project documentation", providerId: "codex" });
        store.updateSettings({ theme: "light", newThreadMode: "local" });
      } finally { store.close(); }
    },
  });
  try {
    await app.resizeWindow(1440, 1000);
    const page = app.page;
    await selectWorkspaceTool(await ensureWorkspaceTools(page), "Tools");
    const tools = page.getByRole("region", { name: "Project tools", exact: true });
    await tools.getByRole("button", { name: "Add connection" }).click();
    await tools.getByRole("textbox", { name: "Name", exact: true }).fill("Project documentation");
    await tools.getByRole("textbox", { name: "Server URL" }).fill("https://docs.example.test/mcp");
    await tools.getByRole("textbox", { name: /^Bearer token environment variable/u }).fill("INERTIA_MCP_DOCS_TOKEN");
    const formShot = info.outputPath("project-tools-configure.png");
    await page.screenshot({ path: formShot, animations: "disabled" });
    await info.attach("Configure one connection for Claude and Codex", { path: formShot, contentType: "image/png" });
    await tools.getByRole("button", { name: "Save connection" }).click();
    const docs = tools.getByRole("article", { name: "Project documentation", exact: true });
    await expect(docs.getByText("Configured", { exact: true })).toBeVisible();
    // Exercise configuration persistence through the real runtime and renderer reload.
    await page.reload();
    await selectWorkspaceTool(await ensureWorkspaceTools(page), "Tools");
    await expect(docs.getByText("Configured", { exact: true })).toBeVisible();
    await tools.getByRole("button", { name: "Add connection" }).click();
    await tools.getByRole("textbox", { name: "Name", exact: true }).fill("Private issue tracker");
    await tools.getByRole("textbox", { name: "Server URL" }).fill("https://issues.example.test/mcp");
    await tools.getByRole("textbox", { name: /^Bearer token environment variable/u }).fill("INERTIA_MCP_ISSUES_TOKEN");
    await tools.getByRole("button", { name: "Save connection" }).click();
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message", exact: true }).fill("Check documentation access and hold for review.");
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(docs.getByText("Available in this chat", { exact: true })).toBeVisible();
    await expect(docs.getByText("search_docs", { exact: true })).toBeVisible();
    await expect(tools.getByText("Needs authentication", { exact: true })).toBeVisible();
    const liveShot = info.outputPath("project-tools-live.png");
    await page.screenshot({ path: liveShot, animations: "disabled" });
    await info.attach("Live tools and missing authentication — deterministic provider fixture", { path: liveShot, contentType: "image/png" });
    await docs.getByRole("button", { name: "Remove Project documentation" }).click();
    await expect(tools.getByRole("alert")).toContainText("running chat");
    await docs.getByRole("button", { name: "Edit Project documentation" }).click();
    await tools.getByRole("textbox", { name: "Server URL" }).fill("https://docs.example.test/v2/mcp");
    await tools.getByRole("button", { name: "Save connection" }).click();
    await expect(docs.getByText("Needs restart", { exact: true })).toBeVisible();
    await expect(docs.getByText("search_docs", { exact: true })).toHaveCount(0);
    const restartShot = info.outputPath("project-tools-restart.png");
    await page.screenshot({ path: restartShot, animations: "disabled" });
    await info.attach("Edits wait for the next run", { path: restartShot, contentType: "image/png" });
    await composer.getByRole("button", { name: "Stop agent" }).click();
    await expect(docs.getByText("Configured", { exact: true })).toBeVisible();
    await docs.getByRole("button", { name: "Remove Project documentation" }).click();
    await expect(docs).toHaveCount(0);
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    try { expect(store.projectTools.list(projectId).map(({ name }) => name)).toEqual(["Private issue tracker"]); } finally { store.close(); }
    await app.expectNoViewportOverflow();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

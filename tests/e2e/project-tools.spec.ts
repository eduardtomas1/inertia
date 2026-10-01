// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { projectToolsCodexFixtureSource } from "../helpers/project-tools-codex-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
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

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
}

async function expectLayoutHolds(app: AppFixture, region: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  await expectComposerEndsAtDock(app.page.getByRole("region", { name: "Message composer" }));
  const layout = await region.evaluate((element) => {
    const scrollers = [element, ...element.querySelectorAll<HTMLElement>("*")]
      .filter((node) => !node.classList.contains("sr-only")
        && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible");
    return {
      horizontal: scrollers.map((node) => `${node.tagName}.${node.className}`),
      scrollContainers: [element, ...element.querySelectorAll<HTMLElement>("*")]
        .filter((node) => ["auto", "scroll"].includes(getComputedStyle(node).overflowY))
        .map((node) => node.className),
      nested: [...element.querySelectorAll("button")].filter((button) => button.parentElement?.closest("button")).length,
      truncatedTitles: [...element.querySelectorAll<HTMLElement>("h3")]
        .filter((title) => title.scrollWidth > title.clientWidth + 1).length,
    };
  });
  expect(layout.horizontal).toEqual([]);
  expect(layout.scrollContainers).toEqual(["workspace-surface-scroll"]);
  expect(layout.nested).toBe(0);
  expect(layout.truncatedTitles).toBe(0);
}

async function addConnection(tools: Locator, name: string, url: string, token: string | null, providers: readonly ("Claude" | "Codex")[]): Promise<void> {
  await tools.getByRole("button", { name: "Add connection" }).click();
  await tools.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await tools.getByRole("textbox", { name: "Server URL" }).fill(url);
  if (token) await tools.getByRole("textbox", { name: /^Bearer token environment variable/u }).fill(token);
  for (const provider of ["Claude", "Codex"] as const) {
    await tools.getByRole("checkbox", { name: provider }).setChecked(providers.includes(provider));
  }
  await tools.getByRole("button", { name: "Save connection" }).click();
  await expect(tools.getByRole("article", { name, exact: true })).toBeVisible();
}

test("project tools surface holds its layout in every state, theme and width", async ({ browserName: _browserName }, info) => {
  const app = await createAppFixture({
    name: "project-tools-captures", initialState: "conversation", codexAppServerSource: projectToolsCodexFixtureSource,
    additionalEnvironment: { INERTIA_MCP_DOCS_TOKEN: "synthetic-test-value" },
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const snapshot = store.shellSnapshot();
        store.updateConversation(snapshot.conversations[0]!.id, { title: "Check project documentation", providerId: "codex" });
        store.updateSettings({ theme: "dark", newThreadMode: "local" });
      } finally { store.close(); }
    },
  });
  try {
    const page = app.page;
    await page.clock.setFixedTime(Date.parse("2026-10-01T10:00:00.000Z"));
    await app.resizeWindow(1440, 920);
    await selectWorkspaceTool(await ensureWorkspaceTools(page), "Tools");
    const tools = page.getByRole("region", { name: "Project tools", exact: true });
    await expect(tools.getByText(/^No connections/u)).toBeVisible();
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-empty-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "tools-empty-light-wide");
    await setAppearanceInPlace(app, "dark");

    await tools.getByRole("button", { name: "Add connection" }).click();
    await tools.getByRole("textbox", { name: "Name", exact: true }).fill("Project documentation");
    await tools.getByRole("textbox", { name: "Server URL" }).fill("https://docs.example.test/mcp");
    const token = tools.getByRole("textbox", { name: /^Bearer token environment variable/u });
    await token.fill("INERTIA_MCP_DOCS_TOKEN");
    await token.blur();
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-editor-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "tools-editor-light-wide");
    await app.resizeWindow(760, 600);
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-editor-light-760x600");
    await app.resizeWindow(1440, 920);
    await setAppearanceInPlace(app, "dark");
    await tools.getByRole("textbox", { name: "Server URL" }).fill("http://docs.example.test/mcp");
    await tools.getByRole("button", { name: "Save connection" }).click();
    await expect(tools.getByRole("alert")).toBeVisible();
    await blurFocus(page);
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-editor-invalid-dark-wide");
    await tools.getByRole("textbox", { name: "Server URL" }).fill("https://docs.example.test/mcp");
    await tools.getByRole("button", { name: "Save connection" }).click();
    await expect(tools.getByRole("article", { name: "Project documentation", exact: true })).toBeVisible();

    await addConnection(tools, "Private issue tracker", "https://issues.example.test/mcp", "INERTIA_MCP_ISSUES_TOKEN", ["Claude", "Codex"]);
    await addConnection(tools, "Engineering knowledge base and architecture decision records (staging copy)",
      "https://knowledge-base.internal.example.test/engineering/architecture/decision-records/mcp", null, ["Claude"]);
    await blurFocus(page);
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-configured-dark-wide");

    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message", exact: true }).fill("Check documentation access and hold for review.");
    await composer.getByRole("button", { name: "Send message" }).click();
    const docs = tools.getByRole("article", { name: "Project documentation", exact: true });
    await expect(docs.getByText("Available in this chat", { exact: true })).toBeVisible();
    await expect(docs.getByText("search_docs", { exact: true })).toBeVisible();
    await expect(tools.getByText("Needs authentication", { exact: true })).toBeVisible();
    await expect(tools.getByText("Not enabled for this chat", { exact: true })).toBeVisible();
    await blurFocus(page);
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-live-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "tools-live-light-wide");
    await app.resizeWindow(1000, 800);
    await expect(docs).toBeVisible();
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-live-light-narrow");
    await setAppearanceInPlace(app, "dark");
    await capture(page, info, "tools-live-dark-narrow");
    await app.resizeWindow(760, 600);
    await expect(docs).toBeVisible();
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-live-dark-760x600");
    await app.resizeWindow(1440, 920);

    const remove = docs.getByRole("button", { name: "Remove Project documentation" });
    await remove.click();
    await expect(docs.getByRole("alert")).toContainText("running chat");
    await expect(remove).toBeFocused();
    await blurFocus(page);
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-remove-blocked-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "tools-remove-blocked-light-wide");
    await setAppearanceInPlace(app, "dark");

    await docs.getByRole("button", { name: "Edit Project documentation" }).click();
    await tools.getByRole("textbox", { name: "Server URL" }).fill("https://docs.example.test/v2/mcp");
    await tools.getByRole("button", { name: "Save connection" }).click();
    await expect(docs.getByText("Needs restart", { exact: true })).toBeVisible();
    await blurFocus(page);
    await expectLayoutHolds(app, tools);
    await capture(page, info, "tools-restart-dark-wide");

    await composer.getByRole("button", { name: "Stop agent" }).click();
    await expect(docs.getByText("Configured", { exact: true })).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

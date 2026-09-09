// @inertia-e2e-resource primary-display
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
let projectId: string;
let threadId: string;
let otherThreadId: string;

async function createThreadFixture(withSavedAction = false): Promise<AppFixture> {
  // Delayed hover previews and the native clipboard need exclusive display ownership.
  return createAppFixture({ name: "thread-project-settings", initialState: "conversation", seedSecondProject: true, windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory, secondWorkspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const state = store.shellSnapshot();
        // Project creation timestamps can tie; the snapshot order is not an identity.
        const project = state.projects.find(({ path }) => path === secondWorkspaceDirectory)!;
        projectId = project.id;
        const thread = state.conversations.find((chat) => chat.projectId === project.id)!;
        threadId = thread.id;
        otherThreadId = state.conversations.find((chat) => chat.projectId !== project.id)!.id;
        store.updateProject(project.id, { name: "Workspace studio", preferences: {
          ...defaultProjectPreferences(), icon: { kind: "symbol", name: "code" },
          actions: withSavedAction ? [{ id: randomUUID(), name: "Check workspace", executable: "node", args: ["--version"] }] : [],
        } });
        store.updateConversation(thread.id, { title: "Review authentication flow" });
        store.updateSettings({ theme: withSavedAction ? "dark" : "light", newThreadMode: "local" });
      } finally { store.close(); }
    },
  });
}

test.beforeAll(async () => {
  app = await createThreadFixture();
});
test.afterAll(async () => { await app?.close(); });

async function capture(info: TestInfo, name: string, target?: Locator) {
  const path = info.outputPath(`${name}.png`);
  if (target) await target.screenshot({ path, animations: "disabled" });
  else await app.page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
  await app.expectNoViewportOverflow();
}

test("right-click, inline actions, delayed preview, and nested keyboard menus", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  const row = page.locator(`[data-work-focus-id="thread:${threadId}"]`);
  await row.hover();
  await expect(page.getByRole("button", { name: "Settle Review authentication flow" })).toBeVisible();
  await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("tooltip")).toContainText("Workspace studio");
  await capture(info, "thread-preview-light");
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Thread actions for Review authentication flow" });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thread actions for Review authentication flow" })).toHaveCount(0);
  await capture(info, "thread-context-menu-light");
  await menu.getByRole("menuitem", { name: "Snooze", exact: true }).hover();
  await expect(page.getByRole("menu", { name: "Snooze", exact: true })).toBeVisible();
  await capture(info, "thread-snooze-light");
  await menu.getByRole("menuitem", { name: "Copy", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const copyMenu = page.getByRole("menu", { name: "Copy", exact: true });
  await expect(copyMenu.getByRole("menuitem", { name: "Path", exact: true })).toBeFocused();
  await expect(page.getByRole("menu", { name: "Snooze", exact: true })).toHaveCount(0);
  await capture(info, "thread-copy-light");
  await page.keyboard.press("ArrowLeft");
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await row.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Copy", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Thread ID", exact: true }).click();
  await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(threadId);
  await row.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Project settings", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue("Workspace studio");
  expect(app.rendererErrors).toEqual([]);
});

test("edits project defaults without running actions, shows all settings, and persists both theme choices", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await page.getByRole("complementary", { name: "Project navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  if (!await page.getByRole("textbox", { name: "Project name" }).isVisible()) {
    await page.getByRole("button", { name: "Choose project", exact: true }).click();
    await page.getByRole("option", { name: "Workspace studio", exact: true }).click();
  }
  await capture(info, "project-defaults-light");
  await page.getByRole("button", { name: "Choose icon", exact: true }).click();
  await capture(info, "project-icons-light");
  await page.getByRole("button", { name: "database icon", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose file", exact: true })).toBeEnabled();
  await page.locator('.project-icon-controls input[type="file"]').setInputFiles(app.attachmentImagePath);
  await expect(page.locator(".project-icon-controls img.project-custom-icon")).toHaveAttribute("src", /^data:image\/png;base64,/u);
  await capture(info, "project-image-icon-light");
  await page.getByRole("combobox", { name: "Agent browser access", exact: true }).selectOption("false");
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Check workspace");
  await page.getByLabel("Executable", { exact: true }).fill("node");
  await page.getByLabel("Arguments (one per line)", { exact: true }).fill("--version");
  await page.getByRole("button", { name: "Save action", exact: true }).scrollIntoViewIfNeeded();
  await capture(info, "project-action-editor-light");
  await page.getByRole("button", { name: "Save action", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Check workspace", exact: true })).toBeVisible();
  const state = (): { actions: number; runs: number; browser: boolean | null | undefined } => {
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    try { const prefs = store.project(projectId).preferences; return { actions: prefs?.actions.length ?? 0, runs: store.shellSnapshot().runs.length, browser: prefs?.browserAccess }; }
    finally { store.close(); }
  };
  expect(state()).toEqual({ actions: 1, runs: 0, browser: false });
  await page.getByRole("button", { name: "Choose project", exact: true }).click();
  await capture(info, "project-chooser-light");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Use Ocean for light", exact: true }).click();
  await page.getByRole("button", { name: "Use Iris for dark", exact: true }).click();
  await page.getByRole("group", { name: "Color theme", exact: true }).scrollIntoViewIfNeeded();
  await capture(info, "independent-themes-light");
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await capture(info, "independent-themes-dark");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "Choose project", exact: true }).click();
  await page.getByRole("option", { name: "Workspace studio", exact: true }).click();
  await capture(info, "project-defaults-dark");
  await page.getByRole("button", { name: "Remove project", exact: true }).scrollIntoViewIfNeeded();
  await capture(info, "project-checkout-dark");
  await app.resizeWindow(900, 700);
  await page.getByRole("textbox", { name: "Project name" }).scrollIntoViewIfNeeded();
  await capture(info, "project-defaults-narrow-dark");
  await app.resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const row = page.locator(`[data-work-focus-id="thread:${threadId}"]`);
  await row.click({ button: "right" });
  await capture(info, "thread-context-menu-dark");
  await page.getByRole("menuitem", { name: "Snooze", exact: true }).hover();
  await capture(info, "thread-snooze-dark");
  await page.keyboard.press("Escape");
  await app.restart();
  await expect(app.page.locator("html")).toHaveAttribute("data-color-theme", "iris");
  expect(state()).toEqual({ actions: 1, runs: 0, browser: false });
  expect(app.rendererErrors).toEqual([]);
});

test("scratch prompts belong only to their original chat, including after restart", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  const owner = page.locator(`[data-work-focus-id="thread:${threadId}"]`);
  await owner.click();
  await expect(owner).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".header-title-wrap h1")).toHaveText("Review authentication flow");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Review the authentication tests before the next change.");
  await page.getByRole("button", { name: "Scratch prompts", exact: true }).click();
  await page.getByRole("menuitem", { name: /Save current prompt/u }).click();
  await page.getByRole("button", { name: "Scratch prompts, 1 saved", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Review the authentication tests/u })).toBeVisible();
  await capture(info, "chat-owned-scratch-prompt-dark");
  await page.keyboard.press("Escape");
  const other = page.locator(`[data-work-focus-id="thread:${otherThreadId}"]`);
  await other.click();
  await expect(other).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".header-title-wrap h1")).toHaveText("thread-project-settings fixture");
  await page.getByRole("button", { name: "Scratch prompts", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Review the authentication tests/u })).toHaveCount(0);
  await capture(info, "other-chat-scratch-prompts-empty-dark");
  await app.restart();
  await app.page.locator(`[data-work-focus-id="thread:${threadId}"]`).click();
  await expect(app.page.locator(".header-title-wrap h1")).toHaveText("Review authentication flow");
  await app.page.getByRole("button", { name: "Scratch prompts, 1 saved", exact: true }).click();
  await app.page.getByRole("menuitem", { name: /^Review the authentication tests/u }).click();
  await expect(app.page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Review the authentication tests before the next change.");
  expect(app.rendererErrors).toEqual([]);
});

test("runs a saved action only on explicit selection through the real terminal", async ({ browserName: _browserName }, info) => {
  // Own the saved-action precondition even when this scenario runs by itself
  // or Playwright replaces the worker after a preceding scenario fails.
  await app.close();
  app = await createThreadFixture(true);
  const page = app.page;
  await page.locator(`[data-work-focus-id="thread:${threadId}"]`).click();
  await expect(page.locator(".header-title-wrap h1")).toHaveText("Review authentication flow");
  await app.resizeWindow(1000, 700);
  const actionButton = page.getByRole("button", { name: "Add action", exact: true });
  await expect(actionButton).toBeVisible();
  await expect(actionButton.locator(".header-plus-icon")).toBeVisible();
  await actionButton.click();
  const menu = page.getByRole("menu", { name: "Project actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: /Check workspace/u })).toBeVisible();
  await capture(info, "saved-project-action-menu-dark");
  await menu.getByRole("menuitem", { name: /Check workspace/u }).click();
  await expect.poll(() => {
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    try { return store.shellSnapshot().runs.filter((run) => run.label === "Check workspace").map((run) => ({
      projectId: run.projectId, conversationId: run.conversationId, status: run.status,
    })); } finally { store.close(); }
  }).toEqual([{ projectId, conversationId: threadId, status: "succeeded" }]);
  await expect(page.locator(".xterm-screen").first()).toBeVisible();
  await capture(info, "project-action-terminal-dark");
  expect(app.rendererErrors).toEqual([]);
});

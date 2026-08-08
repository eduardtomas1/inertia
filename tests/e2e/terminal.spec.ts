import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let rendererErrors!: AppFixture["rendererErrors"];
let previewUrl!: AppFixture["previewUrl"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "terminal", initialState: "conversation" });
  electronApp = app.electronApp;
  page = app.page;
  workspaceDirectory = app.workspaceDirectory;
  rendererErrors = app.rendererErrors;
  previewUrl = app.previewUrl;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
});

test.afterAll(async () => {
  await app.close();
});

async function ensureWorkspaceTools(): Promise<void> {
  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
}

test("switches workspace tools, opens multiple terminals, and loads a safe native preview", async () => {
  await resizeWindow(1440, 920);
  await ensureWorkspaceTools();
  await page.getByRole("tab", { name: /Changes/ }).click();
  await expect(page.getByLabel("Workspace changes")).toBeVisible();
  await page.getByRole("tab", { name: /Files/ }).click();
  await expect(page.getByRole("region", { name: "Project files" })).toBeVisible();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal" }).click();
  const secondTerminalTab = page.getByRole("tab", { name: "Terminal 2", exact: true });
  await expect(secondTerminalTab).toBeVisible();
  await expect(secondTerminalTab).toHaveAttribute("aria-selected", "true");
  await expect(secondTerminalTab).toHaveJSProperty("tagName", "BUTTON");
  await page.getByRole("button", { name: "Close Terminal 2" }).click();
  await expect(secondTerminalTab).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "New terminal" }).click();
  await page.getByRole("button", { name: "Split terminals" }).click();
  await expect(page.locator(".terminal-session-grid")).toHaveClass(/is-split/);
  const liveTerminals = page.locator(".terminal-panel[data-terminal-id]");
  await expect(liveTerminals).toHaveCount(2);
  const terminalIdsBefore = (await liveTerminals.evaluateAll((terminals) => terminals.map((terminal) => terminal.getAttribute("data-terminal-id")).sort())).filter(Boolean);

  await page.getByRole("tab", { name: /Changes/ }).click();
  await page.getByRole("tab", { name: /Files/ }).click();
  await page.getByRole("tab", { name: /Preview/ }).click();
  const address = page.getByRole("textbox", { name: "Preview address" });
  await address.fill(previewUrl);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => electronApp.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url), previewUrl)).toBe(true);
  await page.getByRole("tab", { name: /Plan/ }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
  await page.locator(".workspace-panel").getByRole("button", { name: "Close workspace tools" }).click();
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
  await expect(liveTerminals).toHaveCount(2);
  const terminalIdsAfter = (await liveTerminals.evaluateAll((terminals) => terminals.map((terminal) => terminal.getAttribute("data-terminal-id")).sort())).filter(Boolean);
  expect(terminalIdsAfter).toEqual(terminalIdsBefore);
  expect(rendererErrors).toEqual([]);
});

test("keeps hostile native previews beneath trusted workspace overlays", async () => {
  await resizeWindow(1440, 920);
  await ensureWorkspaceTools();
  await page.getByRole("tab", { name: /Preview/ }).click();
  const hostilePreviewUrl = `${previewUrl}trusted-overlays`;
  await page.getByRole("textbox", { name: "Preview address" })
    .fill(hostilePreviewUrl);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(true);

  await page.getByRole("button", { name: "Open environment summary" }).click();
  expect(await app.nativePreviewIsVisible(hostilePreviewUrl)).toBe(false);
  await expect(page.getByRole("dialog", {
    name: "Environment summary",
  })).toBeVisible();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(false);
  await page.getByRole("button", { name: "Close environment summary" }).click();
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(true);

  await page.getByRole("button", { name: /^Open runs/u }).click();
  expect(await app.nativePreviewIsVisible(hostilePreviewUrl)).toBe(false);
  await expect(page.getByRole("dialog", { name: "Runs" })).toBeVisible();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(false);
  await page.getByRole("button", { name: "Close runs" }).click();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(true);

  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+K" : "Control+K",
  );
  expect(await app.nativePreviewIsVisible(hostilePreviewUrl)).toBe(false);
  await expect(page.getByRole("dialog", { name: "Search Inertia" }))
    .toBeVisible();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(false);
  await page.getByRole("button", { name: "Close search" }).click();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(true);

  const commitButton = page.locator(
    ".workspace-header .primary-header-button",
  );
  await expect(commitButton).toBeEnabled();
  await commitButton.click();
  expect(await app.nativePreviewIsVisible(hostilePreviewUrl)).toBe(false);
  await expect(page.getByRole("dialog", { name: "Commit changes" }))
    .toBeVisible();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(false);
  await page.getByRole("button", { name: "Close commit dialog" }).click();
  await expect.poll(
    () => app.nativePreviewIsVisible(hostilePreviewUrl),
  ).toBe(true);
});

test("keeps app shortcuts active while the native preview owns focus", async () => {
  await resizeWindow(1440, 920);
  await ensureWorkspaceTools();
  await page.getByRole("tab", { name: /Preview/ }).click();
  const focusedPreviewUrl = `${previewUrl}shortcut-focus`;
  await page.getByRole("textbox", { name: "Preview address" })
    .fill(focusedPreviewUrl);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(
    () => electronApp.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some(
        (contents) => contents.getURL() === url,
      ), focusedPreviewUrl),
  ).toBe(true);

  await electronApp.evaluate(({ webContents }, { url, modifier }) => {
    const preview = webContents.getAllWebContents().find(
      (contents) => contents.getURL() === url,
    );
    if (!preview) throw new Error("The native preview is unavailable.");
    preview.focus();
    preview.sendInputEvent({
      type: "keyDown",
      keyCode: "K",
      modifiers: [modifier as "meta" | "control"],
    });
    preview.sendInputEvent({
      type: "keyUp",
      keyCode: "K",
      modifiers: [modifier as "meta" | "control"],
    });
  }, {
    url: focusedPreviewUrl,
    modifier: process.platform === "darwin" ? "meta" : "control",
  });

  await expect(page.getByRole("dialog", { name: "Search Inertia" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Close search" }).click();
  expect(rendererErrors).toEqual([]);
});

test("navigates the project file hierarchy lazily with an accessible keyboard tree", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  const addProject = page.getByRole("button", { name: "Add your first project" });
  if (await addProject.isVisible().catch(() => false)) {
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-connection-status",
      "online",
      { timeout: 15_000 },
    );
    await electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, workspaceDirectory);
    await addProject.click();
    await expect(page.getByRole("heading", {
      name: "What should we work on?",
      level: 3,
    }))
      .toBeVisible({ timeout: 15_000 });
    await page.getByRole("complementary", {
      name: "Project navigation",
      exact: true,
    })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
  }

  const filesTab = page.getByRole("tab", { name: /Files/ });
  if (!await filesTab.isVisible().catch(() => false)) {
    await ensureWorkspaceTools();
  }
  await filesTab.click();
  const panel = page.getByRole("region", { name: "Project files" });
  const tree = panel.getByRole("tree", { name: "Workspace files" });
  await expect(tree).toBeVisible();
  await expect(tree.getByText("CaseSensitiveLeaf.ts", { exact: true })).toHaveCount(0);

  const src = tree.getByRole("treeitem", { name: "src", exact: true });
  await src.focus();
  await src.press("ArrowRight");
  await expect(src).toHaveAttribute("aria-expanded", "true");
  const components = tree.getByRole("treeitem", { name: "components", exact: true });
  await expect(components).toHaveAttribute("aria-level", "2");
  await src.press("ArrowRight");
  await expect(components).toBeFocused();
  await components.press("ArrowRight");
  await expect(components).toHaveAttribute("aria-expanded", "true");

  const deep = tree.getByRole("treeitem", { name: "deep", exact: true });
  const buttonFile = tree.getByRole("treeitem", { name: "Button.tsx", exact: true });
  await expect(deep).toHaveAttribute("aria-level", "3");
  await components.press("ArrowRight");
  await expect(deep).toBeFocused();
  await deep.press("ArrowDown");
  await expect(buttonFile).toBeFocused();
  await buttonFile.press("Enter");
  await expect(buttonFile).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByLabel("Contents of src/components/Button.tsx"))
    .toContainText("export const Button");
  await panel.getByRole("button", {
    name: "Edit src/components/Button.tsx in Inertia",
  }).click();
  const editor = page.getByRole("dialog", { name: "Edit Button.tsx" });
  await expect(editor).toBeVisible();
  const editorInput = editor.getByRole("textbox", {
    name: "Edit contents of src/components/Button.tsx",
  });
  await editorInput.fill("export const Button = 'edited in Inertia';\n");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByLabel("Contents of src/components/Button.tsx"))
    .toContainText("edited in Inertia");
  await expect.poll(
    () => readFile(
      join(workspaceDirectory, "src", "components", "Button.tsx"),
      "utf8",
    ),
  ).toContain("edited in Inertia");

  const search = panel.getByRole("searchbox", { name: "Search project files" });
  await search.fill("deep");
  const searchTree = panel.getByRole("tree", { name: "Workspace file search results" });
  const deepResult = searchTree.getByRole("treeitem").filter({ hasText: "deep" }).first();
  await expect(deepResult).toHaveAttribute("title", "src/components/deep");
  await deepResult.press("Enter");
  await expect(search).toHaveValue("");
  await expect(deep).toBeFocused();
  const leaf = tree.getByRole("treeitem", { name: "CaseSensitiveLeaf.ts", exact: true });
  await expect(leaf).toHaveAttribute("aria-level", "4");
  await leaf.focus();
  await leaf.press("Enter");
  await expect(leaf).toHaveAttribute("aria-current", "true");
  await expect(panel.getByLabel("Contents of src/components/deep/CaseSensitiveLeaf.ts"))
    .toContainText("export const leaf = true");

  await search.fill("guide");
  await expect(searchTree.getByRole("treeitem").filter({ hasText: "guide.md" })).toBeVisible();
  await panel.getByRole("button", { name: "Clear file search" }).click();
  await expect(search).toBeFocused();
  await expect(components).toHaveAttribute("aria-expanded", "true");
  await expect(deep).toHaveAttribute("aria-expanded", "true");

  await leaf.press("End");
  await expect(tree.getByRole("treeitem", { name: "sample.ts", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem", { name: "docs", exact: true })).toBeFocused();

  const emptyFolder = tree.getByRole("treeitem", { name: "empty-folder", exact: true });
  await emptyFolder.press("Enter");
  await expect(tree.getByRole("status")).toContainText("empty-folder is empty");
  await page.screenshot({ path: testInfo.outputPath("recursive-files-tree-1440x920.png") });

  await resizeWindow(760, 800);
  await expect(tree).toBeVisible();
  await expect(leaf).toBeVisible();
  await expectNoViewportOverflow();
  await page.screenshot({ path: testInfo.outputPath("recursive-files-tree-760x800.png") });
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

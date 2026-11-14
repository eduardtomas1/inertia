// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const execFileAsync = promisify(execFile);
const SAMPLE = "sample.ts";
// The working copy edits line 1 (an intraline pair) and appends line 3.
const COMMITTED_SAMPLE = "export const version = '0.0.1';\nexport const channel = 'stable';\n";
const WORKING_SAMPLE = "export const version = '0.0.2';\nexport const channel = 'stable';\nexport const ready = true;\n";
const EXTRA_COMMIT = "Add the release channel";

const gitDepthAppServer = `
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "git-depth-thread";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "git-depth-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
});
`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "git-depth",
    initialState: "conversation",
    codexAppServerSource: gitDepthAppServer,
    beforeLaunch: async ({ workspaceDirectory, testDirectory }) => {
      await git(workspaceDirectory, "config", "user.name", "Inertia Test");
      await git(workspaceDirectory, "config", "user.email", "test@example.invalid");
      const remote = join(testDirectory, "remote.git");
      await git(testDirectory, "init", "-q", "--bare", remote);
      await git(workspaceDirectory, "remote", "add", "origin", remote);
      await writeFile(join(workspaceDirectory, SAMPLE), COMMITTED_SAMPLE, "utf8");
      await git(workspaceDirectory, "add", "--", SAMPLE);
      await git(workspaceDirectory, "commit", "-q", "-m", EXTRA_COMMIT);
      await writeFile(join(workspaceDirectory, SAMPLE), WORKING_SAMPLE, "utf8");
    },
  });
  // Native menus cannot be read from the renderer: record each popup in the
  // main process, as edit-context-menu does, then close it at once so the
  // renderer's pending menu request settles without an action.
  await app.electronApp.evaluate(({ Menu }) => {
    Reflect.set(globalThis, "gitDepthMenus", []);
    Menu.prototype.popup = function (options) {
      (Reflect.get(globalThis, "gitDepthMenus") as Electron.Menu[]).push(this);
      options?.callback?.();
    };
  });
});

test.afterAll(async () => {
  await app.close();
});

async function capture(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await app.page.mouse.move(0, 0);
  await app.page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

function nativeMenuCount(): Promise<number> {
  return app.electronApp.evaluate(() => (Reflect.get(globalThis, "gitDepthMenus") as Electron.Menu[]).length);
}

function nativeMenuLabels(): Promise<string[]> {
  return app.electronApp.evaluate(() => {
    const menu = (Reflect.get(globalThis, "gitDepthMenus") as Electron.Menu[]).at(-1);
    return (menu?.items ?? []).filter((item) => item.type !== "separator").map((item) => item.label);
  });
}

async function blurActiveElement(): Promise<void> {
  await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function openChanges(): Promise<{ panel: Locator; files: Locator; diff: Locator }> {
  const page = app.page;
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Changes");
  const files = page.getByRole("navigation", { name: "Git repositories and changed files" });
  await expect(files).toBeVisible();
  await files.locator(".workspace-repository-file", { hasText: SAMPLE }).click();
  const diff = page.getByRole("region", { name: `Diff content for ${SAMPLE}`, exact: true });
  await expect(diff).toBeVisible();
  return { panel, files, diff };
}

async function openGitMenu(): Promise<Locator> {
  const page = app.page;
  const menu = page.getByRole("menu", { name: "Git actions" });
  if (!await menu.isVisible()) await page.getByRole("button", { name: "More Git actions" }).click();
  await expect(menu).toBeVisible();
  return menu;
}

test("the Changes diff highlights syntax and changed words in unified and split layouts", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await setAppearanceInPlace(app, "light");
  const { diff } = await openChanges();

  const deletion = diff.locator(".diff-line.is-deletion").filter({ hasText: "'0.0.1'" });
  const addition = diff.locator(".diff-line.is-addition").filter({ hasText: "'0.0.2'" });
  await expect(deletion).toHaveCount(1);
  await expect(addition).toHaveCount(1);
  await expect(diff.locator(".diff-line.is-addition").filter({ hasText: "export const ready = true;" })).toHaveCount(1);
  // highlight.js emits `hljs-*` spans inside the verified line markup.
  await expect(addition.locator(".diff-line-content.hljs .hljs-keyword").first()).toHaveText("export");
  await expect(addition.locator(".diff-line-content.hljs .hljs-string")).toContainText("0.0.2");
  await expect(addition.locator("mark.diff-intraline")).not.toHaveCount(0);
  await expect(deletion.locator("mark.diff-intraline")).not.toHaveCount(0);
  await expect(addition.locator("mark.diff-intraline").first()).toContainText("2");
  await expect(deletion.locator("mark.diff-intraline").first()).toContainText("1");
  await expect(diff).not.toHaveClass(/is-split/u);
  await blurActiveElement();
  await capture(info, "changes-unified-highlighted-light");

  // The default tools width is below the split minimum: widen the panel with
  // the keyboard, as a person can, before choosing Split.
  const layout = page.getByRole("group", { name: /^Diff layout/u });
  const resize = page.getByRole("separator", { name: "Resize workspace tools" });
  await resize.focus();
  await resize.press("End");
  await expect(layout).toHaveAccessibleName("Diff layout");
  const split = layout.getByRole("button", { name: "Split", exact: true });
  const unified = layout.getByRole("button", { name: "Unified", exact: true });
  await expect(unified).toHaveAttribute("aria-pressed", "true");
  await split.click();
  await expect(split).toHaveAttribute("aria-pressed", "true");
  await expect(unified).toHaveAttribute("aria-pressed", "false");
  await expect(diff).toHaveClass(/is-split/u);
  // Split view folds the changed-file list into a "Files (N)" strip above the diff.
  const filesStrip = page.getByRole("button", { name: "Files (1)", exact: true });
  await expect(filesStrip).toBeVisible();
  await expect(filesStrip).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".changes-split-files-current")).toHaveText(SAMPLE);
  await expect(page.getByRole("navigation", { name: "Git repositories and changed files" })).toHaveCount(0);
  const changeRow = diff.locator(".diff-split-row").filter({ has: page.locator('.diff-split-cell[data-side="old"].is-deletion') });
  await expect(changeRow).toHaveCount(1);
  const oldCell = changeRow.locator('.diff-split-cell[data-side="old"]');
  const newCell = changeRow.locator('.diff-split-cell[data-side="new"]');
  await expect(oldCell).toContainText("'0.0.1'");
  await expect(newCell).toContainText("'0.0.2'");
  await expect(newCell).toHaveClass(/is-addition/u);
  await expect(newCell.locator("mark.diff-intraline")).not.toHaveCount(0);
  await expect(newCell.locator(".hljs-keyword").first()).toHaveText("export");
  const [oldBox, newBox] = [await oldCell.boundingBox(), await newCell.boundingBox()];
  expect(oldBox && newBox).toBeTruthy();
  expect(newBox!.x).toBeGreaterThanOrEqual(oldBox!.x + oldBox!.width - 1);
  expect(Math.abs(newBox!.y - oldBox!.y)).toBeLessThan(2);
  // The appended line has no old-side partner: a placeholder fills that column.
  await expect(diff.locator('.diff-split-placeholder[data-side="old"]')).toHaveCount(1);
  await expect(diff.locator(".diff-split-context")).toHaveCount(1);
  await blurActiveElement();
  await app.expectNoViewportOverflow();
  await capture(info, "changes-split-light");
  await setAppearanceInPlace(app, "dark");
  await expect(diff).toHaveClass(/is-split/u);
  await capture(info, "changes-split-dark");
  await setAppearanceInPlace(app, "light");

  await unified.click();
  await expect(unified).toHaveAttribute("aria-pressed", "true");
  await expect(diff).not.toHaveClass(/is-split/u);
  await expect(filesStrip).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Git repositories and changed files" })).toBeVisible();
  await resize.focus();
  await resize.press("Enter");
  await expect(resize).toHaveAttribute("aria-valuenow", "520");
  await blurActiveElement();
  expect(app.rendererErrors).toEqual([]);
});

test("Changes stages and unstages a file and the commit dialog drafts a message", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 1100);
  await setAppearanceInPlace(app, "light");
  const { files } = await openChanges();
  const row = files.locator(".workspace-repository-file", { hasText: SAMPLE });
  const stage = files.getByRole("button", { name: new RegExp(`^Stage ${SAMPLE.replace(".", "\\.")} in `, "u") });
  const unstage = files.getByRole("button", { name: new RegExp(`^Unstage ${SAMPLE.replace(".", "\\.")} in `, "u") });
  const stagedHeading = files.locator(".workspace-change-section-heading", { hasText: "Staged" });
  const changesHeading = files.locator(".workspace-change-section-heading", { hasText: "Changes" });
  await expect(stage).toBeVisible();
  await expect(stagedHeading).toHaveCount(0);
  await expect(changesHeading.getByRole("button", { name: /^Stage all 1 changed file in /u })).toBeVisible();

  let before = await nativeMenuCount();
  await row.click({ button: "right" });
  await expect.poll(nativeMenuCount).toBe(before + 1);
  expect(await nativeMenuLabels()).toContain("Stage");
  expect(await nativeMenuLabels()).not.toContain("Unstage");

  // The index action and Open sit side by side, so a pointer reaches Stage.
  await row.hover();
  const open = files.getByRole("button", { name: new RegExp(`^Open ${SAMPLE.replace(".", "\\.")} from `, "u") });
  const [stageBox, openBox] = [await stage.boundingBox(), await open.boundingBox()];
  expect(stageBox && openBox).toBeTruthy();
  expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(openBox!.x + 1);
  await stage.click();
  await expect(unstage).toBeVisible();
  await expect(stage).toHaveCount(0);
  await expect(stagedHeading).toContainText("1");
  await expect(stagedHeading.getByRole("button", { name: /^Unstage all 1 staged file in /u })).toBeVisible();
  await expect(changesHeading).toHaveCount(0);
  await expect.poll(() => git(app.workspaceDirectory, "diff", "--cached", "--name-only")).toBe(SAMPLE);
  before = await nativeMenuCount();
  await row.click({ button: "right" });
  await expect.poll(nativeMenuCount).toBe(before + 1);
  expect(await nativeMenuLabels()).toContain("Unstage");
  // Let the index change finish refreshing the diff before the capture.
  await expect(page.getByRole("region", { name: "Workspace changes", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("Refreshing this diff.", { exact: false })).toHaveCount(0);
  // Focus keeps the row's index action shown (it is hidden until hover or focus).
  await unstage.focus();
  await capture(info, "changes-stage-light");

  await unstage.click();
  await expect(stage).toBeVisible();
  await expect(stagedHeading).toHaveCount(0);
  await expect.poll(() => git(app.workspaceDirectory, "diff", "--cached", "--name-only")).toBe("");

  const menu = await openGitMenu();
  await menu.getByRole("menuitem", { name: /^Commit/u }).click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await expect(dialog).toBeVisible();
  const message = dialog.getByRole("textbox", { name: "Commit message" });
  await expect(message).toHaveValue("");
  const draft = dialog.getByRole("button", { name: "Draft message", exact: true });
  await expect(draft).toBeEnabled({ timeout: 30_000 });
  await message.focus();
  await message.press("Enter");
  await expect(message).toHaveValue("\n");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Subject 0/72", { exact: true })).toBeVisible();
  // A blank message is still "empty", so the button keeps its first label.
  await draft.click();
  await expect(message).toHaveValue(new RegExp(`^Update ${SAMPLE.replace(".", "\\.")}\\n\\n- Modified: ${SAMPLE.replace(".", "\\.")}$`, "u"));
  await expect(message).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Replace with draft", exact: true })).toBeVisible();
  await expect(dialog.getByText(`Subject ${`Update ${SAMPLE}`.length}/72`, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Commit", exact: true })).toBeEnabled({ timeout: 30_000 });
  await capture(info, "commit-dialog-draft-light");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await git(app.workspaceDirectory, "log", "-1", "--format=%s")).toBe(EXTRA_COMMIT);
  expect(await git(app.workspaceDirectory, "status", "--porcelain", "--", SAMPLE)).toBe(`M ${SAMPLE}`);
  expect(app.rendererErrors).toEqual([]);
});


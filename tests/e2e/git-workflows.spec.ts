// @inertia-e2e-resource primary-display
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator } from "@playwright/test";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const execFileAsync = promisify(execFile);
async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitOutput(cwd, ...args)).trim();
}
let app: AppFixture;
let remote: string;
let initialBranch: string;
test.beforeEach(async () => {
  app = await createAppFixture({
    name: "git-workflows", initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: async ({ workspaceDirectory, testDirectory }) => {
      remote = join(testDirectory, "remote.git");
      await git(testDirectory, "init", "--bare", remote);
      await git(workspaceDirectory, "remote", "add", "origin", remote);
      await git(workspaceDirectory, "config", "user.name", "Inertia Test");
      await git(workspaceDirectory, "config", "user.email", "test@example.invalid");
      initialBranch = await git(workspaceDirectory, "branch", "--show-current");
      await git(workspaceDirectory, "push", "-u", "origin", initialBranch);
      await git(remote, "branch", "feature/remote-review", initialBranch);
      await git(workspaceDirectory, "fetch", "origin");
      await git(workspaceDirectory, "branch", "feature/local-review");
      await git(workspaceDirectory, "worktree", "add", "-b", "feature/occupied", join(testDirectory, "occupied"));
    },
  });
  await app.resizeWindow(1440, 920);
  await app.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.style.colorScheme = "dark"; });
});
test.afterEach(async () => { await app?.close(); });

async function capture(name: string): Promise<void> {
  const path = test.info().outputPath(name);
  await app.page.screenshot({ path, animations: "disabled" });
  await test.info().attach(name, { path, contentType: "image/png" });
}
async function openGit(): Promise<Locator> {
  const menu = app.page.getByRole("menu", { name: "Git actions" });
  if (!await menu.isVisible()) await app.page.getByRole("button", { name: "More Git actions" }).click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Fetch/u })).not.toHaveAttribute("aria-disabled", "true");
  return menu;
}
async function fetchFromUi(): Promise<void> {
  const menu = await openGit();
  await menu.getByRole("menuitem", { name: /^Fetch/u }).click();
  await openGit();
  await app.page.keyboard.press("Escape");
}
async function commitFromUi(message: string, screenshot = false): Promise<void> {
  const menu = await openGit();
  await menu.getByRole("menuitem", { name: /^Commit/u }).click();
  const dialog = app.page.getByRole("dialog", { name: "Commit changes" });
  await dialog.getByRole("textbox", { name: "Commit message" }).fill(message);
  const submit = dialog.getByRole("button", { name: "Commit", exact: true });
  // Complete review owns many guarded Git inspections on macOS. Use normal
  // action readiness within the unchanged test deadline before checking the
  // completed review's branch context; typing does not require review readiness.
  await submit.click({ trial: true });
  await expect(dialog.getByText(initialBranch, { exact: true })).toBeVisible();
  await expect(submit).toBeEnabled();
  if (screenshot) await capture("git-commit-review-dark.png");
  await submit.click();
  await expect(dialog).toBeHidden();
  expect(await git(app.workspaceDirectory, "log", "-1", "--format=%s")).toBe(message);
}

test("fetch preserves local work and recovers after a remote failure", async () => {
  const { page, workspaceDirectory } = app;
  const before = await readFile(join(workspaceDirectory, "sample.ts"), "utf8");
  const menu = await openGit();
  await expect(menu.getByText("Up to date with last fetch")).toBeVisible();
  await capture("git-overview-dark.png");
  await git(remote, "branch", "feature/fetched", initialBranch);
  await git(workspaceDirectory, "remote", "set-url", "origin", join(app.testDirectory, "missing.git"));
  await menu.getByRole("menuitem", { name: /^Fetch/u }).click();
  await expect(page.locator(".error-toast").getByRole("button", { name: "Dismiss error" })).toBeVisible();
  await capture("git-fetch-error-dark.png");
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  await git(workspaceDirectory, "remote", "set-url", "origin", remote);
  const refDirectory = join(workspaceDirectory, ".git", "refs", "remotes", "origin", "feature");
  await mkdir(refDirectory, { recursive: true });
  const refLock = join(refDirectory, "fetched.lock");
  await writeFile(refLock, "fixture holds the tracking ref until the busy state is observed\n");
  await git(workspaceDirectory, "config", "core.filesRefLockTimeout", "10000");
  await (await openGit()).getByRole("menuitem", { name: /^Fetch/u }).click();
  await page.getByRole("button", { name: "More Git actions" }).click();
  await expect(menu.getByRole("menuitem", { name: /^Fetch/u })).toHaveAttribute("aria-disabled", "true");
  await capture("git-fetch-busy-dark.png");
  await unlink(refLock);
  await openGit();
  await page.keyboard.press("Escape");
  expect(await git(workspaceDirectory, "rev-parse", "refs/remotes/origin/feature/fetched")).toBe(await git(remote, "rev-parse", initialBranch));
  expect(await readFile(join(workspaceDirectory, "sample.ts"), "utf8")).toBe(before);
  await expect(page.locator(".error-toast")).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

test("branch search retains failed choices and keeps keyboard focus visible", async () => {
  const { page, workspaceDirectory } = app;
  const trigger = page.locator('[data-header-menu="branch"] > button');
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Branches" });
  const search = menu.getByRole("searchbox", { name: "Search branches" });
  await expect(menu.getByRole("menuitemradio", { name: /feature\/occupied/u })).toBeDisabled();
  await expect(menu.getByRole("menuitemradio", { name: /origin\/feature\/remote-review/u })).toBeEnabled();
  const geometry = await menu.locator(".git-branch-results").evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
    names: [...element.querySelectorAll(".git-branch-name")].map((name) => name.getBoundingClientRect().width),
  }));
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.names.every((width) => width > 100)).toBe(true);
  await capture("git-branches-dark.png");
  await search.fill("remote-review");
  await search.press("Enter");
  await expect(menu.getByRole("alert")).toContainText("Commit or stash local changes before switching branches.");
  await expect(search).toHaveValue("remote-review");
  await expect(menu.getByRole("menuitemradio", { name: /origin\/feature\/remote-review/u })).toBeEnabled();
  await expect(page.locator(".error-toast")).toHaveCount(0);
  await capture("git-branch-error-dark.png");
  const create = menu.getByRole("textbox", { name: "New branch name" });
  await create.fill("feature/keep-editing");
  await create.press("Home");
  await expect(create).toBeFocused();
  expect(await create.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(0);
  await create.press("End");
  expect(await create.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe("feature/keep-editing".length);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  for (let index = 0; index < 24; index += 1) await git(workspaceDirectory, "branch", `topic/review-${String(index).padStart(2, "0")}`);
  await trigger.click();
  await expect(menu.getByRole("menuitemradio", { name: "topic/review-23", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "topic/review-23", exact: true })).toBeEnabled();
  await search.focus();
  const count = await menu.locator('.git-branch-results button:not(:disabled)').count();
  for (let index = 0; index < count; index += 1) await page.keyboard.press("ArrowDown");
  const focused = await menu.locator(".git-branch-results").evaluate((element) => {
    const row = document.activeElement?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return { scrollTop: element.scrollTop, visible: Boolean(row && row.top >= bounds.top && row.bottom <= bounds.bottom + 1) };
  });
  expect(focused.scrollTop).toBeGreaterThan(0);
  expect(focused.visible).toBe(true);
  await search.fill(initialBranch);
  await search.press("Enter");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await git(workspaceDirectory, "branch", "--show-current")).toBe(initialBranch);
  expect(app.rendererErrors).toEqual([]);
});

test("commits reviewed paths and pushes existing commits while preserving unrelated edits", async () => {
  const { workspaceDirectory } = app;
  await commitFromUi("Reviewed fixture change", true);
  expect(await git(workspaceDirectory, "status", "--porcelain")).toBe("");
  const localHead = await git(workspaceDirectory, "rev-parse", "HEAD");
  await writeFile(join(workspaceDirectory, "notes.txt"), "unfinished local work\n");
  await fetchFromUi();
  const menu = await openGit();
  await expect(menu.getByText("1 outgoing", { exact: true })).toBeVisible();
  const push = menu.getByRole("menuitem", { name: /^Push 1/u });
  await expect(push).not.toHaveAttribute("aria-disabled", "true");
  await capture("git-outgoing-dark.png");
  await push.click();
  await expect.poll(async () => await git(remote, "rev-parse", `refs/heads/${initialBranch}`)).toBe(localHead);
  expect(await readFile(join(workspaceDirectory, "notes.txt"), "utf8")).toBe("unfinished local work\n");
  expect(app.rendererErrors).toEqual([]);
});

test("tracks an exact remote branch and fast-forwards incoming commits", async () => {
  const { page, workspaceDirectory } = app;
  await git(workspaceDirectory, "config", "core.autocrlf", "true");
  await commitFromUi("Prepare clean checkout");
  await git(workspaceDirectory, "config", "--unset-all", "remote.origin.fetch");
  await fetchFromUi();
  const trigger = page.locator('[data-header-menu="branch"] > button');
  await trigger.click();
  const branches = page.getByRole("menu", { name: "Branches" });
  await branches.getByRole("searchbox").fill("remote-review");
  await expect(branches.getByRole("menuitemradio", { name: /origin\/feature\/remote-review/u })).toBeEnabled();
  await branches.getByRole("searchbox").press("Enter");
  await expect(branches).toBeHidden();
  await expect(trigger).toContainText("feature/remote-review");
  expect(await git(workspaceDirectory, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/remote-review");
  expect(await git(workspaceDirectory, "config", "--get-all", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  const peer = join(app.testDirectory, "peer");
  await git(app.testDirectory, "clone", "--branch", "feature/remote-review", remote, peer);
  await git(peer, "config", "user.name", "Inertia Peer");
  await git(peer, "config", "user.email", "peer@example.invalid");
  await writeFile(join(peer, "incoming.txt"), "reviewed incoming change\n");
  await git(peer, "add", "incoming.txt");
  await git(peer, "commit", "-m", "Incoming change");
  await git(peer, "push");
  await fetchFromUi();
  await app.resizeWindow(1100, 760);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.style.colorScheme = "light"; });
  const menu = await openGit();
  await expect(menu.getByText("Tracking origin/feature/remote-review")).toBeVisible();
  await expect(menu.getByText("1 incoming", { exact: true })).toBeVisible();
  const pull = menu.getByRole("menuitem", { name: /^Pull 1/u });
  await expect(pull).not.toHaveAttribute("aria-disabled", "true");
  await capture("git-incoming-light.png");
  await pull.click();
  await expect.poll(async () => await git(workspaceDirectory, "rev-parse", "HEAD")).toBe(await git(peer, "rev-parse", "HEAD"));
  expect(await git(workspaceDirectory, "show", "HEAD:incoming.txt")).toBe("reviewed incoming change");
  expect(await readFile(join(workspaceDirectory, "incoming.txt"), "utf8"))
    .toBe(await gitOutput(workspaceDirectory, "cat-file", "--filters", "HEAD:incoming.txt"));
  await openGit();
  await expect(menu.getByText("0 incoming", { exact: true })).toBeVisible();
  await capture("git-overview-light.png");
  await app.expectNoViewportOverflow();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "More Git actions" })).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});

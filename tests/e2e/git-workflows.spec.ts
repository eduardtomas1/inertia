import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
let app: AppFixture;
test.beforeAll(async () => {
  app = await createAppFixture({
    name: "git-workflows",
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: async ({ workspaceDirectory, testDirectory }) => {
      const remote = join(testDirectory, "remote.git");
      await git(testDirectory, "init", "--bare", remote);
      await git(workspaceDirectory, "remote", "add", "origin", remote);
      await git(workspaceDirectory, "config", "user.name", "Inertia Test");
      await git(workspaceDirectory, "config", "user.email", "test@example.invalid");
      const current = await git(workspaceDirectory, "branch", "--show-current");
      await git(workspaceDirectory, "push", "-u", "origin", current);
      await git(remote, "branch", "feature/remote-review", current);
      await git(workspaceDirectory, "branch", "feature/local-review");
      await git(workspaceDirectory, "worktree", "add", "-b", "feature/occupied", join(testDirectory, "occupied"));
    },
  });
});
test.afterAll(async () => { await app?.close(); });

test("reviews sync state, fetches safely, searches branches and checks out a remote", async () => {
  const testInfo = test.info();
  const { page, workspaceDirectory } = app;
  await app.resizeWindow(1440, 920);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.style.colorScheme = "dark"; });
  const openGit = async (): Promise<void> => {
    await page.getByRole("button", { name: "More Git actions" }).click();
    await expect(page.getByRole("menu", { name: "Git actions" })).toBeVisible();
  };
  await openGit();
  const menu = page.getByRole("menu", { name: "Git actions" });
  await expect(menu.getByText("Up to date with last fetch")).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Fetch/u })).not.toHaveAttribute("aria-disabled", "true");
  const overview = testInfo.outputPath("git-overview-dark.png");
  await page.screenshot({ path: overview, animations: "disabled" });
  await testInfo.attach("Git overview — implemented desktop", { path: overview, contentType: "image/png" });
  const before = await readFile(join(workspaceDirectory, "sample.ts"), "utf8");
  await menu.getByRole("menuitem", { name: /^Fetch/u }).click();
  await expect.poll(async () => await git(workspaceDirectory, "branch", "-r")).toContain("origin/feature/remote-review");
  expect(await readFile(join(workspaceDirectory, "sample.ts"), "utf8")).toBe(before);

  const branchTrigger = page.locator('[data-header-menu="branch"] > button');
  await branchTrigger.click();
  const branches = page.getByRole("menu", { name: "Branches" });
  await expect(branches.getByRole("menuitemradio", { name: /feature\/occupied/u })).toBeDisabled();
  await expect(branches.getByRole("menuitemradio", { name: /origin\/feature\/remote-review/u })).toBeEnabled();
  const branchGeometry = await branches.locator(".git-branch-results").evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
    nameWidths: [...element.querySelectorAll(".git-branch-name")].map((name) => name.getBoundingClientRect().width),
  }));
  expect(branchGeometry.overflow).toBeLessThanOrEqual(1);
  expect(branchGeometry.nameWidths.every((width) => width > 100)).toBe(true);
  const branchShot = testInfo.outputPath("git-branches-dark.png");
  await page.screenshot({ path: branchShot, animations: "disabled" });
  await testInfo.attach("Searchable local and remote branches", { path: branchShot, contentType: "image/png" });
  const search = branches.getByRole("searchbox", { name: "Search branches" });
  await search.fill("remote-review");
  await expect(branches.getByRole("group", { name: "Local branches" })).toHaveCount(0);
  await branches.getByRole("menuitemradio", { name: /origin\/feature\/remote-review/u }).click();
  await expect(page.getByText("Commit or stash local changes before switching branches.", { exact: true }).first()).toBeVisible();
  expect(await readFile(join(workspaceDirectory, "sample.ts"), "utf8")).toBe(before);
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();

  await openGit();
  await menu.getByRole("menuitem", { name: /^Commit/u }).click();
  const commitDialog = page.getByRole("dialog", { name: "Commit changes" });
  await commitDialog.getByRole("textbox", { name: "Commit message" }).fill("Reviewed fixture change");
  const commit = commitDialog.getByRole("button", { name: "Commit", exact: true });
  await expect(commit).toBeEnabled();
  const commitShot = testInfo.outputPath("git-commit-review-dark.png");
  await page.screenshot({ path: commitShot, animations: "disabled" });
  await testInfo.attach("Complete-diff commit review", { path: commitShot, contentType: "image/png" });
  await commit.click();
  await expect(commitDialog).toBeHidden();
  expect(await git(workspaceDirectory, "log", "-1", "--format=%s")).toBe("Reviewed fixture change");
  expect(await git(workspaceDirectory, "status", "--porcelain")).toBe("");
  await branchTrigger.click();
  await branches.getByRole("searchbox", { name: "Search branches" }).fill("remote-review");
  await branches.getByRole("menuitemradio", { name: /origin\/feature\/remote-review/u }).click();
  await expect.poll(async () => await git(workspaceDirectory, "branch", "--show-current")).toBe("feature/remote-review");
  await expect(branchTrigger).toContainText("feature/remote-review");
  expect(await git(workspaceDirectory, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/remote-review");

  await app.resizeWindow(1100, 760);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.style.colorScheme = "light"; });
  await openGit();
  await expect(menu.getByText("Tracking origin/feature/remote-review")).toBeVisible();
  const light = testInfo.outputPath("git-overview-light.png");
  await page.screenshot({ path: light, animations: "disabled" });
  await testInfo.attach("Git overview — light, compact window", { path: light, contentType: "image/png" });
  await app.expectNoViewportOverflow();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "More Git actions" })).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});

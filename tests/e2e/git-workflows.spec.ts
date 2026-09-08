// @inertia-e2e-resource primary-display
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator } from "@playwright/test";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { openLocalProjectFromDialog } from "./support/add-project";

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
const pushScenario = "pushes existing commits while preserving unrelated edits";
const trackingScenario = "tracks an exact remote branch with missing fetch mappings";
const pullScenario = "fast-forwards incoming commits using checkout filters";
test.beforeEach(async () => {
  const scenario = test.info().title;
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
      // Seed independent mutation scenarios before the renderer's first Git
      // scan so setup does not require another live refresh or UI operation.
      if (scenario === pushScenario || scenario === trackingScenario || scenario === pullScenario) {
        if (scenario !== pushScenario) await git(workspaceDirectory, "config", "core.autocrlf", "true");
        await git(workspaceDirectory, "add", "--", "sample.ts");
        await git(workspaceDirectory, "commit", "-m", "Prepare clean checkout");
      }
      if (scenario === pushScenario) {
        await writeFile(join(workspaceDirectory, "notes.txt"), "unfinished local work\n");
      } else if (scenario === trackingScenario) {
        await git(workspaceDirectory, "config", "--unset-all", "remote.origin.fetch");
      } else if (scenario === pullScenario) {
        await git(workspaceDirectory, "switch", "--track", "-c", "feature/remote-review", "refs/remotes/origin/feature/remote-review");
        const peer = join(testDirectory, "peer");
        await git(testDirectory, "clone", "--branch", "feature/remote-review", remote, peer);
        await git(peer, "config", "user.name", "Inertia Peer");
        await git(peer, "config", "user.email", "peer@example.invalid");
        await writeFile(join(peer, "incoming.txt"), "reviewed incoming change\n");
        await git(peer, "add", "incoming.txt");
        await git(peer, "commit", "-m", "Incoming change");
        await git(peer, "push");
      }
    },
  });
  await app.electronApp.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  await app.resizeWindow(1440, 920);
  await app.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.style.colorScheme = "dark"; });
});
async function readDiagnostic<T>(read: () => Promise<T>): Promise<
  { status: "complete"; value: T } | { status: "unavailable" | "timed-out" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then((value) => ({ status: "complete" as const, value }),
        () => ({ status: "unavailable" as const })),
      new Promise<{ status: "timed-out" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed-out" }), 2_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

test.afterEach(async () => {
  const info = test.info();
  try {
    if (info.status !== info.expectedStatus && app) {
      const [ui, runtime, repository] = await Promise.all([
        readDiagnostic(() => app.page.evaluate(() => {
          const describe = (element: Element): unknown => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return { tag: element.tagName, role: element.getAttribute("role"),
              text: element.textContent?.slice(0, 120), disabled: element.hasAttribute("disabled"),
              checked: element.getAttribute("aria-checked"), busy: element.getAttribute("aria-busy"),
              display: style.display, visibility: style.visibility, opacity: style.opacity,
              width: rect.width, height: rect.height, top: rect.top, left: rect.left,
              inert: Boolean(element.closest("[inert]")), hidden: Boolean(element.closest('[aria-hidden="true"]')) };
          };
          return {
            connection: document.querySelector(".app-shell")?.getAttribute("data-connection-status"),
            visibility: document.visibilityState, focus: document.activeElement?.getAttribute("aria-label"),
            branchQuery: document.querySelector<HTMLInputElement>('[aria-label="Search branches"]')?.value,
            nodes: Array.from(document.querySelectorAll('.git-branch-results, .git-branch-results button, .git-branch-load-status, .git-branch-error, .commit-dialog, .commit-dialog button, .commit-dialog header, .error-toast')).slice(0, 50).map(describe),
          };
        })),
        readDiagnostic(async () => {
          const value = await app.runtimeSnapshot();
          return { phase: value.phase, generation: value.generation, restartAttempt: value.restartAttempt,
            restartScheduled: value.restartScheduled };
        }),
        readDiagnostic(async () => {
          const readGit = async (args: string[]): Promise<string> => (await execFileAsync("git", args, {
            cwd: app.workspaceDirectory, timeout: 1_500, maxBuffer: 16 * 1024,
          })).stdout;
          const [subject, status] = await Promise.all([
            readGit(["log", "-1", "--format=%s"]), readGit(["status", "--porcelain=v2", "--branch"]),
          ]);
          return { subject, status };
        }),
      ]);
      await readDiagnostic(async () => await info.attach("git-ui-failure-state", {
        body: JSON.stringify({ ui, repository,
          runtime, rendererErrorCount: app.rendererErrors.length }, null, 2), contentType: "application/json",
      }));
      await readDiagnostic(async () => {
        const path = info.outputPath("git-ui-failure.png");
        await app.page.screenshot({ path, animations: "disabled", timeout: 1_500 });
        await info.attach("git-ui-failure", { path, contentType: "image/png" });
      });
    }
  } finally {
    try {
      if (app) {
        await readDiagnostic(async () => {
          const path = info.outputPath("git-browser-trace.zip");
          await app.electronApp.context().tracing.stop({ path });
          await info.attach("git-browser-trace", { path, contentType: "application/zip" });
        });
      }
    } finally { await app?.close(); }
  }
});

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
    const active = document.activeElement;
    const row = active?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const rectangle = (value: DOMRect | undefined): unknown => value && ({
      top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height,
    });
    return {
      scrollTop: element.scrollTop, visible: Boolean(row && row.top >= bounds.top && row.bottom <= bounds.bottom + 1),
      activeTag: active?.tagName, activeRole: active?.getAttribute("role"), activeInside: element.contains(active),
      activeBranch: active?.querySelector(".git-branch-name")?.textContent?.slice(0, 80),
      row: rectangle(row), bounds: rectangle(bounds), menu: rectangle(element.closest('[role="menu"]')?.getBoundingClientRect()),
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollBehavior: getComputedStyle(element).scrollBehavior,
      enabledRows: element.querySelectorAll('button:not(:disabled)').length,
    };
  });
  expect(focused.scrollTop).toBeGreaterThan(0);
  expect(focused.visible, JSON.stringify({ keyPresses: count, ...focused })).toBe(true);
  await search.fill(initialBranch);
  await search.press("Enter");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await git(workspaceDirectory, "branch", "--show-current")).toBe(initialBranch);
  expect(app.rendererErrors).toEqual([]);
});

// Keep each guarded mutation within its own unchanged scenario budget. On
// Intel CI, review alone took 26 seconds and tracking plus two fetches left
// only three seconds for Pull in the former combined scenarios.
test("commits reviewed paths", async () => {
  const { workspaceDirectory } = app;
  await commitFromUi("Reviewed fixture change", true);
  expect(await git(workspaceDirectory, "status", "--porcelain")).toBe("");
  expect(app.rendererErrors).toEqual([]);
});

test(pushScenario, async () => {
  const { workspaceDirectory } = app;
  const localHead = await git(workspaceDirectory, "rev-parse", "HEAD");
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

test(trackingScenario, async () => {
  const { page, workspaceDirectory } = app;
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
  expect(app.rendererErrors).toEqual([]);
});

test(pullScenario, async () => {
  const { page, workspaceDirectory } = app;
  const peer = join(app.testDirectory, "peer");
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

test("fetch uses the imported project draft workspace", async () => {
  const { page, workspaceDirectory } = app;
  const before = await readFile(join(workspaceDirectory, "sample.ts"), "utf8");
  await app.electronApp.evaluate(({ dialog }, directory) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [directory], bookmarks: [] }));
  }, workspaceDirectory);
  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.getByRole("button", { name: "Add project", exact: true }).click();
  await openLocalProjectFromDialog(page);
  const heading = page.getByRole("heading", { name: /^What should we build in .+\?$/u });
  await expect(heading).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this draft while I fetch");
  await git(remote, "branch", "feature/draft-fetch", initialBranch);
  await fetchFromUi();
  await expect.poll(() => git(workspaceDirectory, "for-each-ref", "--format=%(objectname)", "refs/remotes/origin/feature/draft-fetch"))
    .toBe(await git(remote, "rev-parse", "feature/draft-fetch"));
  expect(await readFile(join(workspaceDirectory, "sample.ts"), "utf8")).toBe(before);
  await expect(input).toHaveValue("Keep this draft while I fetch");
  await expect(heading).toBeVisible();
  await expect(page.locator(".error-toast")).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

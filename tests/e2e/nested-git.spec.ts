import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../src/server/database";

const execFileAsync = promisify(execFile);

let application: ElectronApplication;
let page: Page;
let fixtureRoot: string;
let workspaceRoot: string;
const rendererErrors: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function createDirtyModule(
  repositoryPath: string,
  after: string,
  branch: string,
): Promise<void> {
  const source = join(repositoryPath, "src", "Main.java");
  await mkdir(dirname(source), { recursive: true });
  await git(repositoryPath, "init", "-q");
  await git(repositoryPath, "config", "user.name", "Inertia E2E");
  await git(repositoryPath, "config", "user.email", "e2e@inertia.invalid");
  await writeFile(source, "class Main { static final String STATE = \"before\"; }\n");
  await git(repositoryPath, "add", "--", "src/Main.java");
  await git(repositoryPath, "commit", "-q", "-m", "Initial module");
  await git(repositoryPath, "branch", "-m", branch);
  await writeFile(source, `class Main { static final String STATE = "${after}"; }\n`);
}

async function resizeWindow(width: number, height: number): Promise<void> {
  await application.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
  await page.waitForTimeout(200);
}

test.beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "inertia-nested-git-e2e-"));
  workspaceRoot = join(fixtureRoot, "Openbravo");
  await mkdir(workspaceRoot, { recursive: true });
  await createDirtyModule(
    join(workspaceRoot, "modules", "org.openbravo.alpha"),
    "alpha after",
    "feature/nested-alpha-change-review",
  );
  await createDirtyModule(
    join(workspaceRoot, "modules", "org.openbravo.beta"),
    "beta after",
    "feature/nested-beta-change-review-with-a-long-name",
  );
  const dataDirectory = join(fixtureRoot, "data");
  await mkdir(dataDirectory, { recursive: true });
  const store = new RuntimeStore(
    join(dataDirectory, "inertia.sqlite"),
    workspaceRoot,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Openbravo", workspaceRoot);
  store.createConversation(project.id, "Nested repositories");
  store.close();

  application = await electron.launch({
    args: [".", `--user-data-dir=${join(fixtureRoot, "electron-profile")}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: join(fixtureRoot, "data"),
      INERTIA_WORKSPACE_DIR: workspaceRoot,
    },
  });
  page = await application.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.getByRole("heading", { name: "Nested repositories", level: 1 }).waitFor();
});

test.afterAll(async () => {
  await application?.close();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test("discovers and reviews dirty nested Openbravo repositories without a root Git repository", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
  await page.getByRole("tab", { name: /Changes/ }).click();

  const changes = page.getByLabel("Workspace changes");
  const repositoryList = changes.getByRole("navigation", {
    name: "Git repositories and changed files",
  });
  await expect(repositoryList).toBeVisible();
  await expect(changes.getByText("2 files in 2 repositories", { exact: true })).toBeVisible();
  const repositoryScope = changes.getByRole("combobox", {
    name: "Repository scope",
  });
  await expect(repositoryScope).toBeVisible();
  await expect(repositoryScope.getByRole("option", {
    name: "modules/org.openbravo.alpha · 1 file",
  })).toHaveCount(1);
  await expect(repositoryScope.getByRole("option", {
    name: "modules/org.openbravo.beta · 1 file",
  })).toHaveCount(1);

  await repositoryScope.selectOption("modules/org.openbravo.beta");
  await expect(changes.locator(".workspace-repository-scope-boundary"))
    .toContainText("Nested repo");
  await expect(changes.locator(".diff-line.is-addition").filter({ hasText: "beta after" })).toBeVisible();
  await expect(changes.locator(".diff-line.is-addition").filter({ hasText: "alpha after" })).toHaveCount(0);
  await expect(repositoryList.getByRole("button", {
    name: "Open src/Main.java from modules/org.openbravo.beta",
  })).toBeVisible();

  const wideLight = testInfo.outputPath("nested-git-openbravo-wide-light.png");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  });
  await page.screenshot({ animations: "disabled", path: wideLight });
  expect((await page.locator("body").screenshot()).byteLength).toBeGreaterThan(1_000);

  const workspaceBody = page.locator(".workspace-body");
  const previousToolsWidth = await workspaceBody.evaluate((element) =>
    element.style.getPropertyValue("--workspace-tools-width"));
  await workspaceBody.evaluate((element) => {
    element.style.setProperty("--workspace-tools-width", "300px");
  });
  await expect.poll(async () => await changes.locator(".workspace-repository-scope")
    .evaluate((element) => ({
      fits: element.scrollWidth <= element.clientWidth + 1,
      width: element.clientWidth,
    }))).toEqual({ fits: true, width: 300 });
  const repositoryTypography = await changes.evaluate((element) => {
    const root = getComputedStyle(document.documentElement);
    const scope = element.querySelector<HTMLElement>(
      ".workspace-repository-scope-meta",
    );
    const fileName = element.querySelector<HTMLElement>(
      ".workspace-repository-file-copy strong",
    );
    return {
      expectedMicro: Number.parseFloat(root.getPropertyValue("--ui-font-micro")),
      expectedSecondary: Number.parseFloat(root.getPropertyValue("--ui-font-secondary")),
      scope: scope ? Number.parseFloat(getComputedStyle(scope).fontSize) : 0,
      fileName: fileName ? Number.parseFloat(getComputedStyle(fileName).fontSize) : 0,
    };
  });
  expect(repositoryTypography.scope)
    .toBeGreaterThanOrEqual(repositoryTypography.expectedMicro);
  expect(repositoryTypography.fileName)
    .toBeGreaterThanOrEqual(repositoryTypography.expectedSecondary);
  await workspaceBody.evaluate((element, value) => {
    if (value) element.style.setProperty("--workspace-tools-width", value);
    else element.style.removeProperty("--workspace-tools-width");
  }, previousToolsWidth);

  await resizeWindow(1040, 800);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  const picker = changes.getByRole("combobox", { name: "Repository and changed file" });
  await expect(picker).toBeVisible();
  await expect(picker.locator("option:checked")).toHaveText(
    "M · src/Main.java",
  );
  await expect(repositoryList).toBeHidden();
  const narrowDark = testInfo.outputPath("nested-git-openbravo-narrow-dark.png");
  await page.screenshot({ animations: "disabled", path: narrowDark });

  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(rendererErrors).toEqual([]);
});

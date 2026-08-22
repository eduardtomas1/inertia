import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { selectWorkspaceTool } from "./support/workspace-tools";

const execFileAsync = promisify(execFile);
const pullRequestUrl = "https://github.com/eduardtomas1/inertia/pull/160";

const prSource = String.raw`
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const attention = existsSync(".pre-merge-state")
  && readFileSync(".pre-merge-state", "utf8").trim() === "attention";
const checks = attention ? [
  { name: "Linux x64", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE" },
  { name: "Windows x64", workflowName: "CI", status: "COMPLETED", conclusion: "SKIPPED" },
] : [
  { name: "Linux x64", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "Windows x64", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "Windows unit tests (1/2)", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "Windows unit tests (2/2)", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "macOS arm64", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
];
const payload = {
  number: 160,
  url: "${pullRequestUrl}",
  title: "Build a calm pre-merge confidence cockpit",
  state: "OPEN",
  isDraft: false,
  headRefName: "codex/pre-merge-confidence-cockpit",
  headRefOid: head,
  baseRefName: "main",
  mergeStateStatus: attention ? "BLOCKED" : "CLEAN",
  reviewDecision: attention ? "CHANGES_REQUESTED" : "APPROVED",
  updatedAt: "2026-08-22T16:00:00.000Z",
  changedFiles: 7,
  body: "## Verification\n\n- npm run check\n\nThis is author-entered PR text.",
  files: [
    { path: "src/server/git/github-pre-merge.ts", additions: 412, deletions: 0 },
    { path: "src/shared/contracts/git.ts", additions: 103, deletions: 0 },
    { path: "src/renderer/src/components/PreMergeConfidenceDialog.tsx", additions: 386, deletions: 0 },
    { path: "src/renderer/src/components/WorkspaceChangesPanel.tsx", additions: 44, deletions: 0 },
    { path: "src/renderer/src/styles.css", additions: 420, deletions: 0 },
    { path: "tests/server/github-pre-merge.test.ts", additions: 188, deletions: 0 },
    { path: "tests/renderer/pre-merge-confidence-dialog.dom.test.tsx", additions: 210, deletions: 0 }
  ],
  statusCheckRollup: checks
};
process.stdout.write(JSON.stringify(process.argv.includes("view") ? payload : [payload]));
`;

const apiSource = String.raw`
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const attention = existsSync(".pre-merge-state")
  && readFileSync(".pre-merge-state", "utf8").trim() === "attention";
if (!process.argv.includes("graphql")) {
  process.stdout.write(JSON.stringify([{
    number: 160,
    state: "open",
    head: {
      ref: "codex/pre-merge-confidence-cockpit",
      sha: head,
      repo: { full_name: "eduardtomas1/inertia" }
    },
    base: {
      ref: "main",
      repo: {
        full_name: "eduardtomas1/inertia",
        html_url: "https://github.com/eduardtomas1/inertia"
      }
    }
  }]));
  process.exit(0);
}
const nodes = attention ? [{
  id: "codex-thread-1",
  isResolved: false,
  isOutdated: false,
  path: "src/server/git/github-pre-merge.ts",
  line: 218,
  comments: { nodes: [{
    author: { login: "chatgpt-codex-connector" },
    body: "Keep the final GitHub head revalidation tied to the review-thread evidence.",
    url: "${pullRequestUrl}#discussion_r1"
  }] }
}] : [];
process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: {
  number: 160,
  headRefOid: head,
  updatedAt: "2026-08-22T16:00:00.000Z",
  reviewThreads: { nodes, pageInfo: { hasNextPage: false } }
} } } }));
`;

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "pre-merge-confidence",
    initialState: "conversation",
    githubCliSources: {
      pr: prSource,
      api: apiSource,
      excludedFiles: [".pre-merge-state"],
    },
    beforeLaunch: async ({ workspaceDirectory }) => {
      await execFileAsync("git", ["add", "sample.ts"], { cwd: workspaceDirectory });
      await execFileAsync("git", [
        "-c", "user.name=Inertia", "-c", "user.email=e2e@inertia.local",
        "commit", "-qm", "Feature head",
      ], { cwd: workspaceDirectory });
      await execFileAsync("git", [
        "branch", "-m", "codex/pre-merge-confidence-cockpit",
      ], { cwd: workspaceDirectory });
      await execFileAsync("git", [
        "remote", "add", "origin", "https://github.com/eduardtomas1/inertia.git",
      ], { cwd: workspaceDirectory });
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test("keeps exact-head green and blocking evidence legible across real Electron layouts", async ({ browserName: _browserName }, testInfo) => {
  await app.resizeWindow(1440, 920);
  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Changes");
  await page.getByRole("button", { name: "Confidence", exact: true }).click();
  const dialog = page.locator(".pre-merge-dialog");
  await expect(dialog).toHaveAttribute("data-state", "passed");
  await expect(dialog.getByRole("heading", { name: "Exact-head green" }))
    .toBeVisible();
  await expect(dialog.getByText("0 Codex · 0 other unresolved"))
    .toBeVisible();
  await expect(dialog.getByText("No authoritative bundle delta", { exact: false }))
    .toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  const wideGeometry = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      fits: element.scrollWidth <= element.clientWidth + 1,
    };
  });
  expect(wideGeometry.left).toBeGreaterThanOrEqual(0);
  expect(wideGeometry.right).toBeLessThanOrEqual(wideGeometry.viewportWidth + 1);
  expect(wideGeometry.top).toBeGreaterThanOrEqual(0);
  expect(wideGeometry.bottom).toBeLessThanOrEqual(wideGeometry.viewportHeight + 1);
  expect(wideGeometry.fits).toBe(true);
  const wideScreenshot = testInfo.outputPath("pre-merge-confidence-exact-dark-wide.png");
  await page.screenshot({ animations: "disabled", path: wideScreenshot });
  await testInfo.attach("pre-merge-confidence-exact-dark-wide", {
    path: wideScreenshot,
    contentType: "image/png",
  });

  await writeFile(join(app.workspaceDirectory, ".pre-merge-state"), "attention\n", "utf8");
  await dialog.getByRole("button", { name: "Refresh pre-merge evidence" }).click();
  await expect(dialog).toHaveAttribute("data-state", "failed");
  await expect(dialog.getByRole("heading", { name: "Needs attention" }))
    .toBeVisible();
  await expect(dialog.getByText("1 Codex · 0 other unresolved"))
    .toBeVisible();
  await expect(dialog.getByText("macOS coverage is missing."))
    .toBeVisible();

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  });
  await dialog.locator(".pre-merge-thread-list").scrollIntoViewIfNeeded();
  await expect(dialog.getByText("Keep the final GitHub head revalidation", { exact: false }))
    .toBeVisible();
  const reviewScreenshot = testInfo.outputPath("pre-merge-confidence-codex-thread-light-wide.png");
  await page.screenshot({ animations: "disabled", path: reviewScreenshot });
  await testInfo.attach("pre-merge-confidence-codex-thread-light-wide", {
    path: reviewScreenshot,
    contentType: "image/png",
  });

  await app.resizeWindow(760, 800);
  await dialog.locator(".pre-merge-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByText("Release", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Done" })).toBeVisible();
  const narrowGeometry = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      bottom: bounds.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      fits: element.scrollWidth <= element.clientWidth + 1,
    };
  });
  expect(narrowGeometry.left).toBeGreaterThanOrEqual(0);
  expect(narrowGeometry.right).toBeLessThanOrEqual(narrowGeometry.viewportWidth + 1);
  expect(narrowGeometry.bottom).toBeLessThanOrEqual(narrowGeometry.viewportHeight + 1);
  expect(narrowGeometry.fits).toBe(true);
  await app.expectNoViewportOverflow();
  const narrowScreenshot = testInfo.outputPath("pre-merge-confidence-blocked-light-narrow.png");
  await page.screenshot({ animations: "disabled", path: narrowScreenshot });
  await testInfo.attach("pre-merge-confidence-blocked-light-narrow", {
    path: narrowScreenshot,
    contentType: "image/png",
  });
  expect(app.rendererErrors).toEqual([]);
});

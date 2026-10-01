// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import type { LinkedPullRequest, PullRequestSnapshot, PullRequestStack, StackOperation, StackReview } from "../../src/shared/pull-requests";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { prSha, prSnapshot, prStack } from "../support/pull-request-fixtures";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

interface Remote {
  repository: string;
  number: number;
  snapshot: PullRequestSnapshot;
  stack: PullRequestStack | null;
  refused?: boolean;
}

const LONG_TITLE = "Reconcile invoice exports with the ledger when a customer changes currency mid-cycle";

function snapshot(number: number, update: Partial<PullRequestSnapshot>): PullRequestSnapshot {
  return { ...prSnapshot(number), head: prSha(number), base: prSha(number - 1), ...update };
}

function stack(id: string, number: number, base: string, layers: Remote[]): PullRequestStack {
  return { id, number, base, layers: layers.map((layer) => ({ number: layer.number, headBranch: layer.snapshot.headBranch,
    head: prSha(layer.number), state: layer.snapshot.state, draft: layer.snapshot.draft })) };
}

function linkedRemotes(): Remote[] {
  const api7: Remote = { repository: "acme/api", number: 7, stack: null, snapshot: snapshot(7, {
    title: "Split the session API into read and write routes", headBranch: "api/session-routes", baseBranch: "main",
    additions: 412, deletions: 96, author: "mara", mergeState: "BLOCKED",
    checks: { total: 14, passed: 12, pending: 1, failed: 1, complete: true } }) };
  const api8: Remote = { repository: "acme/api", number: 8, stack: null, snapshot: snapshot(8, {
    title: "Rate limit session writes per workspace", headBranch: "api/session-limits", baseBranch: "api/session-routes",
    additions: 138, deletions: 12, author: "mara", mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", unresolvedReviews: 2,
    checks: { total: 14, passed: 14, pending: 0, failed: 0, complete: true } }) };
  const apiStack = stack("stack-api", 12, "main", [api7, api8]);
  api7.stack = apiStack;
  api8.stack = apiStack;
  return [
    { repository: "acme/workspace", number: 41, snapshot: prSnapshot(41), stack: prStack() },
    { repository: "acme/workspace", number: 42, snapshot: prSnapshot(42), stack: prStack() },
    { repository: "acme/docs", number: 18, stack: null, snapshot: snapshot(18, {
      title: "Document the pull request workflow", headBranch: "docs/pull-requests", baseBranch: "main", additions: 86, deletions: 4,
      author: "mara", mergeState: "BLOCKED", reviewDecision: "CHANGES_REQUESTED", unresolvedReviews: 1,
      checks: { total: 9, passed: 9, pending: 0, failed: 0, complete: true } }) },
    { repository: "acme/docs", number: 22, stack: null, snapshot: snapshot(22, {
      title: "Draft the stack troubleshooting guide", draft: true, headBranch: "docs/stack-troubleshooting", baseBranch: "main",
      additions: 41, deletions: 0, reviewDecision: null, mergeState: "DRAFT", checks: { total: 0, passed: 0, pending: 0, failed: 0, complete: true } }) },
    { repository: "acme/workspace", number: 9, stack: null, snapshot: snapshot(9, {
      title: "Refine workspace shortcuts", state: "merged", headBranch: "feat/shortcuts", baseBranch: "main", additions: 32, deletions: 17 }) },
    { repository: "acme/billing", number: 57, stack: null, refused: true, snapshot: snapshot(57, {
      title: LONG_TITLE, headBranch: "billing/currency-change-reconciliation", baseBranch: "main", additions: 1284, deletions: 377 }) },
    api7,
    api8,
  ];
}

function actionRemotes(): Remote[] {
  const web30: Remote = { repository: "acme/web", number: 30, stack: null, snapshot: snapshot(30, {
    title: "Move settings into a split view", headBranch: "web/settings-split", baseBranch: "main", additions: 220, deletions: 64 }) };
  const web31: Remote = { repository: "acme/web", number: 31, stack: null, snapshot: snapshot(31, {
    title: "Remember the last settings section", headBranch: "web/settings-memory", baseBranch: "web/settings-split", additions: 58, deletions: 9 }) };
  const web40: Remote = { repository: "acme/web", number: 40, stack: null, snapshot: snapshot(40, {
    title: "Ship the keyboard shortcut sheet", headBranch: "web/shortcut-sheet", baseBranch: "main", additions: 97, deletions: 21 }) };
  const settings = stack("stack-web-settings", 30, "main", [web30, web31]);
  web30.stack = settings;
  web31.stack = settings;
  web40.stack = stack("stack-web-shortcuts", 41, "main", [web40]);
  return [web30, web31, web40];
}

function ghSource(remotes: Remote[]): string {
  return `
const remotes = ${JSON.stringify(remotes)};
const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const endpoint = args.find((value) => value === "graphql" || value.startsWith("repos/"));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const body = input ? JSON.parse(input) : {};
  const reply = (status, value) => process.stdout.write("HTTP/2.0 " + status + " Fixture\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(value));
  const find = (repository, number) => remotes.find((remote) => remote.repository === repository && remote.number === number);
  const raw = (stack, detail) => ({ id: stack.id, number: stack.number, base: stack.base, pull_requests: stack.layers.map((layer) => ({
    number: layer.number, head: { ref: layer.headBranch, ...(detail ? { sha: layer.head } : {}) },
    state: layer.state === "merged" ? "closed" : layer.state, merged_at: layer.state === "merged" ? "2026-10-01T12:00:00Z" : null, draft: layer.draft })) });
  if (endpoint === "graphql") {
    if (/mutation/u.test(body.query) || !body.variables || body.variables.ids) process.exit(1);
    const repository = body.variables.owner + "/" + body.variables.name;
    const remote = find(repository, body.variables.number);
    if (!remote || remote.refused) return reply(403, { message: "Forbidden" });
    const pr = remote.snapshot;
    const contexts = [
      ...Array(pr.checks.passed).fill({ __typename: "StatusContext", state: "SUCCESS" }),
      ...Array(pr.checks.pending).fill({ __typename: "StatusContext", state: "PENDING" }),
      ...Array(pr.checks.failed).fill({ __typename: "StatusContext", state: "FAILURE" }),
    ];
    return reply(200, { data: { repository: { pullRequest: {
      id: "PR_" + remote.number, number: remote.number, title: pr.title, state: pr.state.toUpperCase(), isDraft: pr.draft,
      headRefName: pr.headBranch, headRefOid: pr.head, baseRefName: pr.baseBranch, baseRefOid: pr.base,
      additions: pr.additions, deletions: pr.deletions, updatedAt: pr.updatedAt, author: { login: pr.author },
      mergeStateStatus: pr.mergeState, reviewDecision: pr.reviewDecision, maintainerCanModify: false,
      headRepository: { viewerPermission: pr.canUpdateBranch ? "WRITE" : "READ" }, repository: { nameWithOwner: repository, viewerPermission: "WRITE" },
      commits: { nodes: [{ commit: { oid: pr.head, statusCheckRollup: contexts.length ? { contexts: { totalCount: contexts.length, pageInfo: { hasNextPage: false }, nodes: contexts } } : null } }] },
      reviewThreads: { totalCount: pr.unresolvedReviews, pageInfo: { hasNextPage: false }, nodes: Array(pr.unresolvedReviews).fill({ isResolved: false }) },
    } } } });
  }
  if (method !== "GET" || !endpoint) process.exit(1);
  const match = /^repos\\/([^/]+\\/[^/]+)\\/(?:stacks\\?pull_request=(\\d+)|stacks\\/(\\d+)|pulls\\/\\d+\\/merge-async\\/([\\w-]+))$/u.exec(endpoint);
  if (!match) process.exit(1);
  const [, repository, member, stackNumber, uuid] = match;
  if (uuid) return reply(200, { status: "pending", details: { uuid } });
  if (member) {
    const remote = find(repository, Number(member));
    if (!remote || remote.refused) return reply(403, { message: "Forbidden" });
    return reply(200, remote.stack ? [raw(remote.stack, false)] : []);
  }
  const owner = remotes.find((remote) => remote.repository === repository && remote.stack && remote.stack.number === Number(stackNumber));
  return owner ? reply(200, raw(owner.stack, true)) : reply(404, { message: "Not Found" });
});`;
}

function link(remote: Remote, syncError: string | null = null): LinkedPullRequest {
  return { host: "github.com", repository: remote.repository, number: remote.number, source: "manual",
    linkedAt: "2026-10-01T12:00:00.000Z", snapshot: remote.snapshot, stack: remote.stack, syncError };
}

function seedOperation(store: RuntimeStore, conversationId: string, remotes: Remote[], target: Remote,
  operation: Pick<StackOperation, "action" | "state" | "completedLayers" | "message">, uuid: string | null = null): void {
  const reviewed = target.stack!;
  const review: StackReview = { id: randomUUID(), conversationId, key: { host: "github.com", repository: target.repository, number: target.number },
    action: operation.action, stack: reviewed, expiresAt: new Date(Date.now() + 300_000).toISOString(), blockers: [],
    layers: reviewed.layers.map((layer) => ({ number: layer.number, snapshot: remotes.find((remote) => remote.number === layer.number)!.snapshot })) };
  store.pullRequests.prepare(review);
  if (!store.pullRequests.claim(review)) throw new Error("The stack operation fixture could not be claimed.");
  store.pullRequests.settle(conversationId, { id: review.id, key: review.key, stackNumber: reviewed.number,
    updatedAt: "2026-10-01T12:00:00.000Z", ...operation }, uuid);
}

async function launch(name: string, title: string, remotes: Remote[],
  seed: (store: RuntimeStore, conversationId: string) => void): Promise<AppFixture> {
  return await createAppFixture({ name, initialState: "conversation", workspaceGit: false,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      writeNodeFlagExecutable(join(testDirectory, "provider-bin"), "gh", ghSource(remotes));
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const chat = store.snapshot().conversations[0]!;
        store.updateConversation(chat.id, { title });
        store.updateSettings({ theme: "dark" });
        seed(store, chat.id);
      } finally { store.close(); }
    },
  });
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function expectLayoutHolds(app: AppFixture, region: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  await expectComposerEndsAtDock(app.page.getByRole("region", { name: "Message composer" }));
  const layout = await region.evaluate((element) => {
    const scrolls = element.querySelectorAll<HTMLElement>(".workspace-surface-scroll");
    const scroll = scrolls[0];
    const box = element.getBoundingClientRect();
    return {
      scrolls: scrolls.length,
      overflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
      escaped: [...element.querySelectorAll<HTMLElement>("button, h3, p")]
        .filter((child) => child.getClientRects().length > 0 && child.getBoundingClientRect().right > box.right + 1).length,
      nested: [...element.querySelectorAll("button")].filter((button) => button.parentElement?.closest("button")).length,
      truncatedTitles: [...element.querySelectorAll<HTMLElement>(".pr-row-title, .pr-detail-title")]
        .filter((title) => title.scrollWidth > title.clientWidth + 1).length,
    };
  });
  expect(layout.scrolls).toBe(1);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.escaped).toBe(0);
  expect(layout.nested).toBe(0);
  expect(layout.truncatedTitles).toBe(0);
}

async function openSurface(app: AppFixture): Promise<Locator> {
  await selectWorkspaceTool(await ensureWorkspaceTools(app.page), "Pull requests");
  const region = app.page.getByRole("region", { name: "Linked pull requests" });
  await expect(region).toBeVisible();
  return region;
}

async function theme(app: AppFixture, value: "light" | "dark"): Promise<void> {
  await setAppearanceInPlace(app, value);
  await expect(app.page.locator("html")).toHaveAttribute("data-theme", value);
}

test.describe.configure({ timeout: 180_000 });

test("captures the empty surface, the link form and a failed link", async ({ browserName: _browserName }, info) => {
  const app = await launch("pull-requests-empty", "Plan the release notes", [], () => undefined);
  try {
    const { page } = app;
    await page.clock.setFixedTime(Date.now());
    await app.resizeWindow(1440, 920);
    const region = await openSurface(app);
    await expect(region.getByText("No pull requests are linked to this chat.")).toBeVisible();
    await expect(region.getByRole("button", { name: "Refresh linked pull requests" })).toHaveCount(0);
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-empty-dark-wide");
    await theme(app, "light");
    await capture(page, info, "pull-requests-empty-light-wide");
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-empty-light-narrow");
    await theme(app, "dark");
    await capture(page, info, "pull-requests-empty-dark-narrow");
    await app.resizeWindow(760, 600);
    await expect(region).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-empty-dark-760x600");
    await app.resizeWindow(1440, 920);

    const opener = region.getByRole("button", { name: "Link pull request", exact: true });
    await opener.click();
    const input = region.getByRole("textbox", { name: "GitHub pull request URL" });
    await expect(input).toBeFocused();
    await region.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(input).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await input.fill("https://github.com/acme/workspace/issues/3");
    await blur(page);
    await capture(page, info, "pull-requests-link-form-dark-wide");
    await region.getByRole("button", { name: "Link", exact: true }).click();
    await expect(region.getByRole("alert")).toContainText("Enter a GitHub pull request URL");
    await expect(input).toHaveValue("https://github.com/acme/workspace/issues/3");
    await expectLayoutHolds(app, region);
    await blur(page);
    await capture(page, info, "pull-requests-link-error-dark-wide");
    await theme(app, "light");
    await capture(page, info, "pull-requests-link-error-light-wide");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

test("captures linked pull requests, a detail, the stack menu and stack reviews", async ({ browserName: _browserName }, info) => {
  const remotes = linkedRemotes();
  const app = await launch("pull-requests-linked", "Connect related work", remotes, (store, conversationId) => {
    for (const remote of remotes) {
      store.pullRequests.save(conversationId, link(remote, remote.refused
        ? "GitHub access was refused. Check the signed-in gh account and repository permissions." : null));
    }
  });
  try {
    const { page } = app;
    await page.clock.setFixedTime(Date.now());
    await app.resizeWindow(1440, 920);
    const region = await openSurface(app);
    const rows = region.getByRole("list", { name: /^Linked/u }).getByRole("listitem");
    await expect(rows).toHaveCount(8);
    await expect(region.getByRole("button", { name: /Refine workspace shortcuts/u })).toContainText("Merged");
    await expect(region.getByRole("button", { name: /Draft the stack troubleshooting guide/u })).toContainText("Draft");
    await expect(region.getByRole("button", { name: /Reconcile invoice exports/u })).toContainText("Sync unavailable");
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-list-dark-wide");
    await theme(app, "light");
    await capture(page, info, "pull-requests-list-light-wide");
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-list-light-narrow");
    await theme(app, "dark");
    await capture(page, info, "pull-requests-list-dark-narrow");
    await app.resizeWindow(760, 600);
    await expect(region).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-list-dark-760x600");
    await app.resizeWindow(1440, 920);

    const row = region.getByRole("button", { name: /Keep related pull requests together/u });
    await row.click();
    const back = region.getByRole("button", { name: "Back to linked pull requests" });
    await expect(back).toBeFocused();
    await expect(region.getByRole("heading", { name: "Keep related pull requests together" })).toBeVisible();
    await expect(region.getByText("12 of 12 checks passing")).toBeVisible();
    await expectLayoutHolds(app, region);
    await blur(page);
    await capture(page, info, "pull-requests-detail-dark-wide");
    await theme(app, "light");
    await capture(page, info, "pull-requests-detail-light-wide");
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-detail-light-narrow");
    await theme(app, "dark");
    await capture(page, info, "pull-requests-detail-dark-narrow");
    await app.resizeWindow(1440, 920);

    const trigger = region.getByRole("button", { name: "Stack #43 · layer 2 of 2" });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Stack #43" });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    const merge = menu.getByRole("menuitem", { name: /^Merge 2 layers…/u });
    await expect(merge).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Rebase stack…/u })).toBeVisible();
    const bounds = (await menu.boundingBox())!, panel = (await region.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(panel.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(panel.x + panel.width);
    const title = (await region.getByRole("heading", { name: "Keep related pull requests together" }).boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(title.y + title.height);
    await capture(page, info, "pull-requests-stack-menu-dark-wide");
    await theme(app, "light");
    await capture(page, info, "pull-requests-stack-menu-light-wide");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();

    await trigger.click();
    await merge.click();
    const dialog = page.getByRole("dialog", { name: "Merge stack #43" });
    await expect(dialog).toBeVisible();
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    await expect(dialog.getByRole("list", { name: "Layers to merge" }).getByRole("listitem")).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Merge 2 layers", exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await capture(page, info, "pull-requests-merge-review-light-wide");
    await theme(app, "dark");
    await capture(page, info, "pull-requests-merge-review-dark-wide");
    await app.resizeWindow(760, 600);
    await capture(page, info, "pull-requests-merge-review-dark-760x600");
    await app.resizeWindow(1440, 920);
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await menu.getByRole("menuitem", { name: /^Rebase stack…/u }).click();
    const rebase = page.getByRole("dialog", { name: "Rebase stack #43" });
    await expect(rebase.getByRole("button", { name: "Rebase 2 layers", exact: true })).toBeVisible();
    await capture(page, info, "pull-requests-rebase-review-dark-wide");
    await page.keyboard.press("Escape");
    await expect(rebase).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await back.click();
    await expect(row).toBeFocused();

    const api = region.getByRole("button", { name: /Rate limit session writes per workspace/u });
    await api.click();
    await expect(region.getByText("2 unresolved")).toBeVisible();
    const apiTrigger = region.getByRole("button", { name: "Stack #12 · layer 2 of 2" });
    await apiTrigger.click();
    await page.getByRole("menu", { name: "Stack #12" }).getByRole("menuitem", { name: /^Merge 2 layers…/u }).click();
    const blocked = page.getByRole("dialog", { name: "Merge stack #12" });
    await expect(blocked.getByRole("list", { name: "Stack blockers" })).toContainText("#7 has pending or unsuccessful checks.");
    await expect(blocked.getByRole("button", { name: "Merge 2 layers", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.mouse.move(0, 0);
    await capture(page, info, "pull-requests-merge-blocked-dark-wide");
    await theme(app, "light");
    await capture(page, info, "pull-requests-merge-blocked-light-wide");
    await blocked.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(apiTrigger).toBeFocused();
    await back.click();
    await expect(api).toBeFocused();

    const billing = region.getByRole("button", { name: /Reconcile invoice exports/u });
    await billing.click();
    await expect(region.getByRole("heading", { name: LONG_TITLE })).toBeVisible();
    await expect(region.getByText("GitHub access was refused.", { exact: false })).toBeVisible();
    await expectLayoutHolds(app, region);
    await blur(page);
    await capture(page, info, "pull-requests-sync-error-light-wide");
    await app.resizeWindow(760, 600);
    await expectLayoutHolds(app, region);
    await theme(app, "dark");
    await capture(page, info, "pull-requests-sync-error-dark-760x600");
    await app.resizeWindow(1440, 920);
    await back.click();
    await expect(billing).toBeFocused();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

test("captures in-progress, blocked, unknown and failed stack actions", async ({ browserName: _browserName }, info) => {
  const remotes = actionRemotes();
  const [, web31, web40] = remotes as [Remote, Remote, Remote];
  const app = await launch("pull-requests-actions", "Ship the settings stack", remotes, (store, conversationId) => {
    for (const remote of remotes) store.pullRequests.save(conversationId, link(remote));
    seedOperation(store, conversationId, remotes, web31, { action: "merge", state: "failed", completedLayers: 0,
      message: "GitHub refused the stack merge. Check its branch rules and merge requirements." });
    seedOperation(store, conversationId, remotes, web31, { action: "rebase", state: "unknown", completedLayers: 1,
      message: "GitHub did not confirm the outcome. Refresh or check GitHub before making further changes." });
    seedOperation(store, conversationId, remotes, web40, { action: "merge", state: "pending", completedLayers: 0,
      message: "GitHub is merging the stack. Refresh to check its outcome." }, "fixture-merge");
  });
  try {
    const { page } = app;
    await page.clock.setFixedTime(Date.now());
    await app.resizeWindow(1440, 920);
    const region = await openSurface(app);
    const actions = region.getByRole("list", { name: "Stack actions" }).getByRole("listitem");
    await expect(actions).toHaveCount(3);
    await expect(actions.nth(0)).toContainText("Merge in progress");
    await expect(actions.nth(1)).toContainText("Rebase outcome unknown");
    await expect(actions.nth(2)).toContainText("Merge failed");
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-actions-dark-wide");
    await theme(app, "light");
    await capture(page, info, "pull-requests-actions-light-wide");
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-actions-light-narrow");
    await app.resizeWindow(1440, 920);

    await region.getByRole("button", { name: new RegExp(web31.snapshot.title, "u") }).click();
    await expect(region.getByRole("list", { name: "Stack actions" }).getByRole("listitem")).toHaveCount(2);
    const trigger = region.getByRole("button", { name: "Stack #30 · layer 2 of 2" });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Stack #30" });
    const merge = menu.getByRole("menuitem", { name: /^Merge 2 layers…/u });
    await expect(merge).toHaveAttribute("aria-disabled", "true");
    await expect(merge).toContainText("Check the last stack action first.");
    await merge.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectLayoutHolds(app, region);
    await capture(page, info, "pull-requests-actions-blocked-light-wide");
    await theme(app, "dark");
    await capture(page, info, "pull-requests-actions-blocked-dark-wide");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(region.getByRole("button", { name: "Unlink from chat" })).toHaveAttribute("aria-disabled", "true");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

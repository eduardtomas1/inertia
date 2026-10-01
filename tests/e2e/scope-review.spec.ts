// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

// Deterministic provider boundary fixture. The real runtime constructs the
// prompt, validates every mapping, persists the result and refreshes the UI.
const providerSource = (release: string): string => `
const readline = require("node:readline");
const { existsSync } = require("node:fs");
const release = ${JSON.stringify(release)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv[2] === "--version") { process.stdout.write("codex-cli 0.200.0\\n"); process.exit(0); }
if (process.argv[2] === "login") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
if (process.argv.includes("--help")) { process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n"); process.exit(0); }
const threadId = "scope-review-fixture";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ id: message.id, result });
  if (message.method === "initialize") return reply({ userAgent: "scope-review-fixture" });
  if (message.method === "model/list") return reply({ data: [], nextCursor: null });
  if (message.method === "account/rateLimits/read") return reply({ rateLimits: null, rateLimitsByLimitId: null });
  if (message.method === "thread/goal/get") return reply({ goal: null });
  if (["thread/start", "thread/resume"].includes(message.method)) return reply({ thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null });
  if (message.method !== "turn/start") return;
  const prompt = message.params.input.filter((item) => item.type === "text").map((item) => item.text).join("\\n");
  const inventory = JSON.parse(prompt.split("Required inventory: ")[1].split("\\n")[0]);
  const brief = JSON.parse(prompt.split("Review brief: ")[1].split("\\n")[0]);
  const requirements = brief.requirements.map((_, requirementIndex) => ({ requirementIndex, evidence: [] }));
  const unexplained = [];
  const files = inventory.map((file) => {
    for (const hunk of file.hunks) {
      const target = { path: file.path, hunkId: hunk.hunkId, confidence: "medium", reason: "" };
      if (file.path === "retry.ts") requirements[0].evidence.push({ ...target, kind: "implementation", reason: "The retry limit increases from one attempt to three." });
      else if (file.path === "retry.test.ts") requirements[1].evidence.push({ ...target, kind: "test", reason: "An assertion covers the retry limit. Its execution result is unknown." });
      else unexplained.push({ ...target, reason: "Disabling authentication has no clear connection to retry handling." });
    }
    return { path: file.path, summary: "Changes visible in the complete diff.", classifications: [], hunks: file.hunks.map((hunk) => ({ hunkId: hunk.hunkId, summary: "Changed behavior.", classifications: [] })) };
  });
  const output = JSON.stringify({ overall: "Retry handling and its test were updated." + (unexplained.length ? " An authentication edit needs explanation." : ""), classifications: [], files, scopeReview: { requirements, unexplained } });
  const turn = { id: "scope-turn", status: "inProgress", items: [], error: null };
  reply({ turn });
  send({ method: "turn/started", params: { threadId, turn } });
  const finish = () => {
    if (!existsSync(release)) return setTimeout(finish, 50);
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta: output } });
    send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
  };
  finish();
});
`;

const FIXED_NOW = Date.parse("2026-09-30T16:20:00.000Z");
type Variant = readonly ["light" | "dark", number, number, string];
const WIDE_LIGHT: Variant = ["light", 1440, 1100, "light-wide"];
const WIDE_DARK: Variant = ["dark", 1440, 1100, "dark-wide"];
const NARROW_LIGHT: Variant = ["light", 1000, 800, "light-narrow"];
const NARROW_DARK: Variant = ["dark", 1000, 800, "dark-narrow"];
const TIGHT_DARK: Variant = ["dark", 760, 600, "dark-760x600"];

let app: AppFixture;
test.afterEach(async () => { await app?.close(); });

async function expectLayoutHolds(region: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  await expectComposerEndsAtDock(app.page.getByRole("region", { name: "Message composer" }));
  const layout = await region.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const panel = element.closest(".changes-panel")?.getBoundingClientRect().height ?? 0;
    return {
      share: bounds.height / panel,
      overflow: element.scrollWidth - element.clientWidth,
      escaping: [...element.querySelectorAll<HTMLElement>("*")]
        .filter((child) => child.getBoundingClientRect().right > bounds.right + 1).length,
      nested: [...element.querySelectorAll("button")]
        .filter((button) => button.parentElement?.closest("button")).length,
    };
  });
  expect(layout.share).toBeLessThanOrEqual(0.41);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.escaping).toBe(0);
  expect(layout.nested).toBe(0);
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function captureStates(
  info: TestInfo,
  region: Locator,
  name: string,
  variants: readonly Variant[],
  prepare: () => Promise<void> = async () => undefined,
): Promise<void> {
  const page = app.page;
  for (const [theme, width, height, label] of variants) {
    await app.resizeWindow(width, height);
    await setAppearanceInPlace(app, theme);
    await expect(region).toBeVisible();
    await expect(page.locator(".diff-code")).toHaveCount(1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await prepare();
    await expectLayoutHolds(region);
    await capture(page, info, `scope-review-${name}-${label}`);
  }
  await app.resizeWindow(1440, 1100);
}

test.slow();
test("reviews the brief, drafts an unexpected-change request, and refreshes after correction", async ({ browserName: _browserName }, testInfo) => {
  const providerEnvironment: Record<string, string> = {};
  let release = "";
  app = await createAppFixture({ name: "scope-review", initialState: "conversation", additionalEnvironment: providerEnvironment,
    beforeLaunch: async ({ workspaceDirectory, testDirectory }) => {
      release = join(testDirectory, "release-review");
      providerEnvironment.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED = writeNodeFlagExecutable(
        join(testDirectory, "provider-bin"), "codex", providerSource(release),
      );
      await writeFile(join(workspaceDirectory, "retry.ts"), "export const maxAttempts = 1;\n");
      await writeFile(join(workspaceDirectory, "retry.test.ts"), "expect(maxAttempts).toBe(1);\n");
      await writeFile(join(workspaceDirectory, "auth.ts"), "export const authenticationRequired = true;\n");
      execFileSync("git", ["add", "."], { cwd: workspaceDirectory });
      execFileSync("git", ["commit", "-m", "Seed review baseline"], { cwd: workspaceDirectory, env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Inertia",
        GIT_AUTHOR_EMAIL: "test@inertia.local",
        GIT_COMMITTER_NAME: "Inertia",
        GIT_COMMITTER_EMAIL: "test@inertia.local",
      } });
      await writeFile(join(workspaceDirectory, "retry.ts"), "export const maxAttempts = 3;\n");
      await writeFile(join(workspaceDirectory, "retry.test.ts"), "expect(maxAttempts).toBe(3);\n");
      await writeFile(join(workspaceDirectory, "auth.ts"), "export const authenticationRequired = false;\n");
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try { store.createMessage(store.snapshot().activeConversationId!, "Add retry handling, capped at three attempts, and test the retry limit. Stop retrying when cancelled; keep other behavior unchanged.", "user"); }
      finally { store.close(); }
    } });
  const { page } = app;
  await page.clock.setFixedTime(FIXED_NOW);
  await app.resizeWindow(1440, 1100);
  await ensureWorkspaceTools(page);
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Changes");
  const toggle = page.getByRole("button", { name: "Review against request", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const review = page.getByRole("region", { name: "Review against request", exact: true });
  const requirements = review.getByRole("textbox", { name: /Requirements/ });
  await expect(requirements).toBeVisible();
  await captureStates(testInfo, review, "brief-empty", [WIDE_LIGHT, WIDE_DARK, NARROW_DARK]);

  await requirements.fill(Array.from({ length: 21 }, (_, index) => `Requirement ${index + 1}`).join("\n"));
  const save = review.getByRole("button", { name: "Save brief", exact: true });
  await save.click();
  await expect(review.getByRole("alert")).toHaveText("Use up to 20 requirements, each at most 800 characters.");
  await captureStates(testInfo, review, "brief-error", [WIDE_LIGHT, WIDE_DARK], async () => {
    await save.scrollIntoViewIfNeeded();
  });

  await requirements.fill("Retry temporary failures up to three times.\nAdd a test covering the retry limit.\nStop retrying when the request is cancelled.");
  await review.getByLabel("Link a user message").selectOption({ index: 1 });
  await captureStates(testInfo, review, "brief-editing", [WIDE_LIGHT, WIDE_DARK, NARROW_DARK]);

  await save.click();
  const start = review.getByRole("button", { name: "Review request", exact: true });
  await expect(start).toBeVisible();
  await captureStates(testInfo, review, "brief-saved", [WIDE_LIGHT, WIDE_DARK]);

  await start.click();
  await expect(review.getByRole("button", { name: "Reviewing…", exact: true })).toBeVisible();
  await captureStates(testInfo, review, "generating", [WIDE_LIGHT, WIDE_DARK]);
  await writeFile(release, "");

  await expect(review.getByText("The retry limit increases from one attempt to three.")).toBeVisible();
  await expect(review.getByText("Disabling authentication has no clear connection to retry handling.")).toBeVisible();
  await expect(review.getByText(/Test changes do not mean tests ran or passed/)).toBeVisible();
  await expect(review.getByText("No visible implementation or test evidence")).toBeVisible();
  const toTop = async () => { await review.evaluate((element) => { element.scrollTop = 0; }); };
  await captureStates(testInfo, review, "results", [WIDE_LIGHT, WIDE_DARK, NARROW_LIGHT, NARROW_DARK, TIGHT_DARK], toTop);

  await review.locator(".scope-review-unexplained").getByRole("button", { name: "Draft request" }).click();
  const request = review.getByRole("textbox", { name: "Edit request to agent" });
  await expect(request).toBeFocused();
  await request.fill("Keep authentication unchanged. Remove this unrelated change and explain the retry behavior.");
  const add = review.getByRole("button", { name: "Add request to prompt" });
  const showDraft = async () => { await add.scrollIntoViewIfNeeded(); };
  await captureStates(testInfo, review, "draft", [WIDE_LIGHT, WIDE_DARK, NARROW_DARK], showDraft);
  await add.click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toContainText("Keep authentication unchanged");

  await review.getByRole("button", { name: "Draft request" }).first().click();
  await expect(request).toBeFocused();
  await writeFile(join(app.workspaceDirectory, "auth.ts"), "export const authenticationRequired = true;\n");
  await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
  await expect(review.getByText("Disabling authentication has no clear connection to retry handling.")).toHaveCount(0);
  await expect(review.getByText(/The brief or diff changed/)).toBeVisible();
  await captureStates(testInfo, review, "stale", [WIDE_LIGHT, WIDE_DARK], showDraft);
  await review.getByRole("button", { name: "Dismiss request", exact: true }).click();
  await expect(request).toHaveCount(0);

  await review.getByRole("button", { name: "Review request", exact: true }).click();
  await expect(review.getByText("No unconnected changes were identified by this review.")).toBeVisible();
  await captureStates(testInfo, review, "refreshed", [WIDE_LIGHT, WIDE_DARK], toTop);

  await app.resizeWindow(900, 800);
  await app.expectNoViewportOverflow();
  expect(app.rendererErrors).toEqual([]);
});


// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { queuedRouteIdentity } from "../../src/server/persistence/queued-message-repository";
import type { Conversation } from "../../src/shared/contracts";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import { focusAppWindow } from "./support/window-focus";

const HOUR = 3_600_000;
const FIXED_NOW = Math.floor(Date.now() / HOUR) * HOUR;
const RESETS_AT = FIXED_NOW + 4 * HOUR;
const MOVED_RESET = RESETS_AT + HOUR;
const BLOCKED_ERROR = "The account changed or could not be checked. Resume this chat manually.";

interface Seed {
  offer: { conversationId: string; title: string };
  blocked: { conversationId: string; title: string };
}

function fakeCodex(statePath: string): string {
  return `
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 999.0.0"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("Usage: codex app-server [OPTIONS] - Run the app server"); process.exit(0); }
if (process.argv.includes("login")) { console.log("Logged in using ChatGPT"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "limit-reset-appearance" } });
  if (message.method === "model/list") send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" } } });
  if (message.method === "config/read") send({ id: message.id, result: { config: { cli_auth_credentials_store: "file" } } });
  if (message.method === "thread/goal/get") send({ id: message.id, result: { goal: null } });
  if (message.method === "account/rateLimits/read") {
    const { resetsAt } = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
    send({ id: message.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetsAt / 1000 } } } });
  }
});`;
}

function failTurn(store: RuntimeStore, conversation: Conversation, content: string): string {
  const requestedAt = new Date(FIXED_NOW - 6 * 60_000).toISOString();
  const failedAt = new Date(FIXED_NOW - 5 * 60_000).toISOString();
  const run = store.createWorkspaceRun({ kind: "agent", projectId: conversation.projectId, conversationId: conversation.id,
    label: conversation.title, detail: null, status: "running", port: null });
  const turn = store.beginAgentTurn({ conversationId: conversation.id, runId: run.id, content,
    providerId: conversation.providerId, modelSelection: conversation.modelSelection, model: "gpt-test",
    reasoningEffort: conversation.reasoningEffort, accessMode: conversation.accessMode, interactionMode: conversation.interactionMode,
    configurationRevision: 0, association: "authoritative", requestedAt }).turn;
  store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
  store.updateAgentTurnLifecycle(turn.id, { status: "failed", terminalReason: "provider-error", completedAt: failedAt, updatedAt: failedAt });
  store.updateWorkspaceRun(run.id, { status: "failed", finishedAt: failedAt });
  store.updateConversation(conversation.id, { status: "failed" });
  store.createTurnGitArtifact({ turnId: turn.id, status: "unavailable", completeness: "unavailable",
    failureReason: "This workspace is not a Git repository.", absenceReason: "not-repository" });
  return turn.id;
}

function openStore(app: AppFixture): RuntimeStore {
  return new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
}

async function showChat(app: AppFixture, chat: Seed["offer"]): Promise<Locator> {
  const store = openStore(app);
  try {
    store.selectConversation(chat.conversationId);
  } finally {
    store.close();
  }
  await app.page.reload();
  await focusAppWindow(app.electronApp, app.page);
  await expect(app.page.getByRole("heading", { name: chat.title, level: 1 })).toBeVisible();
  return limitRow(app.page);
}

function limitRow(page: Page): Locator {
  return page.getByRole("region", { name: "Message composer" }).getByRole("group", { name: "Usage limit" });
}

async function dismissQuotaNotice(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Dismiss Codex 5-hour quota notice", exact: true });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  await expect(dismiss).toHaveCount(0);
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectLayoutHolds(app: AppFixture, row: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  const composer = app.page.getByRole("region", { name: "Message composer" });
  await expectComposerEndsAtDock(composer);
  const layout = await row.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const dock = element.closest(".composer")!.getBoundingClientRect();
    const buttons = [...element.querySelectorAll("button")];
    return {
      inside: bounds.left >= dock.left - 0.5 && bounds.right <= dock.right + 0.5 && bounds.top >= dock.top,
      overflow: element.scrollWidth - element.clientWidth,
      nested: buttons.filter((button) => button.parentElement?.closest("button")).length,
      clipped: buttons.filter((button) => button.scrollWidth > button.clientWidth + 1).length,
    };
  });
  expect(layout.inside).toBe(true);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.nested).toBe(0);
  expect(layout.clipped).toBe(0);
}

let app!: AppFixture;
let seed!: Seed;
let statePath = "";

test.beforeAll(async () => {
  const environment: Record<string, string> = { OPENAI_API_KEY: "", CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "" };
  const seeded: Partial<Seed> = {};
  app = await createAppFixture({ name: "limit-reset-appearance", initialState: "conversation", workspaceGit: false,
    additionalEnvironment: environment,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const home = join(testDirectory, "codex-home");
      mkdirSync(home, { recursive: true });
      environment.CODEX_HOME = home;
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "fixture-subscription-account" } }));
      writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      statePath = join(testDirectory, "reset-state.json");
      writeFileSync(statePath, JSON.stringify({ resetsAt: RESETS_AT }));
      const binary = writeNodeFlagExecutable(join(testDirectory, "provider-bin"), "codex", fakeCodex(statePath));
      environment.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED = binary;
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const first = store.snapshot().conversations[0]!;
        store.updateConversation(first.id, { title: "Tidy release notes" });
        const blockedTurn = failTurn(store, store.conversation(first.id), "Group the release notes by surface and drop internal-only entries.");
        store.limitResets.save({ id: randomUUID(), conversationId: first.id, failedTurnId: blockedTurn,
          routeIdentity: queuedRouteIdentity(store.conversation(first.id)), accountIdentity: "fixture-previous-account",
          resetsAt: new Date(RESETS_AT).toISOString(), nextAttemptAt: new Date(RESETS_AT).toISOString(), attempts: 1,
          state: "blocked", error: BLOCKED_ERROR, turnId: null });
        seeded.blocked = { conversationId: first.id, title: "Tidy release notes" };
        const second = store.createConversation(first.projectId, "Add search filters", { providerId: first.providerId });
        failTurn(store, store.conversation(second.id), "Add filters for project and status, and keep the search results easy to scan.");
        seeded.offer = { conversationId: second.id, title: "Add search filters" };
        store.updateSettings({ theme: "dark", codexBinaryPath: binary });
      } finally {
        store.close();
      }
    },
  });
  seed = seeded as Seed;
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app?.close();
});

async function attachFailure(info: TestInfo): Promise<void> {
  if (!app || app.page.isClosed()) return;
  const path = info.outputPath("limit-reset-failure.png");
  await app.page.screenshot({ path, animations: "disabled" })
    .then(() => info.attach("Limit reset failure", { path, contentType: "image/png" }))
    .catch(() => undefined);
}

test("offers, schedules and snoozes from a row inside the composer dock", async ({ browserName: _browserName }, info) => {
  test.setTimeout(150_000);
  try {
    await app.resizeWindow(1440, 920);
    const row = await showChat(app, seed.offer);
    const page = app.page;
    await dismissQuotaNotice(page);
    const resume = row.getByRole("button", { name: "Resume at reset", exact: true });
    const snooze = row.getByRole("button", { name: "Snooze until reset", exact: true });
    await expect(row.getByText("Usage limit reached", { exact: true })).toBeVisible();
    await expect(resume).toBeEnabled();
    await expect(resume).not.toHaveAttribute("aria-disabled", "true");
    await expect(snooze).toBeVisible();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expectLayoutHolds(app, row);
    await capture(page, info, "limit-reset-offer-dark");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "limit-reset-offer-light");
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app, row);
    await capture(page, info, "limit-reset-offer-light-narrow");
    await setAppearanceInPlace(app, "dark");
    await capture(page, info, "limit-reset-offer-dark-narrow");
    await app.resizeWindow(760, 600);
    await expectLayoutHolds(app, row);
    await capture(page, info, "limit-reset-offer-dark-760x600");
    await app.resizeWindow(1440, 920);

    writeFileSync(statePath, JSON.stringify({ resetsAt: MOVED_RESET }));
    await resume.focus();
    await page.keyboard.press("Enter");
    const alert = row.getByRole("alert");
    await expect(alert).toHaveText("The reported limit changed. Check the new reset time and try again.");
    await expect(resume).not.toHaveAttribute("aria-disabled", "true");
    await expect(resume).toBeFocused();
    await expectLayoutHolds(app, row);
    await resume.blur();
    await capture(page, info, "limit-reset-error-dark");

    await page.reload();
    await focusAppWindow(app.electronApp, page);
    await expect(row.getByRole("button", { name: "Resume at reset", exact: true })).toBeEnabled();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await resume.focus();
    await page.keyboard.press("Enter");
    const cancel = row.getByRole("button", { name: "Cancel resume", exact: true });
    await expect(row.getByText("Resume scheduled", { exact: true })).toBeVisible();
    await expect(cancel).toBeFocused();
    await expect(cancel).not.toHaveAttribute("aria-disabled", "true");
    await expectLayoutHolds(app, row);
    await cancel.blur();
    await capture(page, info, "limit-reset-dark");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "limit-reset-light");
    await app.resizeWindow(1000, 800);
    await expectLayoutHolds(app, row);
    await capture(page, info, "limit-reset-light-narrow");
    await setAppearanceInPlace(app, "dark");
    await capture(page, info, "limit-reset-dark-narrow");
    await app.resizeWindow(1440, 920);

    await snooze.focus();
    await page.keyboard.press("Enter");
    const snoozed = row.getByRole("button", { name: "Snoozed until reset", exact: true });
    await expect(snoozed).toHaveAttribute("aria-disabled", "true");
    await expect(snoozed).toBeFocused();
    await expectLayoutHolds(app, row);
    await snoozed.blur();
    await capture(page, info, "limit-reset-snoozed-dark");
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await attachFailure(info);
    throw error;
  }
});

test("explains a blocked resume inside the composer dock", async ({ browserName: _browserName }, info) => {
  try {
    await app.resizeWindow(1440, 920);
    const row = await showChat(app, seed.blocked);
    const page = app.page;
    await expect(row.getByText("Resume needs attention", { exact: true })).toBeVisible();
    await expect(row.getByText(BLOCKED_ERROR, { exact: true })).toBeVisible();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Cancel resume", exact: true })).toBeEnabled();
    await expectLayoutHolds(app, row);
    await capture(page, info, "limit-reset-blocked-dark");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "limit-reset-blocked-light");
    await app.resizeWindow(760, 600);
    await expectLayoutHolds(app, row);
    await capture(page, info, "limit-reset-blocked-light-760x600");
    await setAppearanceInPlace(app, "dark");
    await app.resizeWindow(1440, 920);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await attachFailure(info);
    throw error;
  }
});

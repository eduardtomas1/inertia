// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { PROJECT_MEMORY_CONTEXT_LABEL } from "../../src/shared/project-memory";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";

const FIXED_NOW = Date.parse("2026-09-30T16:20:00.000Z");
const ago = (milliseconds: number): string => new Date(FIXED_NOW - milliseconds).toISOString();
const LONG_TITLE = "Run the full billing regression suite before merging any change to proration or invoices";

let app: AppFixture;
let projectId: string;
let conversationId: string;
let answerId: string;

function openStore(): RuntimeStore {
  return new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
}

test.beforeAll(async () => {
  app = await createAppFixture({ name: "project-memory-surfaces", initialState: "conversation", workspaceGit: false, beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
    const databasePath = join(testDirectory, "data", "inertia.sqlite");
    const store = new RuntimeStore(databasePath, workspaceDirectory);
    let turnId: string;
    let context: string;
    try {
      const snapshot = store.shellSnapshot();
      projectId = snapshot.projects[0].id;
      conversationId = snapshot.conversations[0].id;
      store.updateProject(projectId, { name: "Billing workspace" });
      store.updateConversation(conversationId, { title: "Invoice calculation review" });
      const requestedAt = ago(240_000);
      const completedAt = ago(180_000);
      const { turn } = store.beginAgentTurn({ id: randomUUID(), conversationId, runId: randomUUID(),
        content: "Keep the invoice calculation consistent with the previous billing cycle.",
        providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
        model: "gpt-5.6", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised",
        configurationRevision: 1, association: "authoritative", requestedAt });
      turnId = turn.id;
      const answer = store.createMessage(conversationId, "Use the saved proration snapshot. Direct event queries miss previous-cycle plan changes.", "assistant", [], turn.id, completedAt);
      answerId = answer.id;
      store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: requestedAt,
        completedAt, updatedAt: completedAt, terminalAssistantMessageId: answer.id, terminalReason: "provider-completed" });
      const sent = store.projectMemory.save({ projectId, expectedRevision: 0, id: randomUUID(), mode: "create",
        entry: { kind: "rule", title: "Use pnpm for scripts", text: "Run project scripts with pnpm, not npm.", reason: "The lockfile is pnpm-lock.yaml." } });
      context = sent.context ?? "";
      store.projectMemory.remove({ projectId, expectedRevision: sent.revision, id: sent.entries[0].id });
      store.updateSettings({ theme: "dark" });
    } finally { store.close(); }
    const database = new Database(databasePath);
    try {
      const digest = createHash("sha256").update(context, "utf8").digest("hex");
      const bytes = Buffer.byteLength(context, "utf8");
      database.prepare("INSERT INTO turn_execution_context_blobs (digest, byte_size, content, created_at) VALUES (?, ?, ?, ?)")
        .run(digest, bytes, context, ago(240_000));
      database.prepare("INSERT INTO turn_execution_context_refs (turn_id, ordinal, digest, kind, label, byte_size, truncated) VALUES (?, 0, ?, 'attachment', ?, ?, 0)")
        .run(turnId, digest, PROJECT_MEMORY_CONTEXT_LABEL, bytes);
    } finally { database.close(); }
  } });
});
test.afterEach(async ({ browserName: _browserName }, info) => {
  if (info.status !== info.expectedStatus && app) {
    await info.attach("Project memory failure state", { body: (await app.page.locator("body").innerText()).slice(0, 16000), contentType: "text/plain" });
    await info.attach("Project memory failure view", { body: await app.page.screenshot(), contentType: "image/png" });
  }
});
test.afterAll(async () => { await app?.close(); });

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectLayoutHolds(region: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  const layout = await region.evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
    nested: [...element.querySelectorAll("button")]
      .filter((button) => button.parentElement?.closest("button")).length,
    truncatedTitles: [...element.querySelectorAll<HTMLElement>("li h3")]
      .filter((title) => title.scrollWidth > title.clientWidth + 1).length,
  }));
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.nested).toBe(0);
  expect(layout.truncatedTitles).toBe(0);
}

async function expectDockHolds(page: Page): Promise<void> {
  await expectComposerEndsAtDock(page.getByRole("region", { name: "Message composer" }));
}

function seedEntries(): void {
  const store = openStore();
  try {
    let state = store.projectMemory.load({ projectId, conversationId });
    state = store.projectMemory.save({ projectId, conversationId, expectedRevision: state.revision, id: randomUUID(), mode: "create",
      entry: { kind: "decision", title: "Preserve billing history", text: "Use the saved proration snapshot when calculating invoices.",
        reason: "Querying billing events directly misses previous-cycle plan changes. Keep the regression test for mid-cycle upgrades." },
      source: { conversationId, messageId: answerId } });
    state = store.projectMemory.save({ projectId, conversationId, expectedRevision: state.revision, id: randomUUID(), mode: "create",
      entry: { kind: "rule", title: "Use pnpm for scripts", text: "Run project scripts with pnpm, not npm.", reason: "The lockfile is pnpm-lock.yaml and npm rewrites it." } });
    state = store.projectMemory.save({ projectId, conversationId, expectedRevision: state.revision, id: randomUUID(), mode: "create",
      entry: { kind: "rule", title: LONG_TITLE, text: "pnpm test:billing covers proration, credits and mid-cycle upgrades.",
        reason: "Billing regressions reached production twice when only unit tests ran." } });
    store.projectMemory.toggle({ projectId, conversationId, expectedRevision: state.revision, expectedChatRevision: state.chatRevision,
      id: state.entries[2].id, enabled: false });
  } finally { store.close(); }
}

function bumpRevisionElsewhere(): void {
  const store = openStore();
  try {
    const state = store.projectMemory.load({ projectId });
    store.projectMemory.save({ projectId, expectedRevision: state.revision, id: randomUUID(), mode: "create",
      entry: { kind: "rule", title: "Format with Prettier", text: "Run pnpm format before committing.", reason: "CI rejects unformatted files." } });
  } finally { store.close(); }
}

async function openPanel(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Rules & decisions", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Close/u }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });

test("captures the launcher, message actions and the empty panel", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await page.clock.setFixedTime(FIXED_NOW);
  await app.resizeWindow(1440, 920);
  await expect(page.getByRole("button", { name: "Project context", exact: true })).toBeVisible();
  await expectDockHolds(page);
  await capture(page, info, "timeline-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "timeline-light-wide");
  const dialog = await openPanel(page);
  await expect(dialog.getByRole("button", { name: "Add entry", exact: true })).toBeVisible();
  await expectLayoutHolds(dialog);
  await capture(page, info, "panel-empty-light-wide");
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "panel-empty-dark-wide");
  await closeDialog(page);
});

test("captures the entry list in every theme and size", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  seedEntries();
  const dialog = await openPanel(page);
  await expect(dialog.getByRole("heading", { name: LONG_TITLE, exact: true })).toBeVisible();
  await expectLayoutHolds(dialog);
  await capture(page, info, "panel-list-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "panel-list-light-wide");
  await app.resizeWindow(1000, 800);
  await expectLayoutHolds(dialog);
  await capture(page, info, "panel-list-light-narrow");
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "panel-list-dark-narrow");
  await app.resizeWindow(760, 600);
  await expectLayoutHolds(dialog);
  await capture(page, info, "panel-list-dark-760x600");
  await app.resizeWindow(1440, 920);
  await dialog.getByRole("button", { name: /^From /u }).click();
  await expect(dialog.getByText("Direct event queries miss previous-cycle plan changes.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Inspect included context", exact: true }).click();
  await expect(dialog.getByLabel("Included project context")).toContainText("Preserve billing history");
  await expectLayoutHolds(dialog);
  await capture(page, info, "panel-expanded-dark-wide");
  await closeDialog(page);
});

test("captures the remember editor and its conflict error", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await page.getByRole("button", { name: "Remember for this project", exact: true }).last().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("Snapshot invoices at period close");
  await dialog.getByLabel("Why it matters", { exact: true }).fill("Plan changes after close must not rewrite issued invoices.");
  await dialog.getByLabel("Title", { exact: true }).blur();
  await expectLayoutHolds(dialog);
  await capture(page, info, "editor-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "editor-light-wide");
  await app.resizeWindow(1000, 800);
  await capture(page, info, "editor-light-narrow");
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "editor-dark-narrow");
  await app.resizeWindow(760, 600);
  await expectLayoutHolds(dialog);
  await capture(page, info, "editor-dark-760x600");
  await app.resizeWindow(1440, 920);
  bumpRevisionElsewhere();
  await dialog.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("changed in another window");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await capture(page, info, "editor-error-dark-wide");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await closeDialog(page);
});

test("captures the context saved with a turn", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Saved project context")).toContainText("Use pnpm for scripts");
  await expectLayoutHolds(dialog);
  await capture(page, info, "turn-context-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "turn-context-light-wide");
  await app.resizeWindow(1000, 800);
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "turn-context-dark-narrow");
  await app.resizeWindow(1440, 920);
  await closeDialog(page);
  await expectDockHolds(page);
});

test("captures rules and decisions in project settings", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await page.getByRole("complementary", { name: "Project navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  if (!await page.getByRole("textbox", { name: "Project name" }).isVisible()) {
    await page.getByRole("button", { name: "Choose project", exact: true }).click();
    await page.getByRole("option", { name: "Billing workspace", exact: true }).click();
  }
  await page.getByRole("button", { name: "Show rules & decisions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preserve billing history", exact: true })).toBeVisible();
  await capture(page, info, "settings-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "settings-light-wide");
  await setAppearanceInPlace(app, "dark");
  expect(app.rendererErrors).toEqual([]);
});

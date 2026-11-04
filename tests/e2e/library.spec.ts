// @inertia-e2e-resource isolated
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import {
  HTML_RENDER_TABLE_TITLE,
  HTML_RENDER_TITLE,
  seedHtmlRenderConversation,
} from "./support/html-render-fixture";

const REQUEST = "Summarise the settled row review in one paragraph.";
const ANSWER = "Ship treatment A: one quiet 36 px line per finished turn, with the duration folded in from B.";
const SAVED_TITLE = "Summarise the settled row review in one paragraph.";
const HISTORY_TITLE = "Retry policy research";
const TARGET_TITLE = "Token bucket for request retries";
const TARGET_ANSWER = "Use a token bucket: five requests of burst, refilled at one per second, shared by every endpoint.";
const NEW_CATEGORY = "Design reviews";
const shotsDirectory = process.env.INERTIA_LIBRARY_SHOTS_DIR;

const libraryAppServer = `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let sequence = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "library-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "config/read") return send({ id: message.id, result: { config: {} } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    const threadId = message.params.threadId || "library-thread-" + process.pid;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture", cwd: process.cwd(), serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method !== "turn/start") return;
  sequence += 1;
  const threadId = message.params.threadId;
  const turnId = "library-turn-" + process.pid + "-" + sequence;
  const turn = { id: turnId, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "library-answer-" + sequence, type: "agentMessage", text: ${JSON.stringify(ANSWER)} } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
});
`;

const GALLERY_PAGES = 18;

function galleryPage(index: number): string {
  const bars = Array.from({ length: 6 }, (_, bar) => {
    const height = 30 + ((index * 7 + bar * 13) % 60);
    return `<i style="height:${height}%"></i>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><style>
    body { padding: 12px 4px; }
    h2 { margin: 0 0 4px; font-size: 18px; color: var(--foreground); }
    p { margin: 0 0 14px; color: var(--muted-foreground); font-size: 13px; }
    .chart { display: flex; align-items: flex-end; gap: 10px; height: 180px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
    i { flex: 1; border-radius: 6px 6px 2px 2px; background: var(--accent); opacity: .8; }
  </style></head><body><h2>Quarter chart ${index + 1}</h2><p>Weekly active chats, last six weeks.</p><div class="chart">${bars}</div></body></html>`;
}

let app!: AppFixture;
let page!: Page;
let targetAnswerId = "";

function seedCompletedTurn(
  store: RuntimeStore,
  conversationId: string,
  request: string,
  answer: string,
  at: string,
  whileRunning?: (turn: { turnId: string; runId: string }) => void,
): { turnId: string; messageId: string; runId: string } {
  const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.6", reasoningEffort: "high" });
  const { turn } = store.beginAgentTurn({
    id: randomUUID(),
    conversationId,
    runId: randomUUID(),
    content: request,
    providerId: "codex",
    modelSelection: selection,
    reasoningEffort: selection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: selection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt: at,
  });
  if (whileRunning) {
    store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: at, updatedAt: at });
    whileRunning({ turnId: turn.id, runId: turn.runId });
  }
  const message = store.createMessage(conversationId, answer, "assistant", [], turn.id, at);
  store.updateAgentTurnLifecycle(turn.id, {
    status: "completed",
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    terminalAssistantMessageId: message.id,
    terminalReason: "provider-completed",
  });
  return { turnId: turn.id, messageId: message.id, runId: turn.runId };
}

function seedLibrary({ testDirectory, workspaceDirectory }: { testDirectory: string; workspaceDirectory: string }): void {
  seedHtmlRenderConversation({ testDirectory, workspaceDirectory });
  const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
  try {
    const shell = store.shellSnapshot();
    const activeId = shell.activeConversationId!;
    const projectId = store.conversation(activeId).projectId;
    const architecture = store.library.createCategory("Architecture");
    const research = store.library.createCategory("Research notes");

    const history = store.createConversation(projectId, HISTORY_TITLE, { activate: false });
    for (let index = 0; index < 48; index += 1) {
      const at = new Date(Date.UTC(2026, 9, 20, 9, index)).toISOString();
      const target = index === 3;
      const seeded = seedCompletedTurn(
        store,
        history.id,
        target ? "How should the client pace retries?" : `Review retry step ${index + 1}.`,
        target ? TARGET_ANSWER : `Step ${index + 1} keeps the original request context.\n\n${"The handler reports failures clearly. ".repeat(10)}`,
        at,
      );
      if (target) {
        targetAnswerId = seeded.messageId;
        store.library.saveAnswer({
          conversationId: history.id, turnId: seeded.turnId, messageId: seeded.messageId, categoryId: null, title: TARGET_TITLE,
        });
      }
      if (index === 20) {
        store.library.saveAnswer({
          conversationId: history.id,
          turnId: seeded.turnId,
          messageId: seeded.messageId,
          categoryId: architecture.id,
          title: "Where retries belong in the client",
        });
      }
    }
    const onboarding = store.createConversation(projectId, "Onboarding copy", { activate: false });
    const copy = seedCompletedTurn(
      store,
      onboarding.id,
      "Draft three onboarding headlines.",
      "1. **Your work, already in motion.**\n2. Pick up where every agent left off.\n3. One calm place for every chat.",
      new Date(Date.UTC(2026, 9, 28, 15)).toISOString(),
    );
    store.library.saveAnswer({
      conversationId: onboarding.id,
      turnId: copy.turnId,
      messageId: copy.messageId,
      categoryId: research.id,
      title: "Three onboarding headlines that tested well",
    });
    const gallery = store.createConversation(projectId, "Chart gallery", { activate: false });
    const galleryAt = new Date(Date.UTC(2026, 9, 30, 10)).toISOString();
    for (let batch = 0; batch < GALLERY_PAGES / 6; batch += 1) {
      const at = new Date(Date.parse(galleryAt) - batch * 3_600_000).toISOString();
      seedCompletedTurn(store, gallery.id, `Sketch chart batch ${batch + 1}.`, "Here are the charts.", at, ({ turnId, runId }) => {
        for (let index = batch * 6; index < batch * 6 + 6; index += 1) {
          store.htmlRenders.create({
            conversationId: gallery.id,
            runId,
            turnId,
            title: `Quarter chart ${index + 1}`,
            html: galleryPage(index),
            height: 240,
            createdAt: new Date(Date.parse(at) - (index - batch * 6) * 60_000).toISOString(),
          });
        }
      });
    }
    store.selectConversation(activeId);
  } finally {
    store.close();
  }
}

async function capture(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
  if (shotsDirectory) {
    await mkdir(shotsDirectory, { recursive: true });
    await copyFile(path, join(shotsDirectory, `${name}.png`));
  }
}

async function openLibrary(): Promise<Locator> {
  const destination = page.locator(".sidebar .sidebar-library-action");
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  const library = page.getByRole("main", { name: "Library" });
  await expect(library).toBeVisible();
  return library;
}

function card(library: Locator, title: string): Locator {
  return library.locator(".library-card").filter({ has: page.getByRole("button", { name: title, exact: true }) });
}

function railCount(library: Locator, name: string): Locator {
  return library.getByRole("navigation", { name: "Categories" })
    .locator(".library-category")
    .filter({ has: page.locator(".library-category-name", { hasText: name }) })
    .locator(".library-category-count");
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "library",
    initialState: "conversation",
    codexAppServerSource: libraryAppServer,
    beforeLaunch: seedLibrary,
  });
  page = app.page;
  await app.resizeWindow(1280, 800);
});

test.afterAll(async () => {
  await app?.close();
});

test("saves an answer into a new category and returns to it from the Library", async ({ browserName: _browserName }, info) => {
  test.setTimeout(180_000);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const composer = page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message" }).fill(REQUEST);
  await composer.getByRole("button", { name: "Send message" }).click();
  const answer = page.locator(".turn-final-answer-document").filter({ hasText: ANSWER });
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(composer.getByRole("button", { name: "Stop agent" })).toHaveCount(0, { timeout: 20_000 });
  const answerId = await answer.getAttribute("data-terminal-answer-id");
  expect(answerId).toBeTruthy();

  const turn = answer.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' response-turn ')][1]");
  await turn.hover();
  const save = turn.getByRole("button", { name: "Save to Library" });
  await save.click();
  const menu = page.getByRole("menu", { name: "Saved to" });
  await expect(menu).toBeVisible();
  await expect(turn.getByRole("button", { name: "Saved to Library" })).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitemradio", { name: "Unsorted" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "Architecture" })).toBeVisible();
  await capture(info, "save-menu");

  await menu.getByRole("menuitem", { name: "New category…" }).click();
  await menu.getByRole("textbox", { name: "New category name" }).fill(NEW_CATEGORY);
  await menu.getByRole("textbox", { name: "New category name" }).press("Enter");
  await expect(menu).toHaveCount(0);
  const saved = turn.getByRole("button", { name: "Saved to Library" });
  await expect(saved).toBeFocused();
  await saved.click();
  await expect(page.getByRole("menu", { name: "Saved to" }).getByRole("menuitemradio", { name: NEW_CATEGORY }))
    .toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Saved to" })).toHaveCount(0);

  const library = await openLibrary();
  await expect(railCount(library, "All")).toHaveText("4");
  await expect(railCount(library, NEW_CATEGORY)).toHaveText("1");
  await expect(railCount(library, "Unsorted")).toHaveText("1");
  await expect(card(library, SAVED_TITLE).locator(".library-card-chip")).toHaveText(NEW_CATEGORY);

  const target = card(library, TARGET_TITLE);
  await target.hover();
  await target.getByRole("button", { name: "Move to category" }).click();
  const move = page.getByRole("menu", { name: "Move to category" });
  await move.getByRole("menuitemradio", { name: NEW_CATEGORY }).click();
  await expect(railCount(library, NEW_CATEGORY)).toHaveText("2");
  await expect(library.getByRole("navigation", { name: "Categories" }).getByText("Unsorted")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await capture(info, "library-saved-answers");

  await library.getByRole("navigation", { name: "Categories" }).getByRole("button", { name: new RegExp(`^${NEW_CATEGORY}`, "u") }).click();
  await expect(library.locator(".library-card")).toHaveCount(2);
  await target.hover();
  await target.getByRole("button", { name: "Open in chat" }).click();
  await expect(page.getByRole("heading", { name: HISTORY_TITLE, level: 1 })).toBeVisible();
  const landed = page.locator(`[data-terminal-answer-id="${targetAnswerId}"]`);
  await expect(landed).toBeFocused({ timeout: 15_000 });
  await expect(landed).toBeInViewport();
  await expect(landed).toContainText("five requests of burst");

  const again = await openLibrary();
  await again.getByRole("button", { name: SAVED_TITLE, exact: true }).click();
  const own = page.locator(`[data-terminal-answer-id="${answerId}"]`);
  await expect(own).toBeFocused({ timeout: 15_000 });
  await expect(own).toBeInViewport();
  expect(app.rendererErrors).toEqual([]);
});

async function processMemory(): Promise<{ processes: number; workingSetMiB: number }> {
  const metrics = await app.electronApp.evaluate(({ app: electron }) =>
    electron.getAppMetrics().map(({ memory }) => memory.workingSetSize));
  return { processes: metrics.length, workingSetMiB: Math.round(metrics.reduce((total, size) => total + size, 0) / 1024) };
}

test("previews visible pages live and goes from a page back to its answer", async ({ browserName: _browserName }, info) => {
  test.setTimeout(150_000);
  const library = await openLibrary();
  const before = await processMemory();
  await library.getByRole("tab", { name: "Pages" }).click();
  const grid = library.getByRole("list", { name: "Pages" });
  await expect(grid.locator(".library-page")).toHaveCount(GALLERY_PAGES + 2);
  await expect(grid.getByRole("button", { name: HTML_RENDER_TITLE, exact: true })).toBeVisible();
  await expect(grid.getByRole("button", { name: HTML_RENDER_TABLE_TITLE, exact: true })).toBeVisible();

  const previews = grid.getByTestId("library-page-preview");
  const firstCard = grid.locator(".library-page").first();
  await expect(firstCard.locator(".library-page-preview")).toHaveAttribute("data-preview-state", "ready", { timeout: 15_000 });
  const mounted = await previews.count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThanOrEqual(12);
  const lastCard = grid.locator(".library-page").last();
  await expect(lastCard.getByTestId("library-page-preview")).toHaveCount(0);
  const frame = firstCard.getByTestId("library-page-preview");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("tabindex", "-1");
  await expect(frame).toHaveCSS("pointer-events", "none");
  await expect(firstCard.locator(".library-page-preview")).toHaveAttribute("aria-hidden", "true");
  await expect(page.frameLocator(".library-page:first-child [data-testid=library-page-preview]").locator("table, h2").first())
    .toBeAttached();
  await page.mouse.move(0, 0);
  await capture(info, "library-pages");
  const visibleMemory = await processMemory();

  await lastCard.scrollIntoViewIfNeeded();
  await expect(lastCard.locator(".library-page-preview")).toHaveAttribute("data-preview-state", "ready", { timeout: 15_000 });
  await expect(firstCard.getByTestId("library-page-preview")).toHaveCount(0);
  expect(await previews.count()).toBeLessThanOrEqual(12);
  await page.mouse.move(0, 0);
  await capture(info, "library-pages-previews");
  const scrolledMemory = await processMemory();
  const memory = `processes ${before.processes}→${visibleMemory.processes}→${scrolledMemory.processes}; working set ${before.workingSetMiB}→${visibleMemory.workingSetMiB}→${scrolledMemory.workingSetMiB} MiB; previews mounted ${mounted}`;
  info.annotations.push({ type: "preview-memory", description: memory });
  console.log(`[library previews] ${memory}`);

  await firstCard.scrollIntoViewIfNeeded();
  await grid.getByRole("button", { name: HTML_RENDER_TITLE, exact: true }).click();
  const dialog = page.getByTestId("html-render-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("html-render-dialog-frame")).toHaveAttribute("sandbox", "allow-scripts");
  await dialog.getByRole("button", { name: "Go to answer" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("main", { name: "Library" })).toHaveCount(0);
  const figure = page.getByRole("figure", { name: HTML_RENDER_TITLE, exact: true });
  await expect(figure).toBeFocused({ timeout: 15_000 });
  await expect(figure).toBeInViewport();
  expect(app.rendererErrors).toEqual([]);
});

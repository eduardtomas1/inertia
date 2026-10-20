// @inertia-e2e-resource isolated
import { expect, test, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const FIXED_NOW = Date.parse("2026-10-19T12:00:00.000Z");
const FIXTURE_CHAT = "initiatives fixture";
const FAILED_CHAT = "Fix the flaky checkout test";
const INITIATIVE = "Checkout redesign";
const ANSWER = "Started on the checkout form.";
const EVIDENCE = process.env.INERTIA_E2E_EVIDENCE === "1";
const EVIDENCE_DIRECTORY = join(process.cwd(), "test-results", "initiatives-evidence");

const initiativesAppServer = `
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "initiatives-thread";
let turnSequence = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "initiatives-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal: null } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: {
      thread: { id: threadId }, cwd: process.cwd(), model: "fixture",
      serviceTier: null, initialTurnsPage: null,
    } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const turnId = "initiatives-turn-" + turnSequence;
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "item/agentMessage/delta", params: {
    threadId, turnId, itemId: "initiatives-answer", delta: ${JSON.stringify(ANSWER)},
  } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
});
`;

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "initiatives",
    initialState: "conversation",
    codexAppServerSource: initiativesAppServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      try {
        const project = store.shellSnapshot().projects[0]!;
        const failed = store.createConversation(project.id, FAILED_CHAT, { activate: false });
        store.updateConversation(failed.id, { status: "failed" });
        store.createConversation(project.id, "Unrelated chat", { activate: false });
      } finally {
        store.close();
      }
    },
  });
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app.close();
});

async function evidence(name: string, clip?: Locator): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    const box = clip ? await clip.boundingBox() : null;
    await app.page.screenshot({
      path: join(EVIDENCE_DIRECTORY, `${name}-${theme}.png`),
      animations: "disabled",
      ...(box ? { clip: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
    });
  }
}

async function openRowActions(title: string): Promise<Locator> {
  const sidebar = app.page.locator(".sidebar");
  const row = sidebar.getByRole("button", { name: new RegExp(`^${title},`, "u") });
  await row.focus();
  await row.press("Shift+F10");
  const menu = app.page.getByRole("menu", { name: `Thread actions for ${title}` });
  await expect(menu).toBeVisible();
  const move = menu.getByRole("menuitem", { name: "Move to initiative" });
  await move.focus();
  await app.page.keyboard.press("ArrowRight");
  const submenu = app.page.getByRole("menu", { name: "Move to initiative" });
  await expect(submenu).toBeVisible();
  return submenu;
}

test("groups chats under an initiative from the sidebar, the page and the new-chat composer", async () => {
  const page = app.page;
  await app.resizeWindow(1440, 1000);
  const sidebar = page.locator(".sidebar");

  // The Initiatives row is always there; without initiatives its page explains
  // them, and the new-chat composer stays unchanged (no initiative picker).
  const initiativesRow = sidebar.getByRole("button", { name: /^Initiatives$/u });
  await expect(initiativesRow).toBeVisible();
  await initiativesRow.click();
  const emptyView = page.getByRole("main", { name: "Initiatives" });
  await expect(emptyView.getByText(/groups chats from any project under one name/u)).toBeVisible();
  await expect(emptyView.getByRole("button", { name: "New initiative" })).toBeEnabled();
  await page.getByRole("button", { name: "Start a new chat" }).click();
  await expect(page.getByRole("region", { name: "Message composer" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Initiative: /u })).toHaveCount(0);
  await sidebar.getByRole("button", { name: new RegExp(`^${FIXTURE_CHAT},`, "u") }).click();

  // Create an initiative from a chat's actions menu; the chat moves into it.
  const submenu = await openRowActions(FIXTURE_CHAT);
  await submenu.getByRole("menuitem", { name: "New initiative…" }).click();
  const dialog = page.getByRole("dialog", { name: "New initiative" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name" }).fill(INITIATIVE);
  await dialog.getByRole("radio", { name: "Teal" }).click();
  await dialog.getByRole("button", { name: "Create initiative" }).click();
  await expect(dialog).toBeHidden();
  // Focus returns to the chat that asked for the initiative, now in its section.
  await expect(sidebar.getByRole("button", { name: new RegExp(`^${FIXTURE_CHAT},`, "u") })).toBeFocused();

  const header = sidebar.getByRole("button", { name: new RegExp(`^${INITIATIVE} initiative, 1 chat`, "u") });
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const section = (title: string) => sidebar.getByRole("button", { name: new RegExp(`^${title},`, "u") })
    .locator("xpath=ancestor::*[@data-work-section][1]");
  await expect(section(FIXTURE_CHAT)).toHaveAttribute("data-work-section", /^initiative:/u);
  await expect(section("Unrelated chat")).toHaveAttribute("data-work-section", "recent");
  await expect(sidebar.getByRole("heading", { name: /^Recent/u })).toBeVisible();

  // Move the failed chat in; the section badge counts it as waiting on the user.
  const moveFailed = await openRowActions(FAILED_CHAT);
  await moveFailed.getByRole("menuitem", { name: INITIATIVE }).click();
  const busyHeader = sidebar.getByRole("button", { name: `${INITIATIVE} initiative, 2 chats, 1 waiting on you` });
  await expect(busyHeader).toBeVisible();
  await expect(busyHeader.locator(".initiative-status-badge")).toHaveAttribute("data-initiative-status", "failed");
  await expect(busyHeader.locator(".initiative-status-badge")).toHaveText("1");
  await expect(section(FAILED_CHAT)).toHaveAttribute("data-work-section", /^initiative:/u);
  await app.expectNoViewportOverflow();
  await evidence("sidebar-initiative-section", page.locator(".sidebar"));

  // Collapse and expand with the keyboard.
  await busyHeader.focus();
  await busyHeader.press("Enter");
  await expect(busyHeader).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("button", { name: new RegExp(`^${FAILED_CHAT},`, "u") })).toHaveCount(0);
  await busyHeader.press("Enter");
  await expect(busyHeader).toHaveAttribute("aria-expanded", "true");

  // Open the Initiative page from the section.
  await sidebar.getByRole("button", { name: `Open ${INITIATIVE}` }).click();
  const view = page.getByRole("main", { name: "Initiatives" });
  await expect(view.getByRole("heading", { level: 2, name: INITIATIVE })).toBeVisible();
  await expect(view.getByText("Active · 2 chats", { exact: true })).toBeVisible();
  const members = view.getByRole("region", { name: "Chats in this initiative" });
  await expect(members.getByRole("heading", { name: /^Waiting on you/u })).toBeVisible();
  await expect(members.getByRole("button", { name: new RegExp(`^${FAILED_CHAT}, Inertia, Failed`, "u") })).toBeVisible();
  await expect(page.locator(".workspace-header")).toContainText("Initiatives");
  await expect(sidebar.getByRole("button", { name: /^Initiatives$/u })).toHaveAttribute("aria-current", "page");
  await app.expectNoViewportOverflow();
  await evidence("initiative-page");

  // Start a new chat inside the initiative from the composer picker.
  await page.getByRole("button", { name: "Start a new chat" }).click();
  const composer = page.getByRole("region", { name: "Message composer" });
  const picker = composer.getByRole("button", { name: "Initiative: No initiative" });
  await expect(picker).toBeEnabled();
  await picker.click();
  const menu = page.getByRole("menu", { name: "Choose initiative" });
  await expect(menu.getByRole("menuitemradio", { name: "No initiative" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitem", { name: "New initiative…" })).toBeVisible();
  await evidence("composer-initiative-picker");
  await menu.getByRole("menuitemradio", { name: INITIATIVE }).click();
  await expect(composer.getByRole("button", { name: `Initiative: ${INITIATIVE}` })).toBeFocused();
  await composer.getByRole("textbox").first().fill("Build the checkout form");
  await composer.getByRole("textbox").first().press("Enter");
  await expect(page.getByText(ANSWER)).toBeVisible();
  await expect(sidebar.getByRole("button", { name: new RegExp(`^${INITIATIVE} initiative, 3 chats`, "u") })).toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});

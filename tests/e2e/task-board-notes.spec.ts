// @inertia-e2e-resource primary-display
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

let app: AppFixture;
let page: Page;
let notesId: string;
const taskTitle = "Make retries safe to cancel";
const note = "Goal\nKeep cancellation immediate, even during backoff.\n\nDecisions\n• Limit retries to three attempts.\n• Preserve the original request context.\n\nNext steps\nAdd a regression test for cancellation between attempts.\nReview the recovery message before shipping.";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "task-board-notes", initialState: "conversation", seedSecondProject: true, windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const snapshot = store.shellSnapshot();
        const primary = snapshot.conversations.find(({ id }) => id === snapshot.activeConversationId)!;
        notesId = primary.id;
        store.updateConversation(primary.id, { title: taskTitle, pinnedAt: "2026-09-01T09:00:00.000Z" });
        const companion = snapshot.conversations.find(({ id }) => id !== primary.id)!;
        store.updateConversation(companion.id, { title: "Polish the empty states" });
        store.createConversation(primary.projectId, "Improve keyboard navigation");
        store.createConversation(companion.projectId, "Document the retry budget so on-call engineers can tell a slow provider from a stuck one");
        const review = store.createConversation(primary.projectId, "Review the reconnect behavior");
        store.updateConversation(review.id, { status: "completed", branch: "feat/reconnect" });
        const failed = store.createConversation(companion.projectId, "Investigate the flaky export test");
        store.updateConversation(failed.id, { status: "failed" });
        const done = store.createConversation(primary.projectId, "Ship clearer activity labels");
        store.settleConversation(done.id, true);
        const snoozed = store.createConversation(companion.projectId, "Explore additional export formats");
        store.updateConversation(snoozed.id, { snoozedUntil: "2099-09-01T10:00:00.000Z" });
        store.updateSettings({ theme: "dark", colorTheme: "ocean" });
        store.selectConversation(primary.id);
      } finally { store.close(); }
    },
  });
  page = app.page;
  await app.resizeWindow(1500, 1000);
});
test.afterAll(async () => { await app?.close(); });

async function board() {
  await page.getByRole("button", { name: "Task board", exact: true }).click();
  const view = page.getByRole("region", { name: "Task board", exact: true });
  await expect(view).toBeVisible();
  return view;
}
async function expectBoardLayout(view: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  const layout = await view.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(".task-board-main");
    return {
      overflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
      nested: [...element.querySelectorAll("button")].filter((button) => button.parentElement?.closest("button")).length,
      truncatedTitles: [...element.querySelectorAll<HTMLElement>(".task-board-open")].filter((title) => title.scrollWidth > title.clientWidth + 1).length,
      decorated: [...element.querySelectorAll<HTMLElement>(".task-board-card, .task-board-empty")].filter((node) => {
        const style = getComputedStyle(node);
        return style.boxShadow !== "none" || [style.borderTopWidth, style.borderLeftWidth].some((width) => Number.parseFloat(width) > 0);
      }).length,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.nested).toBe(0);
  expect(layout.truncatedTitles).toBe(0);
  expect(layout.decorated).toBe(0);
}
async function command(command: ClientCommand): Promise<ServerEvent> {
  const { websocketUrl } = await app.runtimeSnapshot();
  if (!websocketUrl) throw new Error("Runtime unavailable.");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, { origin: "inertia://bundle" });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Notes request timed out.")); }, 10_000);
    const finish = (event?: ServerEvent, error?: Error): void => {
      clearTimeout(timer); socket.terminate();
      if (error) reject(error); else if (event) resolve(event);
    };
    socket.on("error", (error) => finish(undefined, error));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerEvent;
      const event = frame.type === "runtime.event" ? frame.event : frame;
      if (event.type === "server.welcome") socket.send(JSON.stringify(command));
      else if ("requestId" in event && event.requestId === command.requestId) {
        if (event.type === "request.error") finish(undefined, new Error(event.message));
        else if (event.type === "request.result" || event.type === "request.ok") finish(event);
      }
    });
  });
}

test("shows canonical work states and filters tasks", async () => {
  const view = await board();
  await expect(view.getByRole("region", { name: "Needs attention" }).getByRole("button", { name: "Review the reconnect behavior", exact: true })).toBeVisible();
  await expect(view.getByRole("region", { name: "Done" }).getByRole("button", { name: "Ship clearer activity labels", exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: "Explore additional export formats", exact: true })).toHaveCount(0);
  await view.getByRole("checkbox", { name: "Show snoozed" }).check();
  await expect(view.getByRole("button", { name: "Explore additional export formats", exact: true })).toBeVisible();
  await view.getByRole("checkbox", { name: "Show snoozed" }).uncheck();
  await view.getByRole("textbox", { name: "Search tasks" }).fill("reconnect");
  await expect(view.locator(".task-board-card")).toHaveCount(1);
  await view.getByRole("textbox", { name: "Search tasks" }).clear();
  await expectBoardLayout(view);
});

test("creates, settles, and reopens a task without starting an agent", async () => {
  const view = await board();
  await view.getByRole("button", { name: "New task", exact: true }).click();
  await expect(view.getByRole("textbox", { name: "Task title" })).toBeFocused();
  await view.getByRole("textbox", { name: "Task title" }).fill("Check cancellation between attempts");
  await view.getByRole("button", { name: "Create task" }).click();
  const createdTitle = "Check cancellation between attempts";
  await expect(view.getByRole("region", { name: "Ready", exact: true }).getByRole("button", { name: createdTitle, exact: true })).toBeVisible();
  await view.getByRole("button", { name: `Settle ${createdTitle}`, exact: true }).click();
  await expect(view.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: createdTitle, exact: true })).toBeVisible();
  await view.getByRole("button", { name: `Reopen ${createdTitle}`, exact: true }).click();
  await expect(view.getByRole("region", { name: "Ready", exact: true }).getByRole("button", { name: createdTitle, exact: true })).toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});

test("saves notes through real IPC and restart", async () => {
  test.setTimeout(120_000);
  let view = await board();
  await view.getByRole("combobox", { name: "Task board project" }).selectOption("");
  await view.getByRole("button", { name: `Notes for ${taskTitle}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Close task notes" })).toBeFocused();
  await page.getByRole("textbox", { name: "Chat notes" }).fill(note);
  await page.getByRole("button", { name: "Save notes", exact: true }).click();
  await expect(page.locator(".conversation-notes").getByRole("status")).toHaveText("Saved");
  await app.expectNoViewportOverflow();
  await page.getByRole("button", { name: "Close task notes" }).click();
  await expect(view.getByRole("button", { name: `Notes for ${taskTitle}` })).toBeFocused();
  await view.getByRole("button", { name: taskTitle, exact: true }).click();
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Notes");
  await expect(panel.getByRole("textbox", { name: "Chat notes" })).toHaveValue(note);
  await app.expectNoViewportOverflow();
  ({ page } = await app.restart());
  view = await board();
  await view.getByRole("button", { name: `Notes for ${taskTitle}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Chat notes" })).toHaveValue(note);
  await expect(view.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Ship clearer activity labels", exact: true })).toBeVisible();
  await app.resizeWindow(780, 900);
  await expect(page.getByRole("textbox", { name: "Chat notes" })).toBeVisible();
  await app.expectNoViewportOverflow();
  await page.getByRole("button", { name: "Close task notes" }).click();
  await expect(view.getByRole("button", { name: `Notes for ${taskTitle}` })).toBeFocused();
  await expect(view.getByRole("region", { name: "Ready", exact: true })).toBeVisible();
  await app.resizeWindow(1500, 1000);
  expect(app.rendererErrors).toEqual([]);
});

test("protects an unsaved draft from a competing client", async () => {
  const view = await board();
  await view.getByRole("button", { name: `Notes for ${taskTitle}`, exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Chat notes" });
  await expect(editor).toBeEnabled();
  const loaded = await command({ type: "conversation.notes.get", requestId: randomUUID(), payload: { conversationId: notesId } });
  if (loaded.type !== "request.result" || loaded.result.kind !== "conversation.notes") throw new Error("Expected notes result.");
  await editor.fill("Keep my unsaved draft.");
  await command({ type: "conversation.notes.update", requestId: randomUUID(), payload: { conversationId: notesId, expectedRevision: loaded.result.note.revision, content: "Saved from another window." } });
  await page.getByRole("button", { name: "Save notes", exact: true }).click();
  await expect(page.getByText("Notes changed in another window.")).toBeVisible();
  await expect(editor).toHaveValue("Keep my unsaved draft.");
  await page.getByRole("button", { name: "Use saved notes" }).click();
  await expect(editor).toHaveValue("Saved from another window.");
  expect(app.rendererErrors).toEqual([]);
});

async function capture(info: TestInfo, name: string, keepFocus = false): Promise<void> {
  await app.expectNoViewportOverflow();
  await page.mouse.move(0, 0);
  if (!keepFocus) await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectNotesLayout(notes: Locator): Promise<void> {
  const layout = await notes.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".conversation-notes-body");
    const button = element.querySelector<HTMLElement>("footer .primary-button")?.getBoundingClientRect();
    const status = element.querySelector<HTMLElement>("footer [role='status']")?.getBoundingClientRect();
    return {
      overflow: body ? body.scrollWidth - body.clientWidth : 0,
      centreOffset: button && status ? Math.abs((button.top + button.bottom) / 2 - (status.top + status.bottom) / 2) : 0,
      footerRows: button && status ? Math.round(Math.abs(button.top - status.top) / button.height) : 0,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.centreOffset).toBeLessThanOrEqual(1);
  expect(layout.footerRows).toBe(0);
}

test("captures the board and notes in both appearances and three sizes", async ({ browserName: _browserName }, info) => {
  test.setTimeout(240_000);
  await page.clock.setFixedTime(new Date());
  await app.resizeWindow(1440, 920);
  const view = await board();
  const closeNotes = page.getByRole("button", { name: "Close task notes" });
  if (await closeNotes.isVisible()) await closeNotes.click();
  await view.getByRole("combobox", { name: "Task board project" }).selectOption("");
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await app.resizeWindow(1440, 920);
    await expectBoardLayout(view);
    await capture(info, `task-board-${theme}`);
    await app.resizeWindow(1000, 800);
    await expectBoardLayout(view);
    await capture(info, `task-board-narrow-${theme}`);
  }
  await setAppearanceInPlace(app, "dark");
  await app.resizeWindow(760, 600);
  await expectBoardLayout(view);
  await capture(info, "task-board-760x600-dark");
  await app.resizeWindow(1440, 920);

  await view.getByRole("button", { name: "New task", exact: true }).click();
  await view.getByRole("textbox", { name: "Task title" }).fill("Check cancellation between attempts");
  const actions = await view.locator(".task-board-create-actions button").evaluateAll((buttons) =>
    buttons.map((button) => { const bounds = button.getBoundingClientRect(); return { top: bounds.top, height: bounds.height }; }));
  expect(actions).toHaveLength(2);
  expect(Math.abs(actions[0]!.top - actions[1]!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(actions[0]!.height - actions[1]!.height)).toBeLessThanOrEqual(1);
  await capture(info, "task-board-create-dark", true);
  await setAppearanceInPlace(app, "light");
  await capture(info, "task-board-create-light", true);
  await setAppearanceInPlace(app, "dark");
  await view.getByRole("button", { name: "Cancel", exact: true }).click();
  await view.getByRole("textbox", { name: "Search tasks" }).fill("quarterly report");
  await expect(view.getByText("No tasks match. Try another search or project.")).toBeVisible();
  await expectBoardLayout(view);
  await capture(info, "task-board-no-results-dark");
  await view.getByRole("textbox", { name: "Search tasks" }).clear();

  await view.getByRole("button", { name: `Notes for ${taskTitle}`, exact: true }).click();
  await expect(closeNotes).toBeFocused();
  const boardNotes = page.locator(".task-board-notes .conversation-notes");
  const editor = boardNotes.getByRole("textbox", { name: "Chat notes" });
  await expect(editor).toBeEnabled();
  await editor.fill(note);
  await boardNotes.getByRole("button", { name: "Save notes", exact: true }).click();
  await expect(boardNotes.getByRole("status")).toHaveText("Saved");
  await expectNotesLayout(boardNotes);
  await capture(info, "task-board-notes-dark");
  await setAppearanceInPlace(app, "light");
  await capture(info, "task-board-notes-light");
  await app.resizeWindow(1000, 800);
  await expectNotesLayout(boardNotes);
  await capture(info, "task-board-notes-narrow-light");
  await setAppearanceInPlace(app, "dark");
  await capture(info, "task-board-notes-narrow");
  await app.resizeWindow(760, 600);
  await expectNotesLayout(boardNotes);
  await capture(info, "task-board-notes-760x600-dark");
  await app.resizeWindow(1440, 920);
  await editor.fill(`${note}\nShare the summary with the team.`);
  await expect(boardNotes.getByRole("status")).toHaveText("Unsaved changes");
  await expectNotesLayout(boardNotes);
  await capture(info, "task-board-notes-unsaved-dark");
  await editor.fill(note);
  await closeNotes.click();

  await view.getByRole("button", { name: taskTitle, exact: true }).click();
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Notes");
  const panelNotes = panel.locator(".conversation-notes");
  await expect(panelNotes.getByRole("textbox", { name: "Chat notes" })).toHaveValue(note);
  const composer = page.getByRole("region", { name: "Message composer" });
  for (const [name, theme, width, height] of [
    ["task-board-chat-notes", "dark", 1440, 920], ["chat-notes-light", "light", 1440, 920],
    ["chat-notes-narrow-light", "light", 1000, 800], ["chat-notes-narrow-dark", "dark", 1000, 800],
    ["chat-notes-760x600-dark", "dark", 760, 600],
  ] as const) {
    await setAppearanceInPlace(app, theme);
    await app.resizeWindow(width, height);
    await expectNotesLayout(panelNotes);
    if (await composer.isVisible()) await expectComposerEndsAtDock(composer);
    await capture(info, name);
  }
  await app.resizeWindow(1440, 920);

  const panelEditor = panelNotes.getByRole("textbox", { name: "Chat notes" });
  const loaded = await command({ type: "conversation.notes.get", requestId: randomUUID(), payload: { conversationId: notesId } });
  if (loaded.type !== "request.result" || loaded.result.kind !== "conversation.notes") throw new Error("Expected notes result.");
  await panelEditor.fill(`${note}\nShare the summary with the team.`);
  await command({ type: "conversation.notes.update", requestId: randomUUID(), payload: { conversationId: notesId, expectedRevision: loaded.result.note.revision, content: "Goal\nKeep cancellation immediate." } });
  await panelNotes.getByRole("button", { name: "Save notes", exact: true }).click();
  await expect(panelNotes.getByText("Notes changed in another window.")).toBeVisible();
  await expect(panelNotes.getByRole("button", { name: "Save notes", exact: true })).toBeFocused();
  await expectNotesLayout(panelNotes);
  await capture(info, "chat-notes-conflict-dark");
  await panelNotes.getByText("Show saved notes").click();
  await expect(panelNotes.getByRole("region", { name: "Saved notes" })).toHaveText("Goal\nKeep cancellation immediate.");
  await setAppearanceInPlace(app, "light");
  await capture(info, "chat-notes-conflict-light");
  await setAppearanceInPlace(app, "dark");
  await panelNotes.getByRole("button", { name: "Use saved notes" }).click();

  await board();
  await view.getByRole("button", { name: `Notes for ${taskTitle}`, exact: true }).click();
  await setAppearanceInPlace(app, "light");
  await command({ type: "settings.update", requestId: randomUUID(), payload: { colorTheme: "ember", lightColorTheme: "ember" } });
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "ember");
  await expectBoardLayout(view);
  await capture(info, "task-board-notes-ember-light");
  await command({ type: "settings.update", requestId: randomUUID(), payload: { colorTheme: "ocean", lightColorTheme: "ocean" } });
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "ocean");
  await setAppearanceInPlace(app, "dark");
  await closeNotes.click();
  await view.getByRole("button", { name: taskTitle, exact: true }).click();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await page.getByRole("combobox", { name: "Search commands, projects, chats, and messages" }).fill("task board");
  await capture(info, "task-board-palette-dark", true);
  await page.keyboard.press("Escape");
  expect(app.rendererErrors).toEqual([]);
});

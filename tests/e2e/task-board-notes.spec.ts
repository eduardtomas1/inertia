// @inertia-e2e-resource primary-display
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
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
async function evidence(info: TestInfo, name: string) {
  await app.expectNoViewportOverflow();
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
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

test("shows canonical work states, filters tasks, and captures both appearances", async ({ browserName: _browserName }, info) => {
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
  await view.getByRole("heading", { name: "Keep the next step in sight." }).click();
  await evidence(info, "task-board-dark");
  await setAppearanceInPlace(app, "light");
  await evidence(info, "task-board-light");
  await setAppearanceInPlace(app, "dark");
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

test("saves notes through real IPC and restart", async ({ browserName: _browserName }, info) => {
  test.setTimeout(120_000);
  let view = await board();
  await view.getByRole("combobox", { name: "Task board project" }).selectOption("");
  await view.getByRole("button", { name: `Notes for ${taskTitle}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Close task notes" })).toBeFocused();
  await page.getByRole("textbox", { name: "Chat notes" }).fill(note);
  await page.getByRole("button", { name: "Save notes", exact: true }).click();
  await expect(page.locator(".conversation-notes").getByRole("status")).toHaveText("Saved");
  await evidence(info, "task-board-notes-dark");
  await page.getByRole("button", { name: "Close task notes" }).click();
  await expect(view.getByRole("button", { name: `Notes for ${taskTitle}` })).toBeFocused();
  await view.getByRole("button", { name: taskTitle, exact: true }).click();
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Notes");
  await expect(panel.getByRole("textbox", { name: "Chat notes" })).toHaveValue(note);
  await evidence(info, "task-board-chat-notes");
  ({ page } = await app.restart());
  view = await board();
  await view.getByRole("button", { name: `Notes for ${taskTitle}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Chat notes" })).toHaveValue(note);
  await expect(view.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Ship clearer activity labels", exact: true })).toBeVisible();
  await app.resizeWindow(780, 900);
  await expect(page.getByRole("textbox", { name: "Chat notes" })).toBeVisible();
  await evidence(info, "task-board-notes-narrow");
  await page.getByRole("button", { name: "Close task notes" }).click();
  await expect(view.getByRole("button", { name: `Notes for ${taskTitle}` })).toBeFocused();
  await expect(view.getByRole("heading", { name: "Keep the next step in sight." })).toBeVisible();
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

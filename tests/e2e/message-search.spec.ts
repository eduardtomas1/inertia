import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
let page: Page;
let targetTurnId: string;
const targetTitle = "Investigate request failures";
const phrase = "retry budget";
const draft = "Keep this unsent draft while I look up an earlier decision.";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "message-search", initialState: "conversation", seedSecondProject: true, windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const shell = store.shellSnapshot();
        const chat = shell.conversations.find(({ title }) => title.endsWith("companion"))!;
        store.updateConversation(chat.id, { title: targetTitle });
        store.updateSettings({ theme: "dark", colorTheme: "ocean", showTimestamps: true });
        for (let index = 0; index < 80; index += 1) {
          const at = new Date(Date.UTC(2026, 8, 6, 9, index)).toISOString();
          const { turn } = store.beginAgentTurn({
            id: randomUUID(), conversationId: chat.id, runId: randomUUID(),
            content: index === 5 ? "Why does an intermittent request fail?" : `Review step ${index + 1} of the request handling changes.`,
            providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
            model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
            configurationRevision: 0, association: "authoritative", requestedAt: at,
          });
          const answer = store.createMessage(chat.id,
            index === 5 ? "### Request recovery\n\nSet the retry " : `### Review ${index + 1}\n\nThe request handler preserves the original context and reports failures clearly.\n\n${"Validation completed successfully. ".repeat(12)}`,
            "assistant", [], turn.id, at,
          );
          if (index === 5) {
            targetTurnId = turn.id;
            store.appendMessageContent(answer.id, "budget to three attempts. Use exponential backoff and stop when cancellation is requested.\n\nThe caller receives the final error if those attempts fail.");
          }
          store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalAssistantMessageId: answer.id, startedAt: at, completedAt: at, updatedAt: at, terminalReason: "provider-completed" });
          store.createTurnGitArtifact({ id: randomUUID(), turnId: turn.id, branch: "main", createdAt: at });
          store.completeTurnGitArtifact(turn.id, {
            files: [], insertions: 0, deletions: 0, status: "ready", completeness: "complete", patchState: "none",
            capturedAt: at, terminalAssistantMessageId: answer.id, updatedAt: at,
          });
        }
        store.selectConversation(shell.activeConversationId!);
      } finally { store.close(); }
    },
  });
  page = app.page;
});
test.afterAll(async () => { await app?.close(); });

async function search() {
  await page.bringToFront();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const input = page.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
  await expect(input).toBeFocused();
  await input.fill(phrase);
  await expect(page.getByRole("option", { name: new RegExp(targetTitle) })).toBeVisible();
  await expect(page.locator(".palette-message-snippet mark")).toHaveText(phrase);
  return input;
}

async function evidence(current: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await current.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

function finalAnswer(current: Page) {
  return current.locator(`[data-turn-id="${targetTurnId}"] [data-turn-jump-target="final"]`);
}

test("finds chunked content in an unloaded chat, jumps to an old virtual row and preserves the draft", async ({ browserName: _browserName }, info) => {
  await app.resizeWindow(1440, 920);
  await page.getByRole("textbox", { name: "Message" }).fill(draft);
  const input = await search();
  await evidence(page, info, "palette-dark");
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: targetTitle, level: 1 })).toBeVisible();
  await expect(finalAnswer(page)).toBeFocused();
  await expect(finalAnswer(page)).toBeInViewport();
  await expect(finalAnswer(page)).toContainText("retry budget to three attempts");
  await app.expectNoViewportOverflow();
  await evidence(page, info, "matching-turn");

  await page.getByRole("button", { name: /^Change theme \(current:/ }).click();
  await app.resizeWindow(1000, 740);
  await search();
  await app.expectNoViewportOverflow();
  await evidence(page, info, "palette-light");
  await page.keyboard.press("Escape");
  await app.resizeWindow(1440, 920);
  await page.locator(".activity-thread-select").filter({ hasText: "message-search fixture" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);
  expect(app.rendererErrors).toEqual([]);
});

test("reveals a match in an existing split pane and in its detached window", async ({ browserName: _browserName }, info) => {
  await page.getByRole("button", { name: `Thread actions for ${targetTitle}` }).click();
  await page.getByRole("menuitem", { name: "Add this chat to split view" }).click();
  const input = await search();
  await input.press("Enter");
  await expect(page.getByRole("main", { name: "Split conversation workspace" })).toBeVisible();
  await expect(finalAnswer(page)).toBeFocused();
  await expect(finalAnswer(page)).toBeInViewport();

  const opened = app.electronApp.waitForEvent("window");
  await page.getByRole("button", { name: `Open ${targetTitle} in a new window` }).click();
  const popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  await popup.getByRole("textbox", { name: "Message" }).fill("Detached draft stays here.");
  const detachedSearch = await search();
  await detachedSearch.press("Enter");
  await expect(finalAnswer(popup)).toBeFocused();
  await expect(finalAnswer(popup)).toBeInViewport();
  await expect(popup.getByRole("textbox", { name: "Message" })).toHaveValue("Detached draft stays here.");
  await evidence(popup, info, "detached-match");
  // Return through the native window's existing explicit dock action.
  await popup.getByRole("button", { name: /Return.*main|Dock/u }).click();
  await page.bringToFront();
  expect(app.rendererErrors).toEqual([]);
});

test("searches persisted history after a full application restart", async () => {
  test.setTimeout(75_000);
  ({ page } = await app.restart());
  const input = await search();
  await input.press("Enter");
  await expect(finalAnswer(page)).toBeFocused();
  await expect(finalAnswer(page)).toBeInViewport();
  expect(app.rendererErrors).toEqual([]);
});

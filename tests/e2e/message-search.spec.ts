// @inertia-e2e-resource primary-display
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture;
let page: Page;
let targetTurnId: string;
let followUpMessageId: string;
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
        store.updateSettings({ theme: "dark", colorTheme: "ocean", showTimestamps: true, autoCollapseWorkLog: true });
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
            store.createMessage(chat.id, "Investigation observation.\n\n".repeat(120), "assistant", [], turn.id, "2026-09-06T09:05:01.000Z");
            followUpMessageId = store.createAcknowledgedFollowUpMessage(chat.id, turn.id, "Also bound the maximum recovery delay for this endpoint.", "2026-09-06T09:05:02.000Z").id;
          }
          store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalAssistantMessageId: answer.id, startedAt: at, completedAt: at, updatedAt: at, terminalReason: "provider-completed" });
          store.createTurnGitArtifact({ id: randomUUID(), turnId: turn.id, branch: "main", createdAt: at });
          store.completeTurnGitArtifact(turn.id, {
            files: [], insertions: 0, deletions: 0, status: "ready", completeness: "complete", patchState: "none",
            capturedAt: at, terminalAssistantMessageId: answer.id, updatedAt: at,
          });
        }
        const primary = shell.conversations.find(({ id }) => id === shell.activeConversationId)!;
        const planning = store.createConversation(primary.projectId, "Improve API resilience");
        store.createMessage(planning.id, "Can we make the retry budget configurable per endpoint? Keep cancellation immediate.", "user", [], null, "2026-09-05T09:00:00.000Z");
        const testing = store.createConversation(chat.projectId, "Integration test plan");
        store.createMessage(testing.id, "Cover the retry budget, transient failures, and successful recovery in the integration tests.", "user", [], null, "2026-09-04T09:00:00.000Z");
        store.selectConversation(shell.activeConversationId!);
      } finally { store.close(); }
    },
  });
  page = app.page;
});
test.afterAll(async () => { await app?.close(); });

async function search(query = phrase) {
  await page.bringToFront();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const input = page.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
  await expect(input).toBeFocused();
  await input.fill(query);
  await expect(page.getByRole("option", { name: new RegExp(targetTitle) })).toBeVisible();
  await expect(page.locator(".palette-message-snippet mark").first()).toHaveText(query);
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
  await expect(page.locator(`[data-turn-id="${targetTurnId}"] .turn-run-details-toggle`)).toHaveAttribute("aria-expanded", "false");
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
  const earlier = page.getByRole("button", { name: /^Earlier/u });
  if (await earlier.getAttribute("aria-expanded") === "false") await earlier.click();
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

test("returns to an unsent new-chat draft after following a search result", async () => {
  await page.locator(".activity-thread-select").filter({ hasText: "message-search fixture" }).click();
  await expect(page.getByRole("heading", { name: /message-search fixture/u, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
  const unsent = "Keep this new-chat draft while I look up the retry decision.";
  await page.getByRole("textbox", { name: "Message" }).fill(unsent);
  const input = await search();
  await input.press("Enter");
  await expect(finalAnswer(page)).toBeFocused();
  await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(unsent);
  expect(app.rendererErrors).toEqual([]);
});

test("reveals the exact follow-up inside a collapsed long historical turn", async ({ browserName: _browserName }, info) => {
  const input = await search("maximum recovery delay");
  await input.press("Enter");
  const followUp = page.locator(`[data-follow-up-message-id="${followUpMessageId}"]`);
  await expect(followUp).toBeFocused();
  await expect(followUp).toBeInViewport();
  await expect(followUp).toHaveText(/maximum recovery delay/u);
  await expect(page.locator(`[data-turn-id="${targetTurnId}"] .turn-run-details-toggle`)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-turn-id="${targetTurnId}"] [data-turn-jump-target="request"]`)).not.toBeInViewport();
  await evidence(page, info, "follow-up-match");
  expect(app.rendererErrors).toEqual([]);
});

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let page!: Page;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "detached-chat-window",
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const snapshot = store.shellSnapshot();
      if (!snapshot.activeConversationId || !snapshot.activeProjectId) {
        throw new Error("Detached chat fixture requires an active chat.");
      }
      const source = store.createConversation(
        snapshot.activeProjectId,
        "Reviewed context",
        { activate: false },
      );
      const sourceMessage = store.createMessage(
        source.id,
        "Keep detached windows scoped to their current chat.",
        "assistant",
      );
      const packet = store.contextPackets.create({
        sourceConversationId: source.id,
        targetConversationId: snapshot.activeConversationId,
        sourceMessageIds: [sourceMessage.id],
        acknowledgedWorkspaceDifference: false,
      });
      const requestedAt = "2026-08-20T08:30:00.000Z";
      const turn = store.beginAgentTurn({
        id: randomUUID(),
        conversationId: snapshot.activeConversationId,
        runId: randomUUID(),
        content: "Preserve this reviewed context in chat history.",
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "builtin:openai",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
        requestedAt,
        conversationContextPacketIds: [packet.id],
        contextRequestId: randomUUID(),
      });
      store.updateAgentTurnLifecycle(turn.turn.id, {
        status: "completed",
        startedAt: requestedAt,
        completedAt: requestedAt,
        terminalReason: "provider-completed",
        updatedAt: requestedAt,
      });
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

async function openDetachedWindow(title: string): Promise<Page> {
  const opened = app.electronApp.waitForEvent("window");
  await page.getByRole("button", {
    name: `Open ${title} in a new window`,
  }).click();
  const popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  return popup;
}

test("moves one live chat between a remembered native window and the main app", async () => {
  const title = "detached-chat-window fixture";
  const draft = "Keep this exact draft while the view moves.";
  const popupDraft = `${draft} Updated inside the popup.`;
  const dockedDraft = `${popupDraft} Returned explicitly.`;
  const restartDraft = `${dockedDraft} Preserved across restart.`;
  await page.getByRole("textbox", { name: "Message" }).fill(draft);

  const popup = await openDetachedWindow(title);
  await expect(page.getByRole("region", {
    name: `Detached chat: ${title}`,
  })).toContainText("Chat window active");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(popup.getByRole("heading", { name: title })).toBeVisible();
  await expect(popup.getByRole("textbox", { name: "Message" }))
    .toHaveValue(draft);
  await expect(popup.locator('aside[aria-label="Project navigation"]'))
    .toHaveCount(0);
  await expect(popup.getByRole("button", { name: /new chat/iu }))
    .toHaveCount(0);
  await expect(popup.getByRole("button", { name: /prompt presets/iu }))
    .toHaveCount(0);
  await expect(popup.getByRole("button", { name: /scratch prompts/iu }))
    .toHaveCount(0);
  await expect(popup.getByRole("button", {
    name: "Add context from another chat",
  })).toHaveCount(0);
  await expect(popup.getByRole("dialog", {
    name: /chat context/iu,
  })).toHaveCount(0);
  await expect(popup.getByRole("searchbox", { name: "Search chats" }))
    .toHaveCount(0);
  await expect(popup.getByRole("group", { name: "Chat checkout context" }))
    .toHaveCount(0);
  await expect(popup.getByText("Context from Reviewed context")).toBeVisible();

  await popup.getByRole("button", { name: "Keep chat window on top" }).click();
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()
      .find((window) => window.getTitle().startsWith(expectedTitle))
      ?.isAlwaysOnTop() ?? false,
    title,
  )).toBe(true);

  const rememberedBounds = await app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => {
      const window = BrowserWindow.getAllWindows()
        .find((candidate) => candidate.getTitle().startsWith(expectedTitle));
      if (!window) throw new Error("Detached window is missing");
      window.setBounds({ x: 120, y: 110, width: 704, height: 668 });
      return window.getBounds();
    },
    title,
  );
  expect(rememberedBounds).toMatchObject({ width: 704, height: 668 });
  await popup.getByRole("textbox", { name: "Message" }).fill(popupDraft);

  await Promise.all([
    popup.waitForEvent("close"),
    app.electronApp.evaluate(
      ({ BrowserWindow }, expectedTitle) => {
        const window = BrowserWindow.getAllWindows()
          .find((candidate) => candidate.getTitle().startsWith(expectedTitle));
        if (!window) throw new Error("Detached window is missing");
        window.close();
      },
      title,
    ),
  ]);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  )).toBe(1);
  await expect.poll(() => page.evaluate(
    () => window.inertia.getDetachedChatWindows(),
  )).toEqual([]);
  await expect(page.getByRole("region", {
    name: `Detached chat: ${title}`,
  })).toContainText("Chat window closed");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);

  await page.getByRole("button", { name: "Open chat here" }).click();
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue(popupDraft);

  const reopened = await openDetachedWindow(title);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()
      .find((window) => window.getTitle().startsWith(expectedTitle))
      ?.getBounds() ?? null,
    title,
  )).toMatchObject({ width: 704, height: 668 });
  await reopened.getByRole("textbox", { name: "Message" }).fill(dockedDraft);

  await Promise.all([
    reopened.waitForEvent("close"),
    reopened.getByRole("button", {
      name: "Return chat to main window",
    }).click({ noWaitAfter: true }),
  ]);
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue(dockedDraft);
  await expect(page.getByRole("region", {
    name: `Detached chat: ${title}`,
  })).toHaveCount(0);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  )).toBe(1);

  const beforeRestart = await openDetachedWindow(title);
  await beforeRestart.getByRole("textbox", { name: "Message" })
    .fill(restartDraft);
  ({ page } = await app.restart());
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue(restartDraft);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  )).toBe(1);
});

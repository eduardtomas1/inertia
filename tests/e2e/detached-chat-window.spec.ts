import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let page!: Page;
let attachmentImagePath!: string;
let conversationId!: string;
let projectId!: string;
let sourceConversationId!: string;
const detachedAnswer = "Detached copy feedback is ready.";

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
      store.updateSettings({ theme: "dark", colorTheme: "ocean" });
      conversationId = snapshot.activeConversationId;
      projectId = snapshot.activeProjectId;
      const source = store.createConversation(
        snapshot.activeProjectId,
        "Reviewed context",
        { activate: false },
      );
      sourceConversationId = source.id;
      writeFileSync(
        join(workspaceDirectory, "chat-preview.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
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
      const answer = store.createMessage(
        snapshot.activeConversationId,
        detachedAnswer,
        "assistant",
        [],
        turn.turn.id,
        requestedAt,
      );
      store.updateAgentTurnLifecycle(turn.turn.id, {
        status: "completed",
        startedAt: requestedAt,
        completedAt: requestedAt,
        terminalReason: "provider-completed",
        terminalAssistantMessageId: answer.id,
        updatedAt: requestedAt,
      });
      store.close();
    },
  });
  page = app.page;
  attachmentImagePath = app.attachmentImagePath;
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

test("moves one live chat between a remembered native window and the main app", async (
  { browserName: _browserName },
  testInfo,
) => {
  // This scenario proves two complete Electron lifecycles. On macOS the first
  // app may legitimately consume the full supervised shutdown envelope before
  // the replacement process can acquire the same profile and create a window.
  test.setTimeout(75_000);
  const title = "detached-chat-window fixture";
  const draft = "Keep this exact draft while the view moves.";
  const popupDraft = `${draft} Updated inside the popup.`;
  const crashDraft = `${popupDraft} Mirrored before a renderer crash.`;
  const dockedDraft = `${crashDraft} Returned explicitly.`;
  const restartDraft = `${dockedDraft} Preserved across restart.`;
  await page.getByRole("textbox", { name: "Message" }).fill(draft);

  const popup = await openDetachedWindow(title);
  popup.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });
  await expect(page.getByRole("region", {
    name: `Detached chat: ${title}`,
  })).toContainText("Chat window active");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(popup.getByRole("heading", { name: title })).toBeVisible();
  await expect(popup.getByRole("textbox", { name: "Message" }))
    .toHaveValue(draft);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "ocean");
  await expect(popup.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(popup.locator("html")).toHaveAttribute("data-color-theme", "ocean");
  await expect.poll(() => popup.locator("html").evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      background: styles.getPropertyValue("--app-bg").trim(),
      foreground: styles.getPropertyValue("--text").trim(),
      terminal: styles.getPropertyValue("--terminal-bg").trim(),
    };
  })).toEqual({
    background: "#0e171d",
    foreground: "#eef7fb",
    terminal: "#0c151a",
  });
  const themeEvidence = testInfo.outputPath("detached-chat-ocean-dark.png");
  await popup.screenshot({ path: themeEvidence, animations: "disabled" });
  await testInfo.attach("Detached chat · Ocean dark", {
    path: themeEvidence,
    contentType: "image/png",
  });
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
  await popup.getByRole("button", { name: "Copy final answer" }).click();
  const copiedAnswer = popup.getByRole("button", { name: "Answer copied" });
  await expect(copiedAnswer).toBeVisible();
  await expect(copiedAnswer.locator('[data-icon-state="copied"]')).toHaveCount(1);
  await expect(popup.getByRole("status").filter({ hasText: "Answer copied." }))
    .toBeVisible();
  await expect.poll(() => app.electronApp.evaluate(
    ({ clipboard }) => clipboard.readText(),
  )).toBe(detachedAnswer);
  await expect.poll(() => popup.evaluate(async ({ own, foreign, project }) => {
    const status = async (url: string): Promise<number> => {
      try {
        return (await fetch(url)).status;
      } catch {
        return 0;
      }
    };
    return {
      own: await status(own),
      foreign: await status(foreign),
      project: await status(project),
    };
  }, {
    own: `inertia://bundle/workspace-image/${projectId}/${conversationId}/chat-preview.png`,
    foreign: `inertia://bundle/workspace-image/${projectId}/${sourceConversationId}/chat-preview.png`,
    project: `inertia://bundle/workspace-image/${projectId}/project/chat-preview.png`,
  })).toEqual({ own: 200, foreign: 404, project: 404 });

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

  await app.electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, attachmentImagePath);
  await popup.getByRole("button", {
    name: "Attach images, documents, or spreadsheets",
  }).click();
  const attachments = popup.getByRole("list", { name: "Attachments" });
  await expect(attachments.getByText("preview.png", { exact: true }))
    .toBeVisible();
  await app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()
      .find((candidate) => candidate.getTitle().startsWith(expectedTitle))
      ?.close(),
    title,
  );
  await expect(attachments.getByText("preview.png", { exact: true }))
    .toBeVisible();
  await expect(popup.getByRole("alert")).toContainText(
    "Send or remove attachments before moving this chat to a window.",
  );
  await attachments.getByRole("button", {
    name: "Remove attachment preview.png",
  }).click();

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

  const crashPopup = await openDetachedWindow(title);
  await crashPopup.getByRole("textbox", { name: "Message" }).fill(crashDraft);
  await expect.poll(() => page.evaluate(
    (id) => window.localStorage.getItem(`inertia:draft:${id}`),
    conversationId,
  )).toBe(crashDraft);
  await app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()
      .find((candidate) => candidate.getTitle().startsWith(expectedTitle))
      ?.webContents.forcefullyCrashRenderer(),
    title,
  );
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  )).toBe(1);
  await page.getByRole("button", { name: "Open chat here" }).click();
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue(crashDraft);

  const reopened = await openDetachedWindow(title);
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, expectedTitle) => BrowserWindow.getAllWindows()
      .find((window) => window.getTitle().startsWith(expectedTitle))
      ?.getBounds() ?? null,
    title,
  )).toMatchObject({ width: 704, height: 668 });
  await reopened.getByRole("textbox", { name: "Message" }).fill(dockedDraft);

  const returnToMain = reopened.getByRole("button", {
    name: "Return chat to main window",
  });
  await expect(returnToMain).toBeVisible();
  await expect(returnToMain).toBeEnabled();
  const reopenedClosed = reopened.waitForEvent("close");
  await returnToMain.evaluate((button: HTMLButtonElement) => {
    window.setTimeout(() => button.click(), 0);
  });
  await reopenedClosed;
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

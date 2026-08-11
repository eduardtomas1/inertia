import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import {
  createAppFixture,
  processExists,
  type AppFixture,
  type RuntimeTestSnapshot,
} from "./support/app-fixture";
import { seedViewedConversationContext } from "./support/viewed-conversation-context";
import { selectWorkspaceTool } from "./support/workspace-tools";

const execFileAsync = promisify(execFile);

async function stagedAttachmentPath(
  id: string | undefined,
  extension: string,
): Promise<string> {
  expect(id).toBeTruthy();
  const root = join(
    await electronApp.evaluate(({ app: electron }) =>
      electron.getPath("temp")),
    "inertia-attachments",
  );
  const sessions = (await readdir(root))
    .filter((name) => /^session-[A-Za-z0-9_-]{6}$/u.test(name));
  const candidates = await Promise.all(sessions.map(async (session) => {
    const path = join(root, session, `${id}.${extension}`);
    return await stat(path).then(() => path, () => null);
  }));
  const matches = candidates.filter((path) => path !== null);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let attachmentImagePath!: AppFixture["attachmentImagePath"];
let attachmentDocumentPath!: AppFixture["attachmentDocumentPath"];
let malformedAttachmentPath!: AppFixture["malformedAttachmentPath"];
let rendererErrors!: AppFixture["rendererErrors"];
let runtimeSnapshot!: AppFixture["runtimeSnapshot"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "app-shell", initialState: "empty" });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  attachmentImagePath = app.attachmentImagePath;
  attachmentDocumentPath = app.attachmentDocumentPath;
  malformedAttachmentPath = app.malformedAttachmentPath;
  rendererErrors = app.rendererErrors;
  runtimeSnapshot = app.runtimeSnapshot;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
});

test.afterAll(async () => {
  await app.close();
});

test("starts without a demo and adds the first real project", async () => {
  await resizeWindow(1440, 920);
  await expect(page.getByText("Local service ready", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Local", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Bring a project into focus." })).toBeVisible();
  await expect(page.getByText("Getting Started", { exact: true })).toHaveCount(0);
  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await expect(sidebar.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Work", exact: true }).click();
  await expect(sidebar.getByText("No projects yet", { exact: true })).toHaveCount(1);
  await expect(sidebar.getByText("No work yet", { exact: true })).toHaveCount(0);
  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Projects", exact: true }).click();

  await electronApp.evaluate(({ dialog }, directory) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [directory],
      bookmarks: [],
    }));
  }, workspaceDirectory);
  await page.getByRole("button", { name: "Add your first project" }).click();
  await expect(page.getByRole("heading", {
    name: "What should we work on?",
    level: 3,
  })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Environment" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Environment" })).toBeVisible();
  await expect(page.getByLabel("Terminal panel")).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);

  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const conversationCount = (): number => {
    const database = new Database(databasePath);
    const row = database.prepare("SELECT COUNT(*) AS count FROM conversations")
      .get() as { count: number };
    database.close();
    return row.count;
  };
  expect(conversationCount()).toBe(0);

  await selectWorkspaceTool(page.locator(".workspace-panel"), "Terminal");
  await expect(page.getByLabel("Terminal panel").first()).toBeVisible();
  expect(conversationCount()).toBe(0);
  await page.locator(".workspace-panel")
    .getByRole("button", { name: "Close workspace tools" })
    .click();

  await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
  await expect.poll(conversationCount).toBe(1);
  await expect(page.getByLabel("Terminal panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Environment" }).click();
  await expect(page.getByRole("tab", { name: "Environment" })).toHaveAttribute("aria-selected", "true");
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Terminal");
  await expect(page.getByLabel("Terminal panel").first()).toBeVisible();
  const database = new Database(databasePath);
  const firstConversation = database.prepare(`
    SELECT provider_session_id, worktree_path
    FROM conversations
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as { provider_session_id: string | null; worktree_path: string | null };
  database.close();
  expect(firstConversation).toEqual({ provider_session_id: null, worktree_path: null });
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

test("keeps Send and Stop clear across submission, cancellation, theme, and scale states", async ({ browserName: _browserName }, testInfo) => {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const initialStore = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  const initialSnapshot = initialStore.shellSnapshot();
  const conversationId = initialSnapshot.activeConversationId;
  const originalSettings = initialSnapshot.settings;
  if (!conversationId) throw new Error("The Send and Stop test needs an active conversation.");
  const originalStatus = initialStore.conversation(conversationId).status;
  initialStore.updateSettings({ theme: "light", interfaceScale: "compact" });
  initialStore.updateConversation(conversationId, { status: "idle" });
  initialStore.close();

  const stopFrames: string[] = [];
  let collectStopFrames = true;
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      if (!collectStopFrames) return;
      const payload = typeof frame.payload === "string"
        ? frame.payload
        : frame.payload.toString();
      if (payload.includes('"agent.stop"')) stopFrames.push(payload);
    });
  });

  const capture = async (label: string): Promise<void> => {
    const path = testInfo.outputPath(`${label}.png`);
    await page.screenshot({ animations: "disabled", path });
    await testInfo.attach(label, { path, contentType: "image/png" });
  };

  try {
    await resizeWindow(1440, 920);
    await page.reload();
    const composer = page.getByRole("region", { name: "Message composer" });
    const textbox = composer.getByRole("textbox", { name: "Message" });
    const disabledSend = composer.getByRole("button", { name: "Send message" });
    await expect(textbox).toBeVisible();
    await expectComposerEndsAtDock(composer);
    await expect(disabledSend).toBeDisabled();
    await expect(disabledSend).toHaveAttribute(
      "data-composer-action-state",
      "send-disabled",
    );
    const disabledStyle = await disabledSend.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
        filter: style.filter,
        opacity: style.opacity,
      };
    });
    expect(disabledStyle.boxShadow).toBe("none");
    expect(disabledStyle.filter).toBe("none");
    expect(Number(disabledStyle.opacity)).toBeLessThan(1);

    await textbox.fill("First line");
    await textbox.press("Shift+Enter");
    await textbox.type("Second line");
    await expect(textbox).toHaveValue("First line\nSecond line");
    const readySend = composer.getByRole("button", { name: "Send message" });
    await expect(readySend).toBeEnabled();
    await expect(readySend).toHaveAttribute(
      "data-composer-action-state",
      "send-ready",
    );
    const readyGeometry = await readySend.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        width: bounds.width,
        height: bounds.height,
        borderRadius: style.borderRadius,
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
        filter: style.filter,
      };
    });
    expect(readyGeometry.width).toBe(readyGeometry.height);
    expect(readyGeometry.width).toBeGreaterThanOrEqual(28);
    expect(readyGeometry.borderRadius).toBe("50%");
    await expect.poll(() => readySend.evaluate((button) =>
      getComputedStyle(button).backgroundColor)).not.toBe(
      disabledStyle.background,
    );
    expect(readyGeometry.boxShadow).toBe("none");
    expect(readyGeometry.filter).toBe("none");
    await expect(textbox).toBeFocused();
    await capture("composer-send-ready-light-compact-1440x920");

    await textbox.press("Enter");
    const submitting = composer.getByRole("button", {
      name: "Sending message",
    });
    await expect(submitting).toBeVisible();
    await expect(submitting).toBeDisabled();
    await expect(submitting).toHaveAttribute(
      "data-composer-action-state",
      "submitting",
    );
    await expect(composer).toHaveAttribute("aria-busy", "true");
    await expect(textbox).toBeFocused();
    expect(await textbox.evaluate((element) =>
      (element as HTMLTextAreaElement).readOnly)).toBe(true);
    await expect(composer.locator(".loading-mark")).toHaveCount(1);
    await expectComposerEndsAtDock(composer);
    expect(await composer.locator(".usage-context-ring").evaluateAll((rings) =>
      rings.reduce((count, ring) =>
        count + ring.getAnimations({ subtree: true }).length, 0))).toBe(0);
    await page.waitForTimeout(350);
    await expect(submitting).toBeVisible();
    await expect(composer.getByRole("button", { name: "Send message" }))
      .toHaveCount(0);
    await expect(
      page.getByLabel("Thread transcript").getByText(/First line\s+Second line/u),
    ).toBeVisible();
    await capture("composer-send-submitting-light-compact-1440x920");
    await expect(composer.getByRole("button", { name: "Send message" }))
      .toBeVisible({ timeout: 5_000 });

    const darkIdleStore = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    darkIdleStore.updateSettings({ theme: "dark", interfaceScale: "large" });
    darkIdleStore.updateConversation(conversationId, { status: "idle" });
    darkIdleStore.close();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-interface-scale",
      "large",
    );
    const darkComposer = page.getByRole("region", { name: "Message composer" });
    const darkSend = darkComposer.getByRole("button", { name: "Send message" });
    await expect(darkSend).toBeVisible();
    const darkSendGeometry = await darkSend.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    await capture("composer-send-disabled-dark-large-1440x920");

    const runningStore = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    runningStore.updateConversation(conversationId, { status: "running" });
    runningStore.close();
    await resizeWindow(1180, 720);
    await page.reload();
    const runningComposer = page.getByRole("region", {
      name: "Message composer",
    });
    const stop = runningComposer.getByRole("button", { name: "Stop agent" });
    await expect(stop).toBeVisible();
    await expectComposerEndsAtDock(runningComposer);
    await expect(stop).toHaveAttribute(
      "data-composer-action-state",
      "stop-ready",
    );
    await expect(runningComposer.getByRole("button", { name: "Send message" }))
      .toHaveCount(0);
    await expect(runningComposer.locator(".loading-mark")).toHaveCount(0);
    await expect(stop.locator("rect")).toHaveCount(1);
    const stopGeometry = await stop.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        width: bounds.width,
        height: bounds.height,
        borderRadius: style.borderRadius,
        color: style.color,
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
      };
    });
    expect({
      width: stopGeometry.width,
      height: stopGeometry.height,
    }).toEqual({
      width: darkSendGeometry.width,
      height: darkSendGeometry.height,
    });
    expect(stopGeometry.width).toBe(stopGeometry.height);
    expect(stopGeometry.width).toBeGreaterThanOrEqual(36);
    expect(stopGeometry.borderRadius).toBe("50%");
    expect(stopGeometry.boxShadow).toBe("none");
    await expectNoViewportOverflow();
    await capture("composer-stop-dark-large-split-1180x720");

    await resizeWindow(560, 700);
    await expect(stop).toBeVisible();
    await expectComposerEndsAtDock(runningComposer);
    expect(await runningComposer.evaluate((element) =>
      element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expectNoViewportOverflow();
    await capture("composer-stop-dark-large-narrow-560x700");

    await stop.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(page.getByRole("alert")).toContainText(
      "This thread does not have an active run.",
    );
    await expect(stop).toBeEnabled();
    await expect(stop).toHaveAttribute(
      "data-composer-action-state",
      "stop-ready",
    );
    expect(stopFrames).toHaveLength(1);
  } finally {
    collectStopFrames = false;
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    cleanup.updateSettings({
      theme: originalSettings.theme,
      interfaceScale: originalSettings.interfaceScale,
    });
    cleanup.updateConversation(conversationId, { status: originalStatus });
    cleanup.close();
    await resizeWindow(1440, 920);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
      timeout: 10_000,
    });
  }
  expect(rendererErrors).toEqual([]);
});

test("previews, validates, removes, and cleans up secure composer attachments", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  await electronApp.evaluate(({ dialog }, paths) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: paths,
      bookmarks: [],
    }));
  }, [attachmentImagePath, attachmentDocumentPath]);

  await page.getByRole("button", { name: "Attach images or documents" }).click();
  const attachments = page.getByRole("list", { name: "Attachments" });
  await expect(attachments.getByText("preview.png", { exact: true })).toBeVisible();
  await expect(attachments.getByText("notes.pdf", { exact: true })).toBeVisible();
  await expect(attachments.getByText("PNG image · 68 B", { exact: true })).toBeVisible();
  await expect(attachments.getByText("PDF document · 35 B", { exact: true })).toBeVisible();
  const chosenPreview = attachments.locator("img");
  await expect(chosenPreview).toHaveCount(1);
  await expect.poll(() => chosenPreview.evaluate((element) => {
    const image = element as HTMLImageElement;
    const source = image.currentSrc || image.src;
    return {
      complete: image.complete,
      width: image.naturalWidth,
      scheme: new URL(source).protocol,
      host: new URL(source).host,
    };
  })).toEqual({
    complete: true,
    width: 1,
    scheme: "inertia:",
    host: "bundle",
  });
  const chosenPreviewSource = await chosenPreview.getAttribute("src");
  expect(chosenPreviewSource).toMatch(
    /^inertia:\/\/bundle\/attachment-preview\/[0-9a-f-]{36}$/u,
  );
  const untrustedHostStatus = await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    chosenPreviewSource!.replace("inertia://bundle/", "inertia://untrusted/"),
  );
  expect(untrustedHostStatus).toBe(404);
  expect(chosenPreviewSource).not.toContain(testDirectory);
  expect(await page.locator(".composer").textContent()).not.toContain(testDirectory);
  await expect(page.getByText(
    /Document preview is available, but this route cannot read/u,
  )).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

  await resizeWindow(520, 720);
  const attachmentBounds = await attachments.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return {
      right: bounds.right,
      viewport: window.innerWidth,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    };
  });
  expect(attachmentBounds.right).toBeLessThanOrEqual(attachmentBounds.viewport + 1);
  expect(attachmentBounds.clientHeight).toBeLessThanOrEqual(152);
  expect(attachmentBounds.scrollHeight).toBeGreaterThanOrEqual(attachmentBounds.clientHeight);
  await resizeWindow(1440, 920);
  const screenshotPath = testInfo.outputPath("secure-attachments-1440x920.png");
  await page.screenshot({ animations: "disabled", path: screenshotPath });
  await testInfo.attach("secure-attachments-1440x920", {
    path: screenshotPath,
    contentType: "image/png",
  });

  await attachments.getByRole("button", { name: "Remove attachment notes.pdf" }).click();
  await expect(attachments.getByText("notes.pdf", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

  const chosenId = chosenPreviewSource?.split("/").at(-1);
  expect(chosenId).toBeTruthy();
  const selectedTempPath = await stagedAttachmentPath(chosenId, "png");
  await expect.poll(async () => stat(selectedTempPath).then(() => true, () => false)).toBe(true);
  const selectedBytes = await readFile(selectedTempPath);
  const sameSizeReplacement = Buffer.from(selectedBytes);
  const replacementIndex = sameSizeReplacement.length - 1;
  sameSizeReplacement[replacementIndex] =
    sameSizeReplacement[replacementIndex]! ^ 0x01;
  await writeFile(selectedTempPath, sameSizeReplacement);
  const replacedPreviewStatus = await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    chosenPreviewSource!,
  );
  expect(replacedPreviewStatus).toBe(404);
  await writeFile(selectedTempPath, selectedBytes);
  const restoredPreviewStatus = await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    chosenPreviewSource!,
  );
  expect(restoredPreviewStatus).toBe(200);
  await page.getByRole("textbox", { name: "Message" }).fill("Inspect the selected image.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(attachments).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach images or documents" }))
    .toBeEnabled({ timeout: 5_000 });
  // Accepted turns retain their privileged copy while provider execution may
  // still be reading it.
  await expect.poll(async () => stat(selectedTempPath).then(() => true, () => false)).toBe(true);

  const imageBytes = [...await readFile(attachmentImagePath)];
  await page.getByRole("textbox", { name: "Message" }).evaluate((textarea, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    textarea.dispatchEvent(event);
  }, imageBytes);
  await expect(attachments.getByText("pasted.png", { exact: true })).toBeVisible();
  await expect(attachments.locator("img")).toHaveCount(1);
  const pastedSource = await attachments.locator("img").getAttribute("src");
  const pastedId = pastedSource?.split("/").at(-1);
  const pastedTempPath = await stagedAttachmentPath(pastedId, "png");
  await attachments.getByRole("button", { name: "Remove attachment pasted.png" }).click();
  await expect.poll(async () => stat(pastedTempPath).then(() => true, () => false)).toBe(false);

  const documentBytes = [...await readFile(attachmentDocumentPath)];
  await page.locator(".composer").evaluate((composer, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "dropped.pdf", { type: "application/pdf" }));
    composer.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, documentBytes);
  await expect(attachments.getByText("dropped.pdf", { exact: true })).toBeVisible();
  await expect(attachments.getByText("PDF document · 35 B", { exact: true })).toBeVisible();
  await attachments.getByRole("button", { name: "Remove attachment dropped.pdf" }).click();

  await electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, malformedAttachmentPath);
  await page.getByRole("button", { name: "Attach images or documents" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Attachment content does not match its safe file type.",
  );
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(attachments).toHaveCount(0);

  await electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, attachmentImagePath);
  await page.getByRole("button", { name: "Attach images or documents" }).click();
  const unsentSource = await attachments.locator("img").getAttribute("src");
  const unsentId = unsentSource?.split("/").at(-1);
  const unsentTempPath = await stagedAttachmentPath(unsentId, "png");
  await expect.poll(async () => stat(unsentTempPath).then(() => true, () => false)).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.poll(async () => stat(unsentTempPath).then(() => true, () => false)).toBe(false);
  await page.getByRole("button", { name: "Go to workspace" }).click();

  expect(rendererErrors).toEqual([]);
});

test("opens a settled chat directly and does not redirect when Work filters hide it", async () => {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const database = new Database(databasePath);
  const active = database.prepare(
    "SELECT active_conversation_id FROM app_state WHERE id = 1",
  ).get() as { active_conversation_id: string };
  const settledAt = new Date().toISOString();
  database.prepare(`
    UPDATE conversations
    SET title = 'Settled direct-open', settled_at = ?, updated_at = ?
    WHERE id = ?
  `).run(settledAt, settledAt, active.active_conversation_id);
  database.close();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Settled direct-open", level: 1 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByText("Start with a clear chat.")).toHaveCount(0);

  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settled direct-open", level: 1 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Projects", exact: true }).click();

  const restored = new Database(databasePath);
  restored.prepare(`
    UPDATE conversations
    SET title = 'New chat', settled_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), active.active_conversation_id);
  restored.close();
  await page.reload();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("keeps every ordinary New chat entry point isolated from the viewed chat", async ({ browserName: _browserName }, testInfo) => {
  type ConversationRow = {
    id: string;
    provider_id: string;
    model: string;
    reasoning_effort: string;
    interaction_mode: string;
    access_mode: string;
    branch: string | null;
    worktree_path: string | null;
    provider_session_id: string | null;
  };

  const expectIsolatedConversation = async (previousCount: number): Promise<void> => {
    await expect.poll(() => {
      const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
      const count = (database.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count;
      database.close();
      return count;
    }).toBe(previousCount + 1);

    const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
    const defaults = database.prepare(`
      SELECT
        default_provider,
        default_model,
        default_reasoning_effort,
        default_interaction_mode,
        default_access_mode
      FROM app_state
      WHERE id = 1
    `).get() as {
      default_provider: string;
      default_model: string;
      default_reasoning_effort: string;
      default_interaction_mode: string;
      default_access_mode: string;
    };
    const conversation = database.prepare(`
      SELECT
        conversations.id, provider_id, model, reasoning_effort, interaction_mode, access_mode,
        branch, worktree_path, provider_session_id
      FROM conversations
      JOIN app_state ON app_state.active_conversation_id = conversations.id
      WHERE app_state.id = 1
    `).get() as ConversationRow;
    const messageCount = (database.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversation.id) as { count: number }).count;
    const turnTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_turns'").get();
    const turnCount = turnTable
      ? (database.prepare("SELECT COUNT(*) AS count FROM agent_turns WHERE conversation_id = ?").get(conversation.id) as { count: number }).count
      : 0;
    database.close();

    expect(conversation).toMatchObject({
      provider_id: defaults.default_provider,
      model: defaults.default_model,
      reasoning_effort: defaults.default_reasoning_effort,
      interaction_mode: defaults.default_interaction_mode,
      access_mode: defaults.default_access_mode,
      worktree_path: null,
      provider_session_id: null,
    });
    expect(conversation.branch).not.toBe("viewed/branch");
    expect(messageCount).toBe(0);
    expect(turnCount).toBe(0);
  };

  let count = await seedViewedConversationContext(
    page,
    testDirectory,
    workspaceDirectory,
  );
  const contextTrigger = page.getByRole("button", { name: /Checkout context differs/u });
  await expect(contextTrigger).toBeVisible();
  await contextTrigger.click();
  const branchMenu = page.getByRole("menu", { name: "Branches" });
  await expect(branchMenu.getByRole("status").getByText("Chat and checkout differ")).toBeVisible();
  await expect(branchMenu.getByText("This chat was saved on")).toBeVisible();
  await expect(branchMenu.getByRole("menuitem", { name: "New chat in this worktree" })).toBeVisible();
  await expect(branchMenu.getByRole("menuitem", { name: "New chat in new isolated worktree" })).toBeVisible();
  await contextTrigger.click();

  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
  await expectIsolatedConversation(count);
  const currentBranch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: workspaceDirectory })).stdout.trim();
  const workspaceHeader = page.locator(".workspace-header");
  await expect(workspaceHeader.getByRole("button", {
    name: /Checkout context differs/u,
  })).toHaveCount(0);
  const currentBranchTrigger = workspaceHeader.getByRole("button", {
    name: currentBranch,
    exact: true,
  });
  await currentBranchTrigger.click();
  await expect(page.getByRole("menu", { name: "Branches" }).getByRole("menuitem", { name: `New chat on ${currentBranch}` })).toBeVisible();
  await currentBranchTrigger.click();

  count = await seedViewedConversationContext(
    page,
    testDirectory,
    workspaceDirectory,
  );
  const projectQuickChat = sidebar.getByRole("button", { name: "New chat in Inertia", exact: true });
  await expect(projectQuickChat).toHaveCSS("opacity", "0");
  await projectQuickChat.locator("xpath=..").hover();
  await expect(projectQuickChat).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("project-row-quick-chat.png") });
  await page.mouse.move(800, 400);
  await expect(projectQuickChat).toHaveCSS("opacity", "0");
  await projectQuickChat.focus();
  await expect(projectQuickChat).toBeFocused();
  await expect(projectQuickChat).toHaveCSS("opacity", "1");
  await projectQuickChat.click();
  await expectIsolatedConversation(count);
  await expect(sidebar.getByLabel("Inertia threads")).toBeVisible();
  await expect(sidebar.getByRole("menu", { name: "Project actions for Inertia" })).toHaveCount(0);

  count = await seedViewedConversationContext(
    page,
    testDirectory,
    workspaceDirectory,
  );
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const palette = page.getByRole("dialog", { name: "Search Inertia" });
  await palette.locator('[id="palette-action:new-thread"]').click();
  await expectIsolatedConversation(count);

  count = await seedViewedConversationContext(
    page,
    testDirectory,
    workspaceDirectory,
  );
  await page.keyboard.press(process.platform === "darwin" ? "Meta+N" : "Control+N");
  await expectIsolatedConversation(count);
  expect(rendererErrors).toEqual([]);
});

test("keeps the window alive and reconnects with a rotated capability after a runtime crash", async () => {
  await expect.poll(
    async () => (await runtimeSnapshot()).phase,
    { timeout: 15_000 },
  ).toBe("ready");
  const before = await runtimeSnapshot();
  const beforeUrl = await page.evaluate(() => window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-runtime-generation",
    /^[0-9a-f-]{36}$/iu,
  );
  const beforeRuntimeGeneration = await page.locator(".app-shell").getAttribute("data-runtime-generation");
  expect(beforeRuntimeGeneration).toMatch(/^[0-9a-f-]{36}$/iu);
  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
  await selectWorkspaceTool(
    page.getByRole("complementary", { name: "Workspace tools" }),
    "Terminal",
  );
  const terminal = page.locator("aside.terminal-panel").first();
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  const beforeTerminalId = await terminal.getAttribute("data-terminal-id");
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
  const conversation = database.prepare(`
    SELECT conversations.id
    FROM conversations
    JOIN app_state ON app_state.active_conversation_id = conversations.id
    WHERE app_state.id = 1
  `).get() as { id: string };
  database.prepare("UPDATE conversations SET status = 'running' WHERE id = ?").run(conversation.id);
  database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?)")
    .run(
      randomUUID(),
      conversation.id,
      "# Timeline response\n\n```ts file=src/timeline.ts\nconst ready: boolean = true;\n```\n\n| Check | State |\n| --- | --- |\n| Renderer | ready |\n\n<script>window.__unsafeMarkdown = true</script>",
      new Date(Date.now() - 1_000).toISOString(),
    );
  database.prepare("INSERT INTO activities (id, conversation_id, run_id, kind, title, detail, status, created_at) VALUES (?, ?, ?, 'command', 'Interrupted E2E command', NULL, 'running', ?)")
    .run(randomUUID(), conversation.id, "e2e-interrupted-run", new Date().toISOString());
  database.close();
  await page.evaluate(() => { Reflect.set(window, "__inertiaNoReloadMarker", crypto.randomUUID()); });
  const marker = await page.evaluate(() => Reflect.get(window, "__inertiaNoReloadMarker") as string);

  const crashed = await electronApp.evaluate((_electron) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as { crash: () => RuntimeTestSnapshot } | undefined;
    if (!runtime) throw new Error("The test runtime supervisor is unavailable");
    return runtime.crash();
  });
  expect(crashed.pid).toBe(before.pid);

  await expect.poll(async () => {
    const current = await runtimeSnapshot();
    return current.phase === "ready" && current.generation > before.generation;
  }, { timeout: 10_000 }).toBe(true);
  const after = await runtimeSnapshot();
  const afterUrl = await page.evaluate(() => window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  expect(after.generation).toBeGreaterThan(before.generation);
  expect(after.pid).not.toBe(before.pid);
  expect(afterUrl).not.toBe(beforeUrl);
  await expect.poll(() => page.locator(".app-shell").getAttribute("data-runtime-generation"))
    .not.toBe(beforeRuntimeGeneration);
  expect(await page.evaluate(() => Reflect.get(window, "__inertiaNoReloadMarker"))).toBe(marker);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "New chat" }).first()).toBeEnabled();
  await expect(page.getByText("The previous run ended when Inertia closed. Send another message to continue.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline response", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Markdown" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__unsafeMarkdown"))).toBeUndefined();
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  expect(await terminal.getAttribute("data-terminal-id")).not.toBe(beforeTerminalId);
  await expect(page.getByRole("alert")).toHaveCount(0);
  if (before.pid) await expect.poll(() => processExists(before.pid as number), { timeout: 5_000 }).toBe(false);
});

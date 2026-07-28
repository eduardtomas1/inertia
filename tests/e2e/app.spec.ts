import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { DiffSelectionReviewAnswer } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import { nativeProviderMetadataScope } from "../../src/server/provider/metadata";
import {
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
} from "../../src/shared/claude-backend-profiles";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import {
  MAC_BRAND_MIN_CLEAR_GAP,
  MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH,
  MAC_TRAFFIC_LIGHT_POSITION,
} from "../../src/shared/window-chrome";
import { INTERFACE_SCALE_WILL_CHANGE_EVENT } from "../../src/renderer/src/utils/interfaceScale";
import { MODEL_FAVORITES_STORAGE_KEY } from "../../src/renderer/src/utils/modelFavorites";
import {
  expectComposerEndsAtDock,
  expectComposerReadinessContained,
  expectNoViewportOverflow as expectPageNoViewportOverflow,
} from "./support/layout-assertions";
import { selectionAnswerFixtureMarkup } from "./support/selection-answer-fixture";

const execFileAsync = promisify(execFile);

let electronApp: ElectronApplication;
let page: Page;
let testDirectory: string;
let workspaceDirectory: string;
let attachmentImagePath: string;
let attachmentDocumentPath: string;
let malformedAttachmentPath: string;
const rendererErrors: string[] = [];
let previewServer: Server;
let previewUrl: string;

interface RuntimeTestSnapshot {
  phase: string;
  generation: number;
  pid: number | null;
  websocketUrl: string | null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runtimeSnapshot(): Promise<RuntimeTestSnapshot> {
  const snapshot = await electronApp.evaluate((_electron) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as { snapshot: () => RuntimeTestSnapshot } | undefined;
    return runtime?.snapshot() ?? null;
  });
  if (!snapshot) throw new Error("The test runtime supervisor is unavailable");
  return snapshot;
}

async function resizeWindow(width: number, height: number): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await page.waitForTimeout(250);
}

async function expectNoViewportOverflow(): Promise<void> {
  await expectPageNoViewportOverflow(page);
}

test.beforeAll(async () => {
  previewServer = createServer((request, response) => {
    if (
      request.method === "POST"
      && request.url === "/backend-probe/v1/messages"
    ) {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({
            type: "message_start",
            message: {
              type: "message",
              model: "visual-primary-model-with-a-deliberately-long-identifier",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          })}`,
          "",
          `data: ${JSON.stringify({
            type: "message_delta",
            usage: { output_tokens: 1 },
          })}`,
          "",
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          "",
        ].join("\n"));
      }, 450);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
    response.end("<!doctype html><title>Inertia preview</title><style>body{font-family:sans-serif;padding:40px}</style><h1>Preview is ready</h1>");
  });
  await new Promise<void>((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
  const address = previewServer.address();
  if (!address || typeof address === "string") throw new Error("Preview test server did not start");
  previewUrl = `http://127.0.0.1:${address.port}/`;
  testDirectory = await mkdtemp(join(tmpdir(), "inertia-e2e-"));
  workspaceDirectory = join(testDirectory, "Inertia");
  await mkdir(workspaceDirectory, { recursive: true });
  attachmentImagePath = join(testDirectory, "preview.png");
  attachmentDocumentPath = join(testDirectory, "notes.pdf");
  malformedAttachmentPath = join(testDirectory, "malformed.png");
  await writeFile(
    attachmentImagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(
    attachmentDocumentPath,
    Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii"),
  );
  await writeFile(
    malformedAttachmentPath,
    Buffer.from("%PDF-1.7\n%%EOF\n", "ascii"),
  );
  await Promise.all([
    mkdir(join(workspaceDirectory, "docs")),
    mkdir(join(workspaceDirectory, "empty-folder")),
    mkdir(join(workspaceDirectory, "src", "components", "deep"), { recursive: true }),
  ]);
  await writeFile(join(workspaceDirectory, "sample.ts"), "export const version = '0.0.1';\n", "utf8");
  await Promise.all([
    writeFile(join(workspaceDirectory, "docs", "guide.md"), "# Guide\n", "utf8"),
    writeFile(join(workspaceDirectory, "src", "index.ts"), "export * from './components/Button';\n", "utf8"),
    writeFile(join(workspaceDirectory, "src", "components", "Button.tsx"), "export const Button = () => <button>Ready</button>;\n", "utf8"),
    writeFile(join(workspaceDirectory, "src", "components", "deep", "CaseSensitiveLeaf.ts"), "export const leaf = true;\n", "utf8"),
  ]);
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["add", "."], { cwd: workspaceDirectory });
  await execFileAsync("git", ["-c", "user.name=Inertia", "-c", "user.email=test@inertia.local", "commit", "-qm", "fixture"], { cwd: workspaceDirectory });
  await writeFile(join(workspaceDirectory, "sample.ts"), "export const version = '0.0.1';\nexport const ready = true;\n", "utf8");
  electronApp = await electron.launch({
    args: [".", `--user-data-dir=${join(testDirectory, "electron-profile")}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: join(testDirectory, "data"),
      INERTIA_WORKSPACE_DIR: workspaceDirectory,
    },
  });
  page = await electronApp.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.getByRole("button", { name: "Add your first project" }).waitFor();
});

test.afterAll(async () => {
  await page?.evaluate(() => window.inertia.previewClose()).catch(() => undefined);
  previewServer?.closeAllConnections();
  await new Promise<void>((resolve) => previewServer?.close(() => resolve()));
  const runtimePid = (await runtimeSnapshot().catch(() => null))?.pid ?? null;
  await electronApp?.close();
  if (runtimePid) await expect.poll(() => processExists(runtimePid), { timeout: 5_000 }).toBe(false);
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
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
  await expect(page.getByRole("heading", { name: "Start with a clear chat." })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);
  await page.locator(".project-welcome").getByRole("button", { name: "New chat", exact: true }).click();

  await expect(page.getByLabel("Terminal panel").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
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

test("keeps Send and Stop clear across submission, cancellation, theme, and scale states", async ({}, testInfo) => {
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

test("previews, validates, removes, and cleans up secure composer attachments", async ({}, testInfo) => {
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
    "Document preview is available, but this route cannot read documents. Remove it before sending.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

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
  const selectedTempPath = join(
    await electronApp.evaluate(({ app }) => app.getPath("temp")),
    "inertia-attachments",
    `${chosenId}.png`,
  );
  await expect.poll(async () => stat(selectedTempPath).then(() => true, () => false)).toBe(true);
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
  const pastedTempPath = join(
    await electronApp.evaluate(({ app }) => app.getPath("temp")),
    "inertia-attachments",
    `${pastedId}.png`,
  );
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
  const unsentTempPath = join(
    await electronApp.evaluate(({ app }) => app.getPath("temp")),
    "inertia-attachments",
    `${unsentId}.png`,
  );
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

test("keeps every ordinary New chat entry point isolated from the viewed chat", async ({}, testInfo) => {
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

  const seedViewedContext = async (): Promise<number> => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
    const state = database.prepare("SELECT active_conversation_id FROM app_state WHERE id = 1").get() as { active_conversation_id: string };
    database.prepare(`
      UPDATE conversations
      SET
        provider_id = 'claude',
        model = 'viewed-model',
        reasoning_effort = 'viewed-effort',
        interaction_mode = 'plan',
        access_mode = 'full',
        branch = 'viewed/branch',
        worktree_path = ?,
        provider_session_id = 'viewed-provider-session'
      WHERE id = ?
    `).run(workspaceDirectory, state.active_conversation_id);
    const count = (database.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count;
    database.close();
    await page.reload();
    await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-runtime-generation",
      /^[0-9a-f-]{36}$/iu,
    );
    return count;
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

  let count = await seedViewedContext();
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

  count = await seedViewedContext();
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

  count = await seedViewedContext();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const palette = page.getByRole("dialog", { name: "Search Inertia" });
  await palette.locator('[id="palette-action:new-thread"]').click();
  await expectIsolatedConversation(count);

  count = await seedViewedContext();
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

test("navigates settings, changes theme, and returns to chat", async () => {
  const terminalPanel = page.locator("aside.terminal-panel").first();
  const terminalFontSize = await terminalPanel.getAttribute("data-terminal-font-size");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => {
    try {
      return JSON.parse(await readFile(join(testDirectory, "electron-profile", "window-appearance.json"), "utf8"));
    } catch {
      return null;
    }
  }).toEqual({ theme: "dark" });
  const nativeAppearance = await electronApp.evaluate(({ BrowserWindow, nativeTheme }) => ({
    background: BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? "",
    themeSource: nativeTheme.themeSource,
  }));
  expect(nativeAppearance.themeSource).toBe("dark");
  expect(nativeAppearance.background).toMatch(/^#101013(?:ff)?$/iu);
  await page.getByRole("radiogroup", { name: "Interface scale" }).getByRole("radio", { name: "Comfortable" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-interface-scale", "comfortable");
  await page.getByRole("radiogroup", { name: "Response density" }).getByRole("radio", { name: "Comfortable" }).click();
  await page.getByRole("switch", { name: "Wrap code by default" }).click();
  await expect(page.getByRole("switch", { name: "Wrap code by default" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Keybindings", exact: true }).click();
  await expect(page.getByText("Toggle project navigation", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Go to workspace" }).click();
  await expect(page.locator("aside.terminal-panel").first()).toHaveAttribute("data-terminal-font-size", terminalFontSize ?? "13");
  await expect(page.locator(".chat-workspace")).toHaveClass(/response-density-comfortable/u);
  await expect(page.locator(".response-code-block pre").first()).toHaveClass(/wraps/u);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this V1 clear and calm.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByLabel("Thread transcript").getByText("Keep this V1 clear and calm.", { exact: true }),
  ).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("manages backend profiles across the responsive theme and scale matrix", async ({}, testInfo) => {
  const openBackends = async (): Promise<void> => {
    await page.getByRole("button", { name: "Model backends", exact: true }).click();
    await expect(page.getByRole("heading", {
      name: "Model backends",
      exact: true,
      level: 2,
    })).toBeVisible();
    await expect(page.getByLabel("Model backend profiles")).toBeVisible();
  };
  const setAppearance = async (
    theme: "Light" | "Dark" | "System",
    scale: "Compact" | "Default" | "Large",
  ): Promise<void> => {
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("radio", { name: theme, exact: true }).click();
    await page.getByRole("radiogroup", { name: "Interface scale" })
      .getByRole("radio", { name: scale, exact: true })
      .click();
    await openBackends();
  };
  const expectBackendLayoutContained = async (): Promise<void> => {
    await expectNoViewportOverflow();
    const containment = await page.locator(".backend-settings-grid").evaluate((grid) => {
      const editor = grid.querySelector(".backend-profile-editor");
      const editorBounds = editor?.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      const workspaceHeader = document.querySelector(".workspace-header")
        ?.getBoundingClientRect();
      const newProfile = document.querySelector<HTMLButtonElement>(
        ".backend-settings-toolbar > button",
      );
      const textNode = [...(newProfile?.childNodes ?? [])].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      const textRange = textNode ? document.createRange() : null;
      if (textNode && textRange) textRange.selectNodeContents(textNode);
      return {
        gridWidth: gridBounds.width,
        gridRight: gridBounds.right,
        viewportRight: window.innerWidth,
        editorWidth: editorBounds?.width ?? 0,
        editorRight: editorBounds?.right ?? 0,
        workspaceHeader: workspaceHeader
          ? {
              top: workspaceHeader.top,
              bottom: workspaceHeader.bottom,
              width: workspaceHeader.width,
            }
          : null,
        newProfileTextLines: textRange?.getClientRects().length ?? 0,
        newProfileRight: newProfile?.getBoundingClientRect().right ?? 0,
      };
    });
    expect(containment.gridRight).toBeLessThanOrEqual(containment.viewportRight + 1);
    expect(containment.editorRight).toBeLessThanOrEqual(containment.gridRight + 1);
    expect(containment.editorWidth).toBeGreaterThan(0);
    expect(containment.workspaceHeader).not.toBeNull();
    expect(containment.workspaceHeader?.top).toBeGreaterThanOrEqual(0);
    expect(containment.workspaceHeader?.bottom).toBeGreaterThan(20);
    expect(containment.workspaceHeader?.width).toBeGreaterThan(200);
    expect(containment.newProfileTextLines).toBe(1);
    expect(containment.newProfileRight).toBeLessThanOrEqual(
      containment.gridRight + 1,
    );
  };

  await resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openBackends();
  const profileRail = page.getByLabel("Backend profiles");
  await expect(profileRail.getByText("OpenAI", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("Anthropic", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("Cursor", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("OpenCode", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("Kimi", { exact: true })).toBeVisible();
  await expect(profileRail.locator(".backend-profile-rail-item").filter({
    hasText: /^OpenAI/u,
  }).locator(".backend-profile-dot")).toHaveClass(/is-ready/u);
  await expect(profileRail.locator(".backend-profile-rail-item").filter({
    hasText: /^Kimi/u,
  }).locator(".backend-profile-dot")).not.toHaveClass(/is-ready/u);
  await profileRail.getByText("Kimi", { exact: true }).click();
  await expect(page.getByText("Backend credential", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Add credential")).toBeVisible();

  const appearances = [
    { theme: "Light", scale: "Compact", slug: "light-compact" },
    { theme: "Dark", scale: "Default", slug: "dark-default" },
    { theme: "System", scale: "Large", slug: "system-large" },
  ] as const;
  const layouts = [
    { width: 1440, height: 920, slug: "wide" },
    { width: 900, height: 760, slug: "medium" },
    { width: 760, height: 760, slug: "narrow-760" },
  ] as const;
  for (const appearance of appearances) {
    await setAppearance(appearance.theme, appearance.scale);
    for (const layout of layouts) {
      await resizeWindow(layout.width, layout.height);
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(viewport.width).toBeGreaterThanOrEqual(layout.width - 32);
      expect(viewport.width).toBeLessThanOrEqual(layout.width);
      expect(viewport.height).toBeGreaterThanOrEqual(600);
      expect(viewport.height).toBeLessThanOrEqual(layout.height);
      await expectBackendLayoutContained();
      await page.screenshot({
        path: testInfo.outputPath(
          `model-backends-${appearance.slug}-${layout.slug}-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
  }

  await resizeWindow(760, 760);
  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(
    "Visual gateway with an intentionally long profile name for truncation",
  );
  await page.locator(".backend-form-section").nth(1).locator("select").selectOption("none");
  await page.getByLabel("Base URL", { exact: true }).fill(`${previewUrl}backend-probe`);
  await page.getByRole("switch", { name: "Allow localhost HTTP" }).click();
  const modelId = page.getByLabel("Model ID", { exact: true });
  await modelId.first().fill(
    "visual-primary-model-with-a-deliberately-long-identifier",
  );
  await page.getByLabel("Display name", { exact: true }).first().fill(
    "Visual primary model with a deliberately long readable name",
  );
  await page.getByRole("button", { name: "Add model" }).click();
  await modelId.nth(1).fill(
    "visual-secondary-model-with-an-even-longer-deliberately-overflowing-identifier",
  );
  await page.getByLabel("Display name", { exact: true }).nth(1).fill(
    "Visual secondary model with a very long readable name",
  );
  await page.getByRole("button", {
    name: "Remove Visual secondary model with a very long readable name",
  }).click();
  await expect(modelId).toHaveCount(1);
  await page.getByRole("button", { name: "Add model" }).click();
  await modelId.nth(1).fill(
    "visual-secondary-model-with-an-even-longer-deliberately-overflowing-identifier",
  );
  await page.getByLabel("Display name", { exact: true }).nth(1).fill(
    "Visual secondary model with a very long readable name",
  );
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.locator(".backend-tier-grid:not(.backend-primary-model) select")
    .first()
    .selectOption(
    "visual-secondary-model-with-an-even-longer-deliberately-overflowing-identifier",
    );
  await expectBackendLayoutContained();
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-editor-long-values.png"),
  });
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByText("Visual gateway with an intentionally long profile name for truncation", { exact: true }).first()).toBeVisible();
  const enable = page.getByRole("switch", {
    name: "Enable Visual gateway with an intentionally long profile name for truncation",
  });
  await expect(enable).toHaveAttribute("aria-checked", "false");

  const probe = page.getByRole("button", { name: "Test connection" });
  await probe.click();
  await expect(page.getByRole("button", { name: "Testing…" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-probe-loading.png"),
  });
  await expect(page.locator(".backend-status-strip").getByText("limited", {
    exact: true,
  })).toBeVisible();
  await expect(probe).toBeVisible();
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Partial", { exact: true }).first()).toBeVisible();
  const globalDefault = page.getByRole("combobox", {
    name: "Global default",
    exact: true,
  });
  await globalDefault.selectOption({
    label: "Claude harness · Visual gateway with an intentionally long profile name for truncation · Visual primary model with a deliberately long readable name",
  });
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    const count = (database.prepare(`
      SELECT COUNT(*) AS count
      FROM model_backend_defaults
      WHERE scope = 'global'
    `).get() as { count: number }).count;
    database.close();
    return count;
  }).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-probe-success-enabled.png"),
  });

  await page.getByRole("button", { name: "Edit configuration" }).click();
  await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:1/backend-probe");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(enable).toHaveAttribute("aria-checked", "false");
  await expect(globalDefault).toHaveValue("");
  await probe.click();
  await expect(page.locator(".backend-status-strip").getByText("failed", {
    exact: true,
  })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-probe-failure-disabled.png"),
  });

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "Delete permanently" })).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(profileRail.getByText(
    "Visual gateway with an intentionally long profile name for truncation",
    { exact: true },
  )).toHaveCount(0);
  await expectBackendLayoutContained();
  await resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("changes the visible theme on every quick-toggle click", async () => {
  const html = page.locator("html");
  const themeTrigger = page.getByRole("button", { name: /^Change theme \(current:/ });

  for (let click = 0; click < 3; click += 1) {
    const before = await html.getAttribute("data-theme");
    await themeTrigger.click();
    await expect.poll(() => html.getAttribute("data-theme")).not.toBe(before);
  }

  expect(rendererErrors).toEqual([]);
});

test("keeps runtime support and application update checks explicit in settings", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Archive & data", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local data" })).toBeVisible();
  await expect(page.getByText("Local-only lifecycle and failure metadata.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Copy support summary" }).click();
  await expect(page.getByText("Private support summary copied", { exact: false })).toBeVisible();
  const supportSummary = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  expect(supportSummary).toContain("Inertia support summary");
  expect(supportSummary).toContain("Privacy: prompts, source, project paths");
  expect(supportSummary).not.toContain(workspaceDirectory);
  expect(supportSummary).not.toContain("sample.ts");
  await page.getByRole("button", { name: "Reveal log folder" }).click();
  await expect(page.getByText("Runtime log folder opened.", { exact: true })).toBeVisible();

  const logDirectory = join(testDirectory, "electron-profile", "logs", "runtime");
  await expect.poll(async () => (await stat(logDirectory)).isDirectory()).toBe(true);
  if (process.platform !== "win32") {
    expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
  }
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Application updates" })).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Inertia is up to date.", { exact: true })).toBeVisible();
  await expect(page.getByText("Install", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("persists composer usage modes without losing the followed transcript", async ({}, testInfo) => {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const usageDatabase = new Database(databasePath, { readonly: true });
  const usageState = usageDatabase.prepare(
    "SELECT active_conversation_id FROM app_state WHERE id = 1",
  ).get() as { active_conversation_id: string };
  usageDatabase.close();
  const usageStore = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  usageStore.upsertUsage({
    conversationId: usageState.active_conversation_id,
    usedTokens: 85,
    totalProcessedTokens: 1_250,
    totalProcessedScope: "session",
    maxTokens: 100,
    inputTokens: 80,
    cachedInputTokens: 10,
    cacheWriteInputTokens: null,
    outputTokens: 5,
    reasoningOutputTokens: null,
    compactsAutomatically: null,
  });
  usageStore.updateSettings({
    theme: "light",
    interfaceScale: "default",
    responseDensity: "default",
  });
  usageStore.close();
  await page.reload();
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  await resizeWindow(1440, 920);
  const transcript = page.getByLabel("Thread transcript");
  const compact = page.getByRole("region", { name: "Usage and context" });
  await expect(compact).toHaveAttribute("data-mode", "compact");
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  await expect(compact).toHaveAttribute("data-context-state", "near-limit");
  await expect(compact.locator(".usage-context-ring")).toHaveAttribute("data-context-ring-state", "near-limit");
  const toolbarIntegration = await compact.evaluate((control) => {
    const toolbar = control.closest(".composer-toolbar");
    const options = control.parentElement;
    const next = control.nextElementSibling;
    return {
      inComposer: Boolean(control.closest(".composer")),
      inToolbar: Boolean(toolbar),
      parentClass: options?.className ?? "",
      nextLabel: next?.getAttribute("aria-label"),
      detachedUsageRows: document.querySelectorAll(".composer-shell > .composer-usage").length,
      toolbarUsageControls: toolbar?.querySelectorAll('[data-composer-control="usage"]').length ?? 0,
    };
  });
  expect(toolbarIntegration).toEqual({
    inComposer: true,
    inToolbar: true,
    parentClass: "composer-options",
    nextLabel: "Send message",
    detachedUsageRows: 0,
    toolbarUsageControls: 1,
  });
  const compactTrigger = compact.locator(".usage-popover-trigger");
  await expect(compactTrigger).toHaveAccessibleName(
    "Open usage and context. Context window 15% remaining, near limit.",
  );
  await expect(compactTrigger).toHaveAttribute(
    "title",
    "Context window 15% remaining, near limit.",
  );
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "false");
  const ringGeometry = await compact.locator(".usage-context-ring").evaluate((ring) => {
    const bounds = ring.getBoundingClientRect();
    const value = ring.querySelector<SVGCircleElement>(".usage-context-ring-value");
    return {
      width: bounds.width,
      height: bounds.height,
      animations: ring.getAnimations({ subtree: true }).length,
      strokeWidth: value ? getComputedStyle(value).strokeWidth : null,
    };
  });
  expect(ringGeometry.width).toBeGreaterThanOrEqual(23);
  expect(ringGeometry.width).toBeLessThanOrEqual(31);
  expect(ringGeometry.height).toBe(ringGeometry.width);
  expect(ringGeometry.animations).toBe(0);
  expect(ringGeometry.strokeWidth).toBe("1.65px");
  const sendWidth = await page.getByRole("button", { name: "Send message" }).evaluate(
    (button) => button.getBoundingClientRect().width,
  );
  expect(ringGeometry.width).toBeLessThan(sendWidth);
  const contextRingScreenshot = testInfo.outputPath(
    "context-ring-near-limit-1440x920.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: contextRingScreenshot,
    scale: "device",
  });
  await testInfo.attach("context-ring-near-limit-1440x920", {
    path: contextRingScreenshot,
    contentType: "image/png",
  });
  const compactControls = await compactTrigger.getAttribute("aria-controls");
  expect(compactControls).toBeTruthy();
  await expect(page.locator(`#${compactControls}`)).toBeHidden();
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });

  await compactTrigger.focus();
  await compactTrigger.press("Space");
  await expect(compact).toHaveAttribute("data-mode", "compact");
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(compactTrigger).toHaveAccessibleName(/^Close usage and context\./u);
  const compactPopover = page.getByRole("dialog", { name: "Usage & context" });
  await expect(compactPopover).toBeVisible();
  await expect(compactPopover.getByText("Context", { exact: true })).toBeVisible();
  await expect(compactPopover.getByText("Provider quota", { exact: true })).toBeVisible();
  const compactPopoverAx = await compactPopover.ariaSnapshot();
  expect(compactPopoverAx).toContain('- dialog "Usage & context"');
  expect(compactPopoverAx).toContain('- button "Close usage and context"');
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");

  const closeCompactUsage = compactPopover.getByRole("button", {
    name: "Close usage and context",
  });
  await closeCompactUsage.focus();
  await page.locator(".workspace-header").click({ position: { x: 12, y: 12 } });
  await expect(compactPopover).toBeHidden();
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(compactTrigger).toBeFocused();

  await compactTrigger.click();
  await expect(compactPopover).toBeVisible();
  await closeCompactUsage.focus();
  await page.keyboard.press("Escape");
  await expect(compactPopover).toBeHidden();
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(compactTrigger).toBeFocused();
  await expect.poll(() => transcript.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(2);

  await compactTrigger.click();
  const composerHeightWithUsage = await page.locator(".composer").evaluate(
    (composer) => composer.getBoundingClientRect().height,
  );
  await compactPopover.getByRole("button", { name: "Hide usage" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveCount(0);
  await expect(page.locator('.composer [data-composer-control="usage"]')).toHaveCount(0);
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  const composerHeightWithoutUsage = await page.locator(".composer").evaluate(
    (composer) => composer.getBoundingClientRect().height,
  );
  expect(Math.abs(composerHeightWithUsage - composerHeightWithoutUsage)).toBeLessThanOrEqual(1);
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("hidden");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const usageModes = page.getByRole("radiogroup", { name: "Usage and context display" });
  await expect(usageModes.getByRole("radio", { name: "Hidden" })).toHaveAttribute("aria-checked", "true");
  await usageModes.getByRole("radio", { name: "Expanded" }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  const expanded = page.getByRole("region", { name: "Usage and context" });
  await expect(expanded).toHaveAttribute("data-mode", "expanded");
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  await expect(expanded.locator(".usage-trigger-value")).toBeVisible();
  const expandedTrigger = expanded.locator(".usage-popover-trigger");
  await expect(expandedTrigger).toHaveAccessibleName(/^Open usage and context\./u);
  await expandedTrigger.click();
  await expect(page.getByRole("dialog", { name: "Usage & context" })).toBeVisible();
  const lightScreenshot = testInfo.outputPath("composer-usage-expanded-light-1440x920.png");
  await page.screenshot({ animations: "disabled", path: lightScreenshot });
  await testInfo.attach("composer-usage-expanded-light-1440x920", {
    path: lightScreenshot,
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");

  const darkStore = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  darkStore.updateSettings({
    theme: "dark",
    interfaceScale: "large",
    responseDensity: "comfortable",
  });
  darkStore.close();
  await page.reload();
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  await resizeWindow(760, 680);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-interface-scale", "large");
  await expect(page.locator(".chat-workspace")).toHaveClass(/response-density-comfortable/u);
  const narrowUsage = page.getByRole("region", { name: "Usage and context" });
  await expect(narrowUsage).toHaveAttribute("data-mode", "expanded");
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  const narrowGeometry = await narrowUsage.evaluate((control) => {
    const controlBounds = control.getBoundingClientRect();
    const toolbar = control.closest<HTMLElement>(".composer-toolbar");
    const toolbarBounds = toolbar?.getBoundingClientRect();
    const send = toolbar?.querySelector<HTMLElement>('[aria-label="Send message"]');
    const sendBounds = send?.getBoundingClientRect();
    return {
      inToolbar: Boolean(toolbar),
      controlRight: controlBounds.right,
      toolbarRight: toolbarBounds?.right ?? 0,
      centerDelta: sendBounds
        ? Math.abs(
            (controlBounds.top + controlBounds.height / 2)
            - (sendBounds.top + sendBounds.height / 2),
          )
        : Number.POSITIVE_INFINITY,
    };
  });
  expect(narrowGeometry.inToolbar).toBe(true);
  expect(narrowGeometry.controlRight).toBeLessThanOrEqual(narrowGeometry.toolbarRight + 1);
  expect(narrowGeometry.centerDelta).toBeLessThanOrEqual(1);
  await expectNoViewportOverflow();
  const darkNarrowScreenshot = testInfo.outputPath("composer-usage-expanded-dark-large-760x680.png");
  await page.screenshot({ animations: "disabled", path: darkNarrowScreenshot });
  await testInfo.attach("composer-usage-expanded-dark-large-760x680", {
    path: darkNarrowScreenshot,
    contentType: "image/png",
  });
  expect(rendererErrors).toEqual([]);
});

test("applies every interface scale live and remains usable at common Linux display scales", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  const terminalFontSize = await page.locator("aside.terminal-panel").first().getAttribute("data-terminal-font-size");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const scaleGroup = page.getByRole("radiogroup", { name: "Interface scale" });
  const expected = [
    ["Compact", "compact", "13px", "30px"],
    ["Default", "default", "14px", "32px"],
    ["Comfortable", "comfortable", "15px", "35px"],
    ["Large", "large", "16.5px", "38px"],
  ] as const;

  for (const [label, value, fontSize, controlHeight] of expected) {
    await scaleGroup.getByRole("radio", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-interface-scale", value);
    const measurements = await page.locator(".app-shell").evaluate((shell) => ({
      fontSize: getComputedStyle(shell).fontSize,
      controlHeight: getComputedStyle(document.documentElement).getPropertyValue("--ui-control-height").trim(),
    }));
    expect(measurements).toEqual({ fontSize, controlHeight });
  }

  for (const zoomFactor of [1, 1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoomFactor);
    await resizeWindow(1920, 1080);
    await expectNoViewportOverflow();
  }

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
  await resizeWindow(900, 720);
  await expectNoViewportOverflow();
  await expect(page.getByRole("button", { name: "Go to workspace" })).toBeVisible();
  await scaleGroup.getByRole("radio", { name: "Comfortable", exact: true }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  await expect(page.locator("aside.terminal-panel").first()).toHaveAttribute("data-terminal-font-size", terminalFontSize ?? "13");
  await expectNoViewportOverflow();
  const scaledDock = page.getByRole("region", { name: "Message composer" });
  for (const zoomFactor of [1, 1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoomFactor);
    await resizeWindow(1920, 1080);
    await expect(scaledDock.getByRole("button", {
      name: /^Choose model\./u,
    })).toBeVisible();
    await expect(scaledDock.getByRole("region", {
      name: "Usage and context",
    })).toBeVisible();
    await expect(scaledDock.getByRole("button", {
      name: "Send message",
    })).toBeVisible();
    const scaledGeometry = await scaledDock.evaluate((element) => {
      const toolbar = element.querySelector<HTMLElement>(".composer-toolbar");
      const model = element.querySelector<HTMLElement>(".selected-model-chip");
      const label = element.querySelector<HTMLElement>(
        ".selected-model-chip-label",
      );
      const send = element.querySelector<HTMLElement>(
        '[aria-label="Send message"]',
      );
      const toolbarBounds = toolbar?.getBoundingClientRect();
      const modelBounds = model?.getBoundingClientRect();
      const labelBounds = label?.getBoundingClientRect();
      const sendBounds = send?.getBoundingClientRect();
      return {
        dockFits: element.scrollWidth <= element.clientWidth + 1,
        toolbarFits: Boolean(
          toolbar
          && toolbar.scrollWidth <= toolbar.clientWidth + 1,
        ),
        modelLabelContained: Boolean(
          modelBounds
          && labelBounds
          && labelBounds.left >= modelBounds.left - 1
          && labelBounds.right <= modelBounds.right + 1,
        ),
        modelLabelOverflow: label
          ? getComputedStyle(label).overflow
          : "",
        sendContained: Boolean(
          toolbarBounds
          && sendBounds
          && sendBounds.left >= toolbarBounds.left - 1
          && sendBounds.right <= toolbarBounds.right + 1,
        ),
      };
    });
    expect(scaledGeometry).toEqual({
      dockFits: true,
      toolbarFits: true,
      modelLabelContained: true,
      modelLabelOverflow: "hidden",
      sendContained: true,
    });
    await expectNoViewportOverflow();
    if (zoomFactor === 1.25) {
      const shell = page.locator(".app-shell");
      const originalClassName = await shell.getAttribute("class") ?? "";
      await shell.evaluate((element) => {
        for (const className of [...element.classList]) {
          if (className.startsWith("platform-")) {
            element.classList.remove(className);
          }
        }
        element.classList.add("platform-linux");
      });
      await expect(shell).toHaveClass(/platform-linux/u);
      await expectNoViewportOverflow();
      const linuxScaleScreenshot = testInfo.outputPath(
        "linux-platform-scale-125-1920x1080.png",
      );
      await page.screenshot({
        animations: "disabled",
        path: linuxScaleScreenshot,
        scale: "device",
      });
      await testInfo.attach("linux-platform-scale-125-1920x1080", {
        path: linuxScaleScreenshot,
        contentType: "image/png",
      });
      await shell.evaluate((element, className) => {
        element.setAttribute("class", className);
      }, originalClassName);
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

test("switches between Projects and Work and manages chat history", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.getByRole("button", { name: "Project actions for Inertia" }).first().click();
  const projectMenu = sidebar.getByRole("menu", { name: "Project actions for Inertia" });
  await expect(projectMenu.getByRole("menuitem", { name: "Open folder" })).toBeVisible();
  await expect(projectMenu.getByRole("menuitem", { name: "New chat" })).toHaveCount(0);
  await expect(projectMenu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(projectMenu.getByText("Grouping behavior", { exact: true })).toBeVisible();
  await projectMenu.getByRole("menuitemradio", { name: "Keep separate", exact: true }).click();

  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Work", exact: true }).click();
  await expect(sidebar).toHaveClass(/sidebar-mode-activity/u);
  await expect(sidebar.getByRole("heading", { name: "Recent" })).toBeVisible();
  const activityCard = sidebar.locator(".activity-thread.is-card.is-active");
  const threadCard = activityCard.getByRole("button", { name: "New chat, Idle" });
  await expect(threadCard).toBeVisible();
  const relativeTime = activityCard.locator(".activity-thread-topline time");
  await expect(relativeTime).toHaveCSS("opacity", "1");
  await activityCard.hover();
  await expect(relativeTime).toHaveCSS("opacity", "1");

  const firstNavigationItem = sidebar.locator("[data-sidebar-nav]").first();
  await firstNavigationItem.focus();
  await firstNavigationItem.press("ArrowDown");
  expect(await firstNavigationItem.evaluate((item) => document.activeElement !== item)).toBe(true);

  await activityCard.getByRole("button", { name: "Thread actions for New chat" }).click();
  await sidebar.getByRole("menuitem", { name: "Done" }).click();
  await expect(sidebar.getByText("History", { exact: true })).toBeVisible();
  const historyCard = sidebar.locator(".activity-thread.is-history.is-active");
  await expect(historyCard.getByRole("button", { name: "New chat, Idle" })).toBeVisible();
  await historyCard.getByRole("button", { name: "Thread actions for New chat" }).click();
  await sidebar.getByRole("menuitem", { name: "Reopen" }).click();
  await expect(sidebar.locator(".activity-thread.is-card.is-active").getByRole("button", { name: "New chat, Idle" })).toBeVisible();

  await sidebar.locator(".sidebar-mode-switch").getByRole("button", { name: "Projects", exact: true }).click();
  await expect(sidebar).toHaveClass(/sidebar-mode-classic/u);
  expect(rendererErrors).toEqual([]);
});

test("uses the anchored model chooser and enforces authoritative route boundaries", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  if (await page.getByRole("textbox", { name: "Message" }).count() === 0) {
    await expect.poll(
      async () => (await runtimeSnapshot()).phase,
      { timeout: 10_000 },
    ).toBe("ready");
    await expect(
      page.getByRole("complementary", { name: "Project navigation", exact: true })
        .locator(".sidebar-mode-switch")
        .getByRole("button", { name: "Projects", exact: true }),
    ).toBeEnabled({ timeout: 10_000 });
    await electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, workspaceDirectory);
    const addProject = page.getByRole("button", { name: "Add your first project" });
    await expect(addProject).toBeEnabled();
    await addProject.click();
    await expect(page.getByRole("heading", { name: "Start with a clear chat." })).toBeVisible();
    const newChat = page.locator(".project-welcome")
      .getByRole("button", { name: "New chat", exact: true });
    await expect(newChat).toBeVisible();
    await newChat.click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  }
  const workspaceHeader = page.locator(".workspace-header");
  const closeTools = workspaceHeader.getByRole("button", { name: "Close workspace tools" });
  if (await closeTools.isVisible() && await closeTools.isEnabled()) {
    await closeTools.click();
  }
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@sam");
  await expect(page.getByRole("listbox", { name: "Project files" }).getByRole("option").first()).toHaveAttribute("aria-selected", "false");
  await composer.fill("/p");
  await expect(page.getByRole("listbox", { name: "Composer commands" }).getByRole("option", { name: /plan/i })).toHaveAttribute("aria-selected", "false");
  await composer.fill("");
  await resizeWindow(1440, 720);

  const modelTrigger = page.getByRole("button", { name: /^Choose model\./u });
  const modelChooser = page.getByRole("dialog", { name: "Choose model" });
  const captureChooserScenario = async (name: string): Promise<void> => {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      path: screenshotPath,
      scale: "device",
    });
    await testInfo.attach(name, {
      path: screenshotPath,
      contentType: "image/png",
    });
  };

  await modelTrigger.click();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
  const chooserId = await modelTrigger.getAttribute("aria-controls");
  expect(chooserId).toBeTruthy();
  await expect(modelChooser).toHaveAttribute("id", chooserId!);
  await expect(modelChooser).toBeVisible();
  await expect(modelChooser.getByRole("navigation", { name: "Model sources" })).toBeVisible();
  const modelResults = modelChooser.getByRole("listbox", {
    name: "Model results",
  });
  const modelResultsAx = await modelResults.ariaSnapshot();
  expect(modelResultsAx).toContain('- listbox "Model results"');
  expect(modelResultsAx).toContain("- option ");
  expect(modelResultsAx).toContain("[selected]");
  expect(modelResultsAx).not.toContain("- button ");
  const modelFavoriteActions = modelChooser.getByRole("group", {
    name: "Model favorite actions",
  });
  const modelFavoriteActionsAx = await modelFavoriteActions.ariaSnapshot();
  expect(modelFavoriteActionsAx).toContain(
    '- group "Model favorite actions"',
  );
  expect(modelFavoriteActionsAx).toContain('- button "Add ');
  expect(modelFavoriteActionsAx).not.toContain("- option ");
  const firstResult = modelChooser.locator(".model-chooser-result").first();
  await firstResult.evaluate((element) => {
    element.style.minHeight = "92px";
  });
  const rowCenters = await modelChooser.locator(".model-chooser-result")
    .evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    }));
  const favoriteCenters = await modelFavoriteActions.getByRole("button")
    .evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    }));
  expect(favoriteCenters).toHaveLength(rowCenters.length);
  for (const [index, center] of rowCenters.entries()) {
    expect(Math.abs(center - favoriteCenters[index]!)).toBeLessThanOrEqual(1);
  }
  await firstResult.evaluate((element) => {
    element.style.removeProperty("min-height");
  });
  const searchModels = modelChooser.getByRole("searchbox", { name: "Search models" });
  await expect(searchModels).toBeFocused();
  const codexSource = modelChooser.getByRole("button", {
    name: /^Codex, \d+ models?$/u,
  });
  await expect(codexSource).toHaveAttribute("aria-pressed", "true");
  const claudeSource = modelChooser.getByRole("button", {
    name: /^Claude, \d+ models?$/u,
  });
  await claudeSource.click();
  await expect(searchModels).toBeFocused();
  const initialActiveDescendant = await searchModels.getAttribute(
    "aria-activedescendant",
  );
  await page.keyboard.press("End");
  await expect.poll(() => searchModels.getAttribute("aria-activedescendant"))
    .not.toBe(initialActiveDescendant);
  await page.keyboard.press("Home");
  await expect(searchModels).toHaveAttribute(
    "aria-activedescendant",
    initialActiveDescendant!,
  );
  const [headerBounds, modelChooserBounds] = await Promise.all([
    workspaceHeader.boundingBox(),
    modelChooser.boundingBox(),
  ]);
  expect(modelChooserBounds?.y ?? 0).toBeGreaterThanOrEqual(
    (headerBounds?.y ?? 0) + (headerBounds?.height ?? 0),
  );
  expect((modelChooserBounds?.x ?? 0) + (modelChooserBounds?.width ?? 0))
    .toBeLessThanOrEqual(1440);

  await captureChooserScenario("anchored-model-chooser-1440x720");

  const firstFavorite = modelFavoriteActions.getByRole("button", {
    name: /^Add .+ to favorites$/u,
  }).first();
  await firstFavorite.click();
  await expect(modelFavoriteActions.getByRole("button", {
    name: /^Remove .+ from favorites$/u,
  }).first()).toHaveAttribute("aria-pressed", "true");
  const favoritesSource = modelChooser.getByRole("button", {
    name: /^Favorites, 1 model$/u,
  });
  await expect(favoritesSource).toBeVisible();
  await favoritesSource.click();
  await expect(modelChooser.getByRole("option")).toHaveCount(1);
  await captureChooserScenario("model-chooser-favorites-1440x720");
  await claudeSource.click();
  await expect(claudeSource).toHaveAttribute("aria-pressed", "true");
  await captureChooserScenario("model-chooser-claude-1440x720");
  await searchModels.fill("Kimi K3");
  await expect(modelChooser.getByRole("option").filter({ hasText: /Kimi/u }).first())
    .toBeVisible();
  await expect(modelChooser.getByRole("option").filter({ hasText: /Codex/u }))
    .toHaveCount(0);
  await captureChooserScenario("model-chooser-search-kimi-1440x720");
  await searchModels.fill("route-that-does-not-exist");
  await expect(modelChooser.getByText("No matching models", { exact: true })).toBeVisible();
  await searchModels.fill("");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+1" : "Control+1");
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
  await modelTrigger.focus();
  await modelTrigger.press("Escape");
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  await expect(modelChooser).toBeVisible();
  await page.locator(".workspace-header").click({ position: { x: 12, y: 12 } });
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  await expect(modelChooser.getByRole("searchbox", { name: "Search models" }))
    .toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  const modeTrigger = page.getByRole("button", { name: "Choose work mode" });
  const modeMenu = page.getByRole("menu", { name: "Work mode" });
  await modeTrigger.click();
  await expect(modelChooser).toBeHidden();
  await expect(modeMenu).toBeVisible();
  await expect(modeTrigger).toBeFocused();

  const currentMode = await modeTrigger.locator("span").first().textContent();
  const nextMode = currentMode === "Build" ? "Plan" : "Build";
  await modeMenu.getByRole("menuitemradio", { name: new RegExp(`^${nextMode}`) }).click();
  await expect(modeMenu).toBeHidden();
  await expect(modeTrigger).toBeFocused();
  await expect(modeTrigger.locator("span").first()).toHaveText(nextMode);

  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const stateDatabase = new Database(databasePath, { readonly: true });
  const state = stateDatabase.prepare(
    "SELECT active_conversation_id FROM app_state WHERE id = 1",
  ).get() as { active_conversation_id: string };
  const conversationCountBefore = (stateDatabase.prepare(
    "SELECT COUNT(*) AS count FROM conversations",
  ).get() as { count: number }).count;
  stateDatabase.close();

  const runtimeStore = new RuntimeStore(databasePath, workspaceDirectory);
  const currentConversation = runtimeStore.conversation(state.active_conversation_id);
  const alpha = nativeModelSelection({
    providerId: "codex",
    modelId: "codex-alpha",
    alias: "Codex Alpha",
    reasoningEffort: "medium",
  });
  const alphaIdentity = continuationIdentityForSelection(alpha, null, false);
  const cachedAt = new Date().toISOString();
  runtimeStore.saveProviderMetadata({
    scope: nativeProviderMetadataScope("codex"),
    models: [
      {
        id: "codex-alpha",
        label: "Codex Alpha",
        description: "First model in the E2E native catalog.",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [{
          value: "medium",
          label: "Medium",
          description: "Balanced reasoning.",
        }],
        defaultReasoningEffort: "medium",
      },
      {
        id: "codex-beta",
        label: "Codex Beta",
        description: "Second model in the E2E native catalog.",
        isDefault: false,
        inputModalities: ["text"],
        reasoningOptions: [{
          value: "medium",
          label: "Medium",
          description: "Balanced reasoning.",
        }],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.6-sol",
        label: "Sol",
        description: "Frontier coding model in the E2E native catalog.",
        isDefault: false,
        inputModalities: ["text"],
        reasoningOptions: [{
          value: "high",
          label: "High",
          description: "Thorough reasoning.",
        }, {
          value: "xhigh",
          label: "Extra high",
          description: "Maximum reasoning.",
        }],
        defaultReasoningEffort: "high",
      },
    ],
    modelsUpdatedAt: cachedAt,
    modelsLastAttemptedAt: cachedAt,
    modelsProvenance: "provider",
    modelsStale: false,
    rateLimits: [],
    rateLimitsUpdatedAt: null,
    rateLimitsLastAttemptedAt: null,
    rateLimitsProvenance: null,
    rateLimitsStale: false,
  });
  runtimeStore.updateConversation(currentConversation.id, {
    providerId: "codex",
    modelSelection: alpha,
  });
  runtimeStore.updateConversation(currentConversation.id, {
    providerSessionId: "composer-e2e-session",
    continuationIdentity: alphaIdentity,
  });
  const requestedAt = new Date(Date.now() - 1_000).toISOString();
  const { turn } = runtimeStore.beginAgentTurn({
    conversationId: currentConversation.id,
    runId: `composer-e2e-${randomUUID()}`,
    providerId: "codex",
    modelSelection: alpha,
    continuationIdentity: alphaIdentity,
    reasoningEffort: "medium",
    interactionMode: currentConversation.interactionMode,
    accessMode: currentConversation.accessMode,
    providerSessionBefore: "composer-e2e-session",
    configurationRevision: 0,
    association: "authoritative",
    content: "Keep the authoritative Codex route.",
    requestedAt,
  });
  runtimeStore.updateAgentTurnLifecycle(turn.id, {
    status: "completed",
    providerSessionAfter: "composer-e2e-session",
    startedAt: requestedAt,
    completedAt: cachedAt,
    updatedAt: cachedAt,
  });
  runtimeStore.close();

  const beforeRestart = await runtimeSnapshot();
  const appShell = page.locator(".app-shell");
  const rendererGenerationBeforeRestart = await appShell.getAttribute(
    "data-runtime-generation",
  );
  expect(rendererGenerationBeforeRestart).not.toBeNull();
  await electronApp.evaluate(() => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      crash: () => RuntimeTestSnapshot;
    } | undefined;
    if (!runtime) throw new Error("The test runtime supervisor is unavailable");
    runtime.crash();
  });
  await expect.poll(async () => {
    const current = await runtimeSnapshot();
    return current.phase === "ready" && current.generation > beforeRestart.generation;
  }, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => {
    const generation = await appShell.getAttribute("data-runtime-generation");
    return generation && generation !== rendererGenerationBeforeRestart;
  }, { timeout: 10_000 }).toBe(true);
  await expect(appShell).toHaveAttribute("data-connection-status", "online", {
    timeout: 10_000,
  });
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  await page.evaluate((storageKey) => {
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 2,
      favorites: [
        {
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        {
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
      ],
    }));
  }, MODEL_FAVORITES_STORAGE_KEY);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await modelTrigger.click();
  await expect(modelChooser).toBeVisible();
  await searchModels.fill("Sol");
  const solResults = modelChooser.getByRole("option").filter({
    hasText: /^Sol/u,
  });
  await expect(solResults).toHaveCount(2);
  const solXhigh = solResults.filter({ hasText: /xhigh reasoning/u });
  await expect(solXhigh).toBeVisible();
  await captureChooserScenario("model-chooser-search-sol-1440x720");
  await solXhigh.click();
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    const row = database.prepare(`
      SELECT model_selection_json AS selection
      FROM conversations
      WHERE id = ?
    `).get(currentConversation.id) as { selection: string };
    database.close();
    const selection = JSON.parse(row.selection) as {
      modelId: string;
      reasoningEffort: string | null;
    };
    return {
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
    };
  }).toEqual({
    modelId: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  });

  await modelTrigger.click();
  await expect(modelChooser).toBeVisible();
  await searchModels.fill("Codex Beta");
  const codexBeta = modelChooser.getByRole("option").filter({
    hasText: /^Codex Beta/u,
  });
  await expect(codexBeta).toBeEnabled();
  await codexBeta.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    const row = database.prepare(`
      SELECT active_conversation_id,
             (SELECT model_selection_json FROM conversations
              WHERE id = app_state.active_conversation_id) AS selection,
             (SELECT COUNT(*) FROM conversations) AS conversation_count
      FROM app_state
      WHERE id = 1
    `).get() as {
      active_conversation_id: string;
      selection: string;
      conversation_count: number;
    };
    database.close();
    return {
      activeId: row.active_conversation_id,
      modelId: (JSON.parse(row.selection) as { modelId: string }).modelId,
      conversationCount: row.conversation_count,
    };
  }).toEqual({
    activeId: currentConversation.id,
    modelId: "codex-beta",
    conversationCount: conversationCountBefore,
  });

  const chooseKimi = async (): Promise<void> => {
    await modelTrigger.click();
    await modelChooser.getByRole("searchbox", { name: "Search models" })
      .fill("Kimi K3");
    const kimi = modelChooser.getByRole("option")
      .filter({ hasText: /K3/u })
      .filter({ hasText: /Kimi/u, hasNotText: /256K/u });
    await expect(kimi).toBeEnabled();
    await kimi.click();
  };
  await chooseKimi();
  const routeConfirmation = page.getByRole("alertdialog");
  await expect(routeConfirmation).toContainText(
    "Open a new chat for Kimi · K3?",
  );
  await expect(routeConfirmation).toContainText(
    "Start a new chat to use a different agent harness.",
  );
  const routeConfirmationAx = await routeConfirmation.ariaSnapshot();
  expect(routeConfirmationAx).toContain(
    '- alertdialog "Open a new chat for Kimi · K3?"',
  );
  expect(routeConfirmationAx).toContain('- button "Cancel"');
  expect(routeConfirmationAx).toContain('- button "New chat"');
  const cancelRouteChange = routeConfirmation.getByRole("button", {
    name: "Cancel",
  });
  await expect(routeConfirmation).toHaveAttribute("aria-busy", "false");
  await expect(cancelRouteChange).toBeFocused();
  const routeFocusScreenshot = testInfo.outputPath(
    "route-change-confirmation-focus-1440x720.png",
  );
  await page.locator(".composer").screenshot({
    animations: "disabled",
    path: routeFocusScreenshot,
  });
  await testInfo.attach("route-change-confirmation-focus-1440x720", {
    path: routeFocusScreenshot,
    contentType: "image/png",
  });
  await page.keyboard.press("Tab");
  await expect(routeConfirmation.getByRole("button", {
    name: "New chat",
  })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(cancelRouteChange).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(routeConfirmation).toHaveCount(0);
  await expect(modelTrigger).toBeFocused();

  await chooseKimi();
  await expect(cancelRouteChange).toBeFocused();
  await cancelRouteChange.click();
  await expect(routeConfirmation).toHaveCount(0);
  await expect(modelTrigger).toBeFocused();

  await chooseKimi();
  await expect(cancelRouteChange).toBeFocused();
  await routeConfirmation.getByRole("button", { name: "New chat" }).click();
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    const row = database.prepare(`
      SELECT active_conversation_id,
             (SELECT model_selection_json FROM conversations
              WHERE id = app_state.active_conversation_id) AS selection,
             (SELECT COUNT(*) FROM conversations) AS conversation_count
      FROM app_state
      WHERE id = 1
    `).get() as {
      active_conversation_id: string;
      selection: string;
      conversation_count: number;
    };
    database.close();
    const selection = JSON.parse(row.selection) as {
      backendProfileId: string;
      modelId: string;
    };
    return {
      activeChanged: row.active_conversation_id !== currentConversation.id,
      backendProfileId: selection.backendProfileId,
      modelId: selection.modelId,
      conversationCount: row.conversation_count,
    };
  }).toEqual({
    activeChanged: true,
    backendProfileId: "builtin:kimi-code",
    modelId: "k3",
    conversationCount: conversationCountBefore + 1,
  });
  await expect(routeConfirmation).toHaveCount(0);
  await workspaceHeader.getByRole("button", { name: "Open workspace tools" }).click();
  expect(rendererErrors).toEqual([]);
});

test("keeps the composer as one cohesive dock across themes and responsive splits", async ({}, testInfo) => {
  if (await page.getByRole("textbox", { name: "Message" }).count() === 0) {
    await expect.poll(
      async () => (await runtimeSnapshot()).phase,
      { timeout: 10_000 },
    ).toBe("ready");
    await expect(
      page.getByRole("complementary", {
        name: "Project navigation",
        exact: true,
      }).locator(".sidebar-mode-switch")
        .getByRole("button", { name: "Projects", exact: true }),
    ).toBeEnabled({ timeout: 10_000 });
    await electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, workspaceDirectory);
    const addProject = page.getByRole("button", {
      name: "Add your first project",
    });
    await expect(addProject).toBeEnabled();
    await addProject.click();
    await expect(page.getByRole("heading", {
      name: "Start with a clear chat.",
    })).toBeVisible();
    await page.locator(".project-welcome")
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  }
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const originalStore = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  const originalSettings = originalStore.shellSnapshot().settings;
  originalStore.close();
  const navigation = page.getByRole("complementary", {
    name: "Project navigation",
    exact: true,
  });
  const workspacePanel = page.locator(".workspace-panel");
  const navigationWasVisible = await navigation.isVisible();
  const workspacePanelWasVisible = await workspacePanel.isVisible();

  const updateAppearance = (
    theme: "light" | "dark",
    interfaceScale: "compact" | "large",
    responseDensity: "compact" | "comfortable",
  ): void => {
    const store = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    store.updateSettings({ theme, interfaceScale, responseDensity });
    store.close();
  };
  const setWorkspaceTools = async (open: boolean): Promise<void> => {
    const panelIsVisible = await workspacePanel.isVisible();
    if (panelIsVisible === open) return;
    if (open) {
      await page.getByRole("button", { name: "Open workspace tools" }).click();
      await expect(workspacePanel).toBeVisible();
      return;
    }
    await page.getByRole("button", { name: "Close workspace tools" }).first().click();
    await expect(workspacePanel).toBeHidden();
  };
  const capture = async (label: string): Promise<void> => {
    const screenshot = testInfo.outputPath(`${label}.png`);
    await page.screenshot({
      animations: "disabled",
      path: screenshot,
      scale: "device",
    });
    await testInfo.attach(label, {
      path: screenshot,
      contentType: "image/png",
    });
  };

  try {
    updateAppearance("light", "compact", "compact");
    await resizeWindow(1440, 920);
    await page.reload();
    const textbox = page.getByRole("textbox", { name: "Message" });
    await expect(textbox).toBeVisible();
    await setWorkspaceTools(false);

    const dock = page.getByRole("region", { name: "Message composer" });
    await expectComposerEndsAtDock(dock);
    await expectComposerReadinessContained(dock);
    const model = dock.getByRole("button", { name: /^Choose model\./u });
    const usage = dock.getByRole("region", { name: "Usage and context" });
    const send = dock.getByRole("button", { name: "Send message" });

    await expect(dock).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute(
      "data-interface-scale",
      "compact",
    );
    await expect(page.locator(".chat-workspace")).toHaveClass(
      /response-density-compact/u,
    );
    await expect(model).toBeVisible();
    await expect(usage).toBeVisible();
    await expect(send).toBeVisible();
    await expect(dock.getByRole("button", { name: "Choose project access" }))
      .toBeVisible();
    await expect(dock.getByRole("button", { name: "Choose work mode" }))
      .toBeVisible();

    const wideGeometry = await dock.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const shellBounds = element.parentElement?.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const inputZone = element.querySelector<HTMLElement>(
        '[data-composer-zone="input"]',
      );
      const toolbarElement = element.querySelector<HTMLElement>(".composer-toolbar");
      const textarea = element.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      );
      const inputStyle = inputZone ? getComputedStyle(inputZone) : null;
      const toolbarStyle = toolbarElement ? getComputedStyle(toolbarElement) : null;
      const textareaStyle = textarea ? getComputedStyle(textarea) : null;
      const visibleControlHeights = [...element.querySelectorAll<HTMLElement>(
        '.composer-toolbar button, .composer-toolbar [role="region"] > button',
      )].filter((control) => {
        const style = getComputedStyle(control);
        const bounds = control.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && bounds.width > 0
          && bounds.height > 0;
      }).map((control) => control.getBoundingClientRect().height);
      const optionMarkers = [...element.querySelectorAll<HTMLElement>(
        ".composer-options > *, .composer-setting-family > *",
      )].map((control) => {
        if (control.classList.contains("model-chooser-anchor")) return "model";
        if (control.classList.contains("composer-reasoning-control")) return "reasoning";
        if (control.classList.contains("composer-access-control")) return "access";
        if (control.classList.contains("composer-mode-control")) return "mode";
        if (control.matches('[data-composer-control="usage"]')) return "usage";
        if (control.matches('[aria-label="Send message"]')) return "send";
        return null;
      }).filter(Boolean);
      return {
        width: bounds.width,
        centerDelta: shellBounds
          ? Math.abs(
              (bounds.left + bounds.right) / 2
              - (shellBounds.left + shellBounds.right) / 2,
            )
          : Number.POSITIVE_INFINITY,
        backdropFilter: computed.backdropFilter,
        webkitBackdropFilter: computed.getPropertyValue("-webkit-backdrop-filter"),
        backgroundColor: computed.backgroundColor,
        shellChildren: element.parentElement?.children.length ?? 0,
        readinessOutside: document.querySelectorAll(
          ".composer-shell > .provider-readiness",
        ).length,
        permanentFooter: document.querySelectorAll(
          ".composer-footer, .composer-note",
        ).length,
        detachedUsage: document.querySelectorAll(
          ".composer-shell > [data-composer-control='usage']",
        ).length,
        dockFits: element.scrollWidth <= element.clientWidth + 1,
        toolbarFits: toolbarElement
          ? toolbarElement.scrollWidth <= toolbarElement.clientWidth + 1
          : false,
        zoneOrder: [...element.children].map((child) =>
          child.getAttribute("data-composer-zone")).filter(Boolean),
        inputPaddingInline: inputStyle?.paddingInline,
        inputPaddingBlock: inputStyle?.paddingBlock,
        toolbarBorderTop: toolbarStyle?.borderTopWidth,
        textareaBorder: textareaStyle?.borderTopWidth,
        textareaBackground: textareaStyle?.backgroundColor,
        controlHeightDelta: visibleControlHeights.length > 0
          ? Math.max(...visibleControlHeights) - Math.min(...visibleControlHeights)
          : Number.POSITIVE_INFINITY,
        optionMarkers,
      };
    });
    expect(wideGeometry.width).toBeGreaterThanOrEqual(738);
    expect(wideGeometry.width).toBeLessThanOrEqual(742);
    expect(wideGeometry.centerDelta).toBeLessThanOrEqual(1);
    expect(wideGeometry.backdropFilter).toBe("none");
    expect(["", "none"]).toContain(wideGeometry.webkitBackdropFilter);
    expect(wideGeometry.backgroundColor).not.toMatch(/rgba\([^)]*,\s*0(?:\.0+)?\)/u);
    expect(wideGeometry.shellChildren).toBe(1);
    expect(wideGeometry.readinessOutside).toBe(0);
    expect(wideGeometry.permanentFooter).toBe(0);
    expect(wideGeometry.detachedUsage).toBe(0);
    expect(wideGeometry.dockFits).toBe(true);
    expect(wideGeometry.toolbarFits).toBe(true);
    expect(wideGeometry.zoneOrder).toEqual(["input", "controls"]);
    expect(wideGeometry.inputPaddingInline).toBe("12px");
    expect(wideGeometry.inputPaddingBlock).toBe("8px");
    expect(wideGeometry.toolbarBorderTop).toBe("1px");
    expect(wideGeometry.textareaBorder).toBe("0px");
    expect(wideGeometry.textareaBackground).toBe("rgba(0, 0, 0, 0)");
    expect(wideGeometry.controlHeightDelta).toBeLessThanOrEqual(1);
    expect(wideGeometry.optionMarkers.filter((marker) => marker !== "reasoning"))
      .toEqual([
      "model",
      "access",
      "mode",
      "usage",
      "send",
    ]);
    if (wideGeometry.optionMarkers.includes("reasoning")) {
      expect(wideGeometry.optionMarkers.indexOf("reasoning")).toBe(1);
    }

    await expect(send).toBeDisabled();
    const modelIdleBackground = await model.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    );
    await model.hover();
    const modelHoverBackground = await model.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    );
    expect(modelHoverBackground).not.toBe(modelIdleBackground);
    await model.focus();
    await expect(model).toBeFocused();
    expect(await model.evaluate(
      (button) => Number.parseFloat(getComputedStyle(button).outlineWidth),
    )).toBeGreaterThanOrEqual(2);
    await model.click();
    await expect(model).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(model).toHaveAttribute("aria-expanded", "false");

    const settingFamily = dock.getByRole("group", {
      name: "Composer settings",
    });
    const accessTrigger = dock.locator('[data-composer-setting="access"]');
    const modeTrigger = dock.locator('[data-composer-setting="mode"]');
    const reasoningTrigger = dock.locator(
      '[data-composer-setting="reasoning"]',
    );
    await expect(settingFamily).toBeVisible();
    const settingGeometry = await settingFamily.evaluate((element) => {
      const style = getComputedStyle(element);
      const controls = [...element.querySelectorAll<HTMLButtonElement>(
        "button[data-composer-setting]",
      )];
      return {
        borderLeft: style.borderLeftWidth,
        borderRight: style.borderRightWidth,
        heights: controls.map((control) =>
          control.getBoundingClientRect().height),
        borders: controls.map((control) =>
          getComputedStyle(control).borderTopWidth),
        fontSizes: controls.map((control) =>
          getComputedStyle(control).fontSize),
        iconSizes: controls.map((control) => {
          const icon = control.querySelector<SVGElement>(
            ".composer-setting-icon",
          );
          const bounds = icon?.getBoundingClientRect();
          return bounds
            ? { width: bounds.width, height: bounds.height }
            : null;
        }),
      };
    });
    expect(settingGeometry.borderLeft).toBe("1px");
    expect(settingGeometry.borderRight).toBe("1px");
    expect(Math.max(...settingGeometry.heights)
      - Math.min(...settingGeometry.heights)).toBeLessThanOrEqual(1);
    expect(new Set(settingGeometry.borders)).toEqual(new Set(["0px"]));
    expect(new Set(settingGeometry.fontSizes).size).toBe(1);
    expect(settingGeometry.iconSizes).toEqual(
      settingGeometry.iconSizes.map(() => ({ width: 13, height: 13 })),
    );
    const accessIdleBackground = await accessTrigger.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    );
    await accessTrigger.hover();
    expect(await accessTrigger.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    )).not.toBe(accessIdleBackground);
    await accessTrigger.focus();
    expect(await accessTrigger.evaluate(
      (button) => Number.parseFloat(getComputedStyle(button).outlineWidth),
    )).toBeGreaterThanOrEqual(2);
    await accessTrigger.click();
    expect(await accessTrigger.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    )).not.toBe(accessIdleBackground);
    await page.keyboard.press("Escape");

    const directSettings = [
      {
        trigger: accessTrigger,
        menu: page.getByRole("menu", { name: "Project access" }),
      },
      {
        trigger: modeTrigger,
        menu: page.getByRole("menu", { name: "Work mode" }),
      },
      ...(await reasoningTrigger.count() > 0
        ? [{
            trigger: reasoningTrigger,
            menu: page.getByRole("menu", { name: "Reasoning level" }),
          }]
        : []),
    ];
    for (const setting of directSettings) {
      await setting.trigger.focus();
      await setting.trigger.press("ArrowDown");
      await expect(setting.menu).toBeVisible();
      const options = setting.menu.getByRole("menuitemradio");
      await expect(options.first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(options.last()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(setting.menu).toBeHidden();
      await expect(setting.trigger).toBeFocused();

      await setting.trigger.click();
      await expect(setting.menu).toBeVisible();
      await page.locator(".workspace-header").click({
        position: { x: 12, y: 12 },
      });
      await expect(setting.menu).toBeHidden();
      await expect(setting.trigger).toBeFocused();

      await setting.trigger.click();
      await setting.menu.locator(
        '[role="menuitemradio"][aria-checked="true"]',
      ).click();
      await expect(setting.menu).toBeHidden();
      await expect(setting.trigger).toBeFocused();
    }

    await accessTrigger.click();
    await expect(page.getByRole("menu", { name: "Project access" }))
      .toBeVisible();
    await modeTrigger.click();
    await expect(page.getByRole("menu", { name: "Project access" }))
      .toBeHidden();
    await expect(page.getByRole("menu", { name: "Work mode" })).toBeVisible();
    await expect(modeTrigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modeTrigger).toBeFocused();

    await accessTrigger.click();
    await expect(page.getByRole("menu", { name: "Project access" }))
      .toBeVisible();
    await capture("composer-controls-access-light-compact-1440x920");
    await page.keyboard.press("Escape");

    const initialTextareaHeight = await textbox.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    await textbox.fill(
      [
        "Plan a focused composer pass.",
        "Keep previews inside the dock.",
        "Preserve route boundaries.",
        "Keep controls aligned.",
      ].join("\n"),
    );
    await page.waitForTimeout(200);
    const grownTextareaHeight = await textbox.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(grownTextareaHeight).toBeGreaterThan(initialTextareaHeight);
    expect(grownTextareaHeight).toBeLessThanOrEqual(176);
    await textbox.fill("");
    await capture("composer-dock-light-compact-1440x920");

    await electronApp.evaluate(({ dialog }, paths) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: paths,
        bookmarks: [],
      }));
    }, [attachmentImagePath, attachmentDocumentPath]);
    await dock.getByRole("button", {
      name: "Attach images or documents",
    }).click();
    const attachmentList = dock.getByRole("list", { name: "Attachments" });
    await expect(attachmentList.locator("img")).toHaveCount(1);
    await expect(attachmentList.getByText("PNG image · 68 B", {
      exact: true,
    })).toBeVisible();
    await expect(attachmentList.getByText("PDF document · 35 B", {
      exact: true,
    })).toBeVisible();
    await expect(dock.getByText(
      "Document preview is available, but this route cannot read documents. Remove it before sending.",
      { exact: true },
    )).toBeVisible();
    await expectComposerEndsAtDock(dock);
    const attachmentGeometry = await attachmentList.evaluate((list) => {
      const items = [...list.querySelectorAll<HTMLElement>(
        ".composer-attachment",
      )];
      const thumbnails = [...list.querySelectorAll<HTMLElement>(
        ".composer-attachment-preview",
      )];
      return {
        listHeight: list.getBoundingClientRect().height,
        itemHeights: items.map((item) => item.getBoundingClientRect().height),
        itemBorders: items.map((item) => getComputedStyle(item).borderTopWidth),
        itemBackgrounds: items.map(
          (item) => getComputedStyle(item).backgroundColor,
        ),
        thumbnailSizes: thumbnails.map((thumbnail) => {
          const bounds = thumbnail.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
      };
    });
    expect(attachmentGeometry.listHeight).toBeLessThanOrEqual(80);
    expect(Math.max(...attachmentGeometry.itemHeights)).toBeLessThanOrEqual(38);
    expect(attachmentGeometry.itemBorders).toEqual(["0px", "0px"]);
    expect(attachmentGeometry.itemBackgrounds).toEqual([
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0)",
    ]);
    expect(attachmentGeometry.thumbnailSizes).toEqual([
      { width: 30, height: 30 },
      { width: 30, height: 30 },
    ]);
    await capture("composer-zones-attachment-light-1440x920");
    await attachmentList.getByRole("button", {
      name: "Remove attachment preview.png",
    }).click();
    await attachmentList.getByRole("button", {
      name: "Remove attachment notes.pdf",
    }).click();
    await expect(attachmentList).toHaveCount(0);

    updateAppearance("dark", "large", "comfortable");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-interface-scale",
      "large",
    );
    await expect(page.locator(".chat-workspace")).toHaveClass(
      /response-density-comfortable/u,
    );
    await expectComposerEndsAtDock(dock);
    await expectComposerReadinessContained(dock);
    await setWorkspaceTools(false);
    await capture("composer-dock-dark-large-1440x920");
    const darkModeTrigger = page.locator(
      '[data-composer-setting="mode"]',
    );
    await darkModeTrigger.click();
    await expect(page.getByRole("menu", { name: "Work mode" })).toBeVisible();
    await capture("composer-controls-mode-dark-large-1440x920");
    await page.keyboard.press("Escape");

    await setWorkspaceTools(true);
    await resizeWindow(1180, 720);
    const splitDock = page.getByRole("region", { name: "Message composer" });
    await expectComposerEndsAtDock(splitDock);
    await expectComposerReadinessContained(splitDock);
    await expect(splitDock.getByRole("button", { name: /^Choose model\./u }))
      .toBeVisible();
    await expect(splitDock.getByRole("region", { name: "Usage and context" }))
      .toBeVisible();
    await expect(splitDock.getByRole("button", { name: "Send message" }))
      .toBeVisible();
    await expect(splitDock.getByRole("button", {
      name: "More composer options",
    })).toBeVisible();
    await expect(splitDock.getByRole("group", {
      name: "Composer settings",
    })).toBeHidden();
    const splitFits = await splitDock.evaluate((element) => {
      const toolbarElement = element.querySelector<HTMLElement>(".composer-toolbar");
      return element.scrollWidth <= element.clientWidth + 1
        && Boolean(
          toolbarElement
          && toolbarElement.scrollWidth <= toolbarElement.clientWidth + 1,
        );
    });
    expect(splitFits).toBe(true);
    expect(await splitDock.getByRole("textbox", { name: "Message" }).evaluate(
      (element) => getComputedStyle(element).overflowY,
    )).toBe("hidden");
    const splitMore = splitDock.getByRole("button", {
      name: "More composer options",
    });
    await splitMore.focus();
    await splitMore.press("ArrowDown");
    const splitMoreMenu = page.getByRole("menu", {
      name: "More composer options",
    });
    await expect(splitMoreMenu).toBeVisible();
    await expect(splitMoreMenu.locator("button:not(:disabled)").first())
      .toBeFocused();
    const splitAccessItem = splitMoreMenu.getByRole("menuitem", {
      name: /^Access\b/u,
    });
    await splitAccessItem.focus();
    await splitAccessItem.press("ArrowRight");
    const splitAccessMenu = page.getByRole("menu", {
      name: "Access options",
    });
    await expect(splitAccessMenu).toBeVisible();
    await expect(splitAccessMenu.getByRole("menuitemradio").first())
      .toBeFocused();
    const splitPopoverGeometry = await splitDock.evaluate((element) => {
      const workspace = element.closest<HTMLElement>(".workspace-body");
      const rootMenu = element.querySelector<HTMLElement>(
        "#composer-more-menu",
      );
      const submenu = element.querySelector<HTMLElement>(
        ".composer-more-submenu",
      );
      const workspaceBounds = workspace?.getBoundingClientRect();
      const rootBounds = rootMenu?.getBoundingClientRect();
      const submenuBounds = submenu?.getBoundingClientRect();
      return {
        workspaceLeft: workspaceBounds?.left ?? Number.POSITIVE_INFINITY,
        workspaceRight: workspaceBounds?.right ?? Number.NEGATIVE_INFINITY,
        rootLeft: rootBounds?.left ?? Number.NEGATIVE_INFINITY,
        rootRight: rootBounds?.right ?? Number.POSITIVE_INFINITY,
        submenuLeft: submenuBounds?.left ?? Number.NEGATIVE_INFINITY,
        submenuRight: submenuBounds?.right ?? Number.POSITIVE_INFINITY,
      };
    });
    expect(splitPopoverGeometry.rootLeft)
      .toBeGreaterThanOrEqual(splitPopoverGeometry.workspaceLeft);
    expect(splitPopoverGeometry.rootRight)
      .toBeLessThanOrEqual(splitPopoverGeometry.workspaceRight);
    expect(splitPopoverGeometry.submenuLeft)
      .toBeGreaterThanOrEqual(splitPopoverGeometry.workspaceLeft);
    expect(splitPopoverGeometry.submenuRight)
      .toBeLessThanOrEqual(splitPopoverGeometry.workspaceRight);
    await capture("composer-controls-more-access-dark-split-1180x720");
    await page.keyboard.press("Escape");
    await expect(splitMoreMenu).toBeHidden();
    await expect(splitMore).toBeFocused();
    await splitMore.click();
    await expect(splitMoreMenu).toBeVisible();
    await page.locator(".workspace-header").click({
      position: { x: 12, y: 12 },
    });
    await expect(splitMoreMenu).toBeHidden();
    await expect(splitMore).toBeFocused();
    await expectNoViewportOverflow();
    await capture("composer-dock-dark-split-1180x720");

    await resizeWindow(1024, 760);
    const stackedDock = page.getByRole("region", {
      name: "Message composer",
    });
    const stackedModel = stackedDock.getByRole("button", {
      name: /^Choose model\./u,
    });
    await expect(stackedModel).toBeVisible();
    await stackedModel.click();
    const stackedModelChooser = page.getByRole("dialog", {
      name: "Choose model",
    });
    await expect(stackedModelChooser).toBeVisible();
    const stackedModelChooserGeometry = await page.evaluate(() => {
      const viewport = {
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        left: 0,
      };
      const workspace = document.querySelector<HTMLElement>(".workspace-frame")
        ?.getBoundingClientRect();
      const chat = document.querySelector<HTMLElement>(".chat-workspace")
        ?.getBoundingClientRect();
      const tools = document.querySelector<HTMLElement>(".workspace-panel")
        ?.getBoundingClientRect();
      const chooser = document.querySelector<HTMLElement>(
        ".model-chooser-palette",
      )?.getBoundingClientRect();
      const toolbar = document.querySelector<HTMLElement>(
        ".composer-toolbar",
      );
      if (!workspace || !chat || !tools || !chooser || !toolbar) return null;
      return {
        horizontalSplit: chat.bottom <= tools.top + 1,
        chooserBounds: {
          top: chooser.top,
          right: chooser.right,
          bottom: chooser.bottom,
          left: chooser.left,
        },
        workspaceBounds: {
          top: workspace.top,
          right: workspace.right,
          bottom: workspace.bottom,
          left: workspace.left,
        },
        viewport,
        chooserInsideViewport:
          chooser.top >= viewport.top - 1
          && chooser.right <= viewport.right + 1
          && chooser.bottom <= viewport.bottom + 1
          && chooser.left >= viewport.left - 1,
        chooserInsideWorkspace:
          chooser.top >= workspace.top - 1
          && chooser.right <= workspace.right + 1
          && chooser.bottom <= workspace.bottom + 1
          && chooser.left >= workspace.left - 1,
        toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth + 1,
      };
    });
    await capture("composer-model-chooser-dark-stacked-1024x760");
    expect(
      stackedModelChooserGeometry,
      JSON.stringify(stackedModelChooserGeometry),
    ).toMatchObject({
      horizontalSplit: true,
      chooserInsideViewport: true,
      chooserInsideWorkspace: true,
      toolbarFits: true,
    });
    await page.keyboard.press("Escape");
    const stackedUsageTrigger = stackedDock.locator(
      ".usage-popover-trigger",
    );
    await stackedUsageTrigger.click();
    const stackedUsagePopover = page.getByRole("dialog", {
      name: "Usage & context",
    });
    await expect(stackedUsagePopover).toBeVisible();
    const stackedUsageGeometry = await stackedUsagePopover.evaluate(
      (element) => {
        const bounds = element.getBoundingClientRect();
        const workspace = element.closest<HTMLElement>(".workspace-frame")
          ?.getBoundingClientRect();
        return {
          insideViewport:
            bounds.top >= -1
            && bounds.right <= window.innerWidth + 1
            && bounds.bottom <= window.innerHeight + 1
            && bounds.left >= -1,
          insideWorkspace: Boolean(
            workspace
            && bounds.top >= workspace.top - 1
            && bounds.right <= workspace.right + 1
            && bounds.bottom <= workspace.bottom + 1
            && bounds.left >= workspace.left - 1,
          ),
        };
      },
    );
    expect(stackedUsageGeometry).toEqual({
      insideViewport: true,
      insideWorkspace: true,
    });
    await capture("composer-context-popover-dark-stacked-1024x760");
    await page.keyboard.press("Escape");

    await setWorkspaceTools(false);
    await resizeWindow(760, 680);
    if (await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeHidden();
    }
    const narrowDock = page.getByRole("region", { name: "Message composer" });
    await expectComposerEndsAtDock(narrowDock);
    await expectComposerReadinessContained(narrowDock);
    await expect(narrowDock.getByRole("button", { name: /^Choose model\./u }))
      .toBeVisible();
    await expect(narrowDock.getByRole("region", { name: "Usage and context" }))
      .toBeVisible();
    await expect(narrowDock.getByRole("button", { name: "Send message" }))
      .toBeVisible();
    const narrowMore = narrowDock.locator(".composer-more-control");
    if (await narrowMore.isVisible()) {
      await expect(narrowMore.getByRole("button", {
        name: "More composer options",
      })).toBeVisible();
    } else {
      await expect(narrowDock.getByRole("button", {
        name: "Choose project access",
      })).toBeVisible();
      await expect(narrowDock.getByRole("button", {
        name: "Choose work mode",
      })).toBeVisible();
    }
    await expectNoViewportOverflow();
    expect(await narrowDock.evaluate((element) =>
      element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await capture("composer-zones-dark-narrow-760x680");
  } finally {
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    cleanup.updateSettings({
      theme: originalSettings.theme,
      interfaceScale: originalSettings.interfaceScale,
      responseDensity: originalSettings.responseDensity,
    });
    cleanup.close();
    await resizeWindow(1440, 920);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
      timeout: 10_000,
    });
    if (await navigation.isVisible() !== navigationWasVisible) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
    }
    await setWorkspaceTools(workspacePanelWasVisible);
  }
  expect(rendererErrors).toEqual([]);
});

test("collapses composer settings without displacing send and right-aligns user turns", async () => {
  await resizeWindow(900, 600);
  const composer = page.locator(".composer");
  const more = page.getByRole("button", { name: "More composer options" });
  const send = page.getByRole("button", { name: "Send message" });
  const modelTrigger = page.getByRole("button", { name: /^Choose model\./u });
  await expect(more).toBeVisible();
  await expect(send).toBeVisible();
  await expect(modelTrigger).toBeVisible();

  const bounds = await composer.boundingBox();
  const sendBounds = await send.boundingBox();
  expect(bounds).not.toBeNull();
  expect(sendBounds).not.toBeNull();
  expect((sendBounds?.x ?? 0) + (sendBounds?.width ?? 0)).toBeLessThanOrEqual((bounds?.x ?? 0) + (bounds?.width ?? 0));

  await modelTrigger.click();
  const modelChooser = page.getByRole("dialog", { name: "Choose model" });
  await expect(modelChooser).toBeVisible();
  const chooserBounds = await modelChooser.boundingBox();
  expect(chooserBounds).not.toBeNull();
  expect(chooserBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((chooserBounds?.x ?? 0) + (chooserBounds?.width ?? 0))
    .toBeLessThanOrEqual(900);
  await page.keyboard.press("Escape");

  await more.click();
  const compactOptions = page.getByRole("menu", { name: "More composer options" });
  await expect(compactOptions.getByRole("menuitem", { name: /^Backend\b/ })).toHaveCount(0);
  await expect(compactOptions.getByRole("menuitem", { name: /^Model\b/ })).toHaveCount(0);
  const modeItem = compactOptions.getByRole("menuitem", { name: /^Mode\b/ });
  await expect(modeItem).toBeVisible();
  await expect(compactOptions.getByRole("menuitem", { name: /^Access\b/ })).toBeVisible();
  await modeItem.hover();
  const modeOptions = page.getByRole("menu", { name: "Mode options" });
  await expect(modeOptions).toBeVisible();
  await expect(modeOptions.getByRole("menuitemradio").first()).toBeVisible();
  await modeItem.click();
  await expect(modeOptions).toBeVisible();
  await page.mouse.move(20, 20);
  await expect(modeOptions).toBeHidden();
  await expect(compactOptions).toBeVisible();
  await page.keyboard.press("Escape");

  const userAlignmentGap = await page.evaluate(() => {
    const timeline = document.querySelector(".response-timeline");
    if (!timeline) throw new Error("Response timeline is unavailable");
    const turn = document.createElement("section");
    turn.className = "response-turn";
    const message = document.createElement("article");
    message.className = "message is-user";
    message.innerHTML = '<div class="message-meta"><span>You</span></div><div class="message-body">Alignment probe</div>';
    turn.append(message);
    timeline.append(turn);
    const turnBounds = turn.getBoundingClientRect();
    const messageBounds = message.getBoundingClientRect();
    turn.remove();
    return Math.abs(turnBounds.right - messageBounds.right);
  });
  expect(userAlignmentGap).toBeLessThanOrEqual(1);
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

test("contains commit dialog focus and restores its trigger", async () => {
  await resizeWindow(1440, 920);
  const trigger = page.getByRole("button", { name: "Commit & push", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  const message = dialog.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();

  const close = dialog.getByRole("button", { name: "Close commit dialog" });
  await close.focus();
  await close.press("Shift+Tab");
  await expect(message).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(rendererErrors).toEqual([]);
});

test("keeps the macOS brand in the native titlebar row and navigates it home", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  const shell = page.locator(".app-shell");
  const brand = page.getByRole("button", { name: "Go to workspace" });
  await expect(shell).toHaveClass(new RegExp(`platform-${process.platform}`));

  if (process.platform === "darwin") {
    const geometry = await page.evaluate(() => {
      const row = document.querySelector(".sidebar-brand")?.getBoundingClientRect();
      const lockup = document.querySelector(".brand-lockup");
      const logo = document.querySelector(".brand-logo");
      const markStyles = lockup ? getComputedStyle(lockup, "::before") : null;
      const lockupStyles = lockup ? getComputedStyle(lockup) : null;
      const logoStyles = logo ? getComputedStyle(logo) : null;
      const lockupBounds = lockup?.getBoundingClientRect();
      return row && lockupBounds && markStyles && lockupStyles && logoStyles ? {
        row: { top: row.top, height: row.height },
        markLeft: lockupBounds.left + Number.parseFloat(lockupStyles.paddingLeft),
        mark: { width: markStyles.width, height: markStyles.height, maskImage: markStyles.maskImage },
        logoDisplay: logoStyles.display,
      } : null;
    });
    expect(geometry).not.toBeNull();
    expect(geometry?.row.top).toBeCloseTo(12, 0);
    expect(geometry?.row.height).toBeLessThanOrEqual(30);
    expect(geometry?.mark.width).toBe("24px");
    expect(geometry?.mark.height).toBe("24px");
    expect(geometry?.mark.maskImage).toContain("inertia-logo.png");
    expect(geometry?.logoDisplay).toBe("none");
    const trafficLightClusterRight = MAC_TRAFFIC_LIGHT_POSITION.x + MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH;
    expect((geometry?.markLeft ?? 0) - trafficLightClusterRight).toBeGreaterThanOrEqual(MAC_BRAND_MIN_CLEAR_GAP);
    await page.screenshot({ path: testInfo.outputPath("v004-brand-wide.png") });

    try {
      await resizeWindow(760, 640);
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();
      await expect.poll(async () => {
        const compactMarkLeft = await page.locator(".brand-lockup").evaluate((lockup) => {
          const bounds = lockup.getBoundingClientRect();
          return bounds.left + Number.parseFloat(getComputedStyle(lockup).paddingLeft);
        });
        return compactMarkLeft - trafficLightClusterRight;
      }).toBeGreaterThanOrEqual(MAC_BRAND_MIN_CLEAR_GAP);
      await page.screenshot({ path: testInfo.outputPath("v004-brand-compact.png") });
    } finally {
      const closeNavigation = page.getByRole("button", { name: "Close navigation" }).last();
      if (await closeNavigation.isVisible().catch(() => false)) await closeNavigation.click();
      await resizeWindow(1440, 920);
    }
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await brand.click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("opens the command palette and manages a thread", async () => {
  await resizeWindow(1440, 920);
  const initialThreadCount = await page.locator(".conversation-item").count();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Search Inertia" })).toBeVisible();
  await page.getByRole("dialog", { name: "Search Inertia" })
    .getByRole("option")
    .filter({ hasText: "Start work in the current project" })
    .click();
  await expect(page.locator(".conversation-item")).toHaveCount(initialThreadCount + 1);
  await expect(page.locator(".conversation-row.is-active")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();

  await page.locator(".conversation-item").filter({ has: page.locator(".conversation-row.is-active") })
    .getByRole("button", { name: "Thread actions for New chat" })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("textbox", { name: "Rename New chat" });
  await rename.fill("Focused V1 pass");
  await rename.press("Enter");
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Thread actions for Focused V1 pass" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Focused V1 pass", level: 1 })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thread actions for Focused V1 pass" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  const terminalInput = page.locator(".xterm-helper-textarea").first();
  await terminalInput.focus();
  await page.keyboard.press("Control+K");
  const search = page.getByRole("combobox", { name: "Search commands, projects, and threads" });
  await search.fill("settings");
  const settingsOption = page.getByRole("option", { name: /Open settings/ });
  await expect(settingsOption).toHaveAttribute("aria-selected", "true");
  if (process.platform === "win32") await settingsOption.click();
  else await search.press("Enter");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("switches workspace tools, opens multiple terminals, and loads a safe native preview", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: /Changes/ }).click();
  await expect(page.getByLabel("Workspace changes")).toBeVisible();
  await page.getByRole("tab", { name: /Files/ }).click();
  await expect(page.getByRole("region", { name: "Project files" })).toBeVisible();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal" }).click();
  const secondTerminalTab = page.getByRole("tab", { name: "Terminal 2", exact: true });
  await expect(secondTerminalTab).toBeVisible();
  await expect(secondTerminalTab).toHaveAttribute("aria-selected", "true");
  await expect(secondTerminalTab).toHaveJSProperty("tagName", "BUTTON");
  await page.getByRole("button", { name: "Close Terminal 2" }).click();
  await expect(secondTerminalTab).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "New terminal" }).click();
  await page.getByRole("button", { name: "Split terminals" }).click();
  await expect(page.locator(".terminal-session-grid")).toHaveClass(/is-split/);
  const liveTerminals = page.locator(".terminal-panel[data-terminal-id]");
  await expect(liveTerminals).toHaveCount(2);
  const terminalIdsBefore = (await liveTerminals.evaluateAll((terminals) => terminals.map((terminal) => terminal.getAttribute("data-terminal-id")).sort())).filter(Boolean);

  await page.getByRole("tab", { name: /Changes/ }).click();
  await page.getByRole("tab", { name: /Files/ }).click();
  await page.getByRole("tab", { name: /Preview/ }).click();
  const address = page.getByRole("textbox", { name: "Preview address" });
  await address.fill(previewUrl);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => electronApp.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url), previewUrl)).toBe(true);
  await page.getByRole("tab", { name: /Plan/ }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
  await page.locator(".workspace-panel").getByRole("button", { name: "Close workspace tools" }).click();
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
  await expect(liveTerminals).toHaveCount(2);
  const terminalIdsAfter = (await liveTerminals.evaluateAll((terminals) => terminals.map((terminal) => terminal.getAttribute("data-terminal-id")).sort())).filter(Boolean);
  expect(terminalIdsAfter).toEqual(terminalIdsBefore);
  expect(rendererErrors).toEqual([]);
});

test("navigates the project file hierarchy lazily with an accessible keyboard tree", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  const addProject = page.getByRole("button", { name: "Add your first project" });
  if (await addProject.isVisible().catch(() => false)) {
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-connection-status",
      "online",
      { timeout: 15_000 },
    );
    await electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, workspaceDirectory);
    await addProject.click();
    await expect(page.getByRole("heading", { name: "Start with a clear chat." }))
      .toBeVisible({ timeout: 15_000 });
    await page.locator(".project-welcome")
      .getByRole("button", { name: "New chat", exact: true })
      .click();
  }

  const filesTab = page.getByRole("tab", { name: /Files/ });
  if (!await filesTab.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
  await filesTab.click();
  const panel = page.getByRole("region", { name: "Project files" });
  const tree = panel.getByRole("tree", { name: "Workspace files" });
  await expect(tree).toBeVisible();
  await expect(tree.getByText("CaseSensitiveLeaf.ts", { exact: true })).toHaveCount(0);

  const src = tree.getByRole("treeitem", { name: "src", exact: true });
  await src.focus();
  await src.press("ArrowRight");
  await expect(src).toHaveAttribute("aria-expanded", "true");
  const components = tree.getByRole("treeitem", { name: "components", exact: true });
  await expect(components).toHaveAttribute("aria-level", "2");
  await src.press("ArrowRight");
  await expect(components).toBeFocused();
  await components.press("ArrowRight");
  await expect(components).toHaveAttribute("aria-expanded", "true");

  const deep = tree.getByRole("treeitem", { name: "deep", exact: true });
  const buttonFile = tree.getByRole("treeitem", { name: "Button.tsx", exact: true });
  await expect(deep).toHaveAttribute("aria-level", "3");
  await components.press("ArrowRight");
  await expect(deep).toBeFocused();
  await deep.press("ArrowDown");
  await expect(buttonFile).toBeFocused();
  await buttonFile.press("Enter");
  await expect(buttonFile).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByLabel("Contents of src/components/Button.tsx"))
    .toContainText("export const Button");

  const search = panel.getByRole("searchbox", { name: "Search project files" });
  await search.fill("deep");
  const searchTree = panel.getByRole("tree", { name: "Workspace file search results" });
  const deepResult = searchTree.getByRole("treeitem").filter({ hasText: "deep" }).first();
  await expect(deepResult).toHaveAttribute("title", "src/components/deep");
  await deepResult.press("Enter");
  await expect(search).toHaveValue("");
  const leaf = tree.getByRole("treeitem", { name: "CaseSensitiveLeaf.ts", exact: true });
  await expect(leaf).toHaveAttribute("aria-level", "4");
  await leaf.focus();
  await leaf.press("Enter");
  await expect(leaf).toHaveAttribute("aria-current", "true");
  await expect(panel.getByLabel("Contents of src/components/deep/CaseSensitiveLeaf.ts"))
    .toContainText("export const leaf = true");

  await search.fill("guide");
  await expect(searchTree.getByRole("treeitem").filter({ hasText: "guide.md" })).toBeVisible();
  await panel.getByRole("button", { name: "Clear file search" }).click();
  await expect(search).toBeFocused();
  await expect(components).toHaveAttribute("aria-expanded", "true");
  await expect(deep).toHaveAttribute("aria-expanded", "true");

  await leaf.press("End");
  await expect(tree.getByRole("treeitem", { name: "sample.ts", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem", { name: "docs", exact: true })).toBeFocused();

  const emptyFolder = tree.getByRole("treeitem", { name: "empty-folder", exact: true });
  await emptyFolder.press("Enter");
  await expect(tree.getByRole("status")).toContainText("empty-folder is empty");
  await page.screenshot({ path: testInfo.outputPath("recursive-files-tree-1440x920.png") });

  await resizeWindow(760, 800);
  await expect(tree).toBeVisible();
  await expect(leaf).toBeVisible();
  await expectNoViewportOverflow();
  await page.screenshot({ path: testInfo.outputPath("recursive-files-tree-760x800.png") });
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

test("keeps the Changes panel readable when the side tool area is narrow", async () => {
  await resizeWindow(1040, 800);
  await page.getByRole("tab", { name: /Changes/ }).click();
  const picker = page.getByRole("combobox", { name: "Repository and changed file" });
  await expect(picker).toBeVisible();
  await expect(picker.locator("option:checked")).toHaveText("Inertia — M · sample.ts");
  await expect(page.getByLabel("Git repositories and changed files")).toBeHidden();
  await expect(page.getByLabel(/Diff for|Unified diff/)).toBeVisible();
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

test("adds a selected diff range to the next agent prompt", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: /Changes/ }).click();
  const addedLine = page.locator(".diff-line.is-addition").filter({ hasText: "export const ready = true;" }).first();
  await expect(addedLine).toBeVisible();
  await addedLine.click();
  await expect(page.getByRole("button", { name: "Add to prompt" })).toBeVisible();
  await page.getByRole("button", { name: "Add to prompt" }).click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toContainText("Diff selection in sample.ts");
  await page.getByRole("button", { name: "Remove selected diff context" }).click();
  await expect(page.getByLabel("Selected diff context", { exact: true })).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test("keeps a contextual selection answer readable and dismissible across responsive layouts", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: /Changes/ }).click();
  const hunkHeader = page.locator(".diff-hunk-header").first();
  await expect(hunkHeader).toBeVisible();

  const longBackendName =
    "Claude harness · Enterprise gateway with an intentionally long private backend name";
  const longModelName =
    "Claude Sonnet research preview with an intentionally long model display name";
  const modelSelection = {
    ...nativeModelSelection({
      providerId: "claude",
      modelId: "claude-sonnet-research-preview-with-a-long-identifier",
      alias: longModelName,
      reasoningEffort: "high",
    }),
    backendProfileId: "custom:e2e-contextual-review",
    backendProfileDisplayName: longBackendName,
    backendConfigurationRevision: 7,
  } as const;
  const longAnswer = Array.from({ length: 18 }, (_, index) =>
    `Finding ${index + 1}: the selected line keeps the runtime state explicit, preserves the exact backend route, and avoids turning a contextual review question into ordinary transcript history.`,
  ).join("\n\n");
  const answer: DiffSelectionReviewAnswer = {
    conversationId: randomUUID(),
    fingerprint: "b".repeat(64),
    filePath: "sample.ts",
    hunkId: "e2e-hunk",
    selectedLineCount: 12,
    question:
      "Explain the compatibility, lifecycle, and user-facing consequences of this selected diff without losing its exact routing context.",
    answer: longAnswer,
    providerId: "claude",
    modelSelection,
    generatedAt: "2026-07-25T12:00:00.000Z",
  };
  const markup = selectionAnswerFixtureMarkup(answer);

  await hunkHeader.evaluate((header, cardMarkup) => {
    header.insertAdjacentHTML("afterend", cardMarkup);
    const card = header.nextElementSibling;
    card?.querySelector<HTMLButtonElement>('[aria-label="Dismiss selection answer"]')
      ?.addEventListener("click", () => card.remove());
  }, markup);

  const card = page.getByLabel("Agent answer about selected lines");
  const answerBody = card.locator(".diff-selection-answer-body");
  const metadata = card.locator("header small");
  const dismiss = card.getByRole("button", { name: "Dismiss selection answer" });
  await expect(card).toContainText(longBackendName);
  await expect(card).toContainText(longModelName);
  await expect(card).toContainText("Finding 18");

  for (const viewport of [
    { width: 1440, height: 920, slug: "wide" },
    { width: 900, height: 760, slug: "medium" },
    { width: 760, height: 760, slug: "narrow" },
  ] as const) {
    await resizeWindow(viewport.width, viewport.height);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(dismiss).toBeVisible();
    const geometry = await card.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>(".diff-selection-answer-body");
      const meta = element.querySelector<HTMLElement>("header small");
      const close = element.querySelector<HTMLElement>('[aria-label="Dismiss selection answer"]');
      return {
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
        bodyClientHeight: body?.clientHeight ?? 0,
        bodyScrollHeight: body?.scrollHeight ?? 0,
        metadataFontSize: Number.parseFloat(getComputedStyle(meta!).fontSize),
        closeLeft: close?.getBoundingClientRect().left ?? -1,
        closeRight: close?.getBoundingClientRect().right ?? -1,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.bodyScrollHeight).toBeGreaterThan(geometry.bodyClientHeight);
    expect(geometry.metadataFontSize).toBeGreaterThanOrEqual(8.5);
    expect(geometry.closeLeft).toBeGreaterThanOrEqual(geometry.left);
    expect(geometry.closeRight).toBeLessThanOrEqual(geometry.right + 1);
    await answerBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => answerBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expectNoViewportOverflow();
    const screenshotPath = testInfo.outputPath(
      `selection-answer-${viewport.slug}-${viewport.width}x${viewport.height}.png`,
    );
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`selection-answer-${viewport.slug}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  }

  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await dismiss.press("Enter");
  await expect(card).toHaveCount(0);
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});

test("opens and dismisses the prioritized Runs surface accessibly", async () => {
  const trigger = page.getByRole("button", { name: /^Open runs/u });
  await trigger.focus();
  await trigger.click();
  const center = page.getByRole("dialog", { name: "Runs" });
  await expect(center).toBeVisible();
  await expect(center).toBeFocused();
  await expect(center.getByRole("heading", { name: "Runs" })).toBeVisible();

  const runRows = center.locator(".activity-run");
  if (await runRows.count()) {
    const timestamp = runRows.first().locator("time");
    await expect(timestamp).toHaveCSS("opacity", "1");
    await runRows.first().hover();
    await expect(timestamp).toHaveCSS("opacity", "1");
  } else {
    await expect(center.getByRole("status")).toContainText("All clear");
  }

  const runsControls = center.locator("button:not([disabled])");
  const firstRunsControl = runsControls.first();
  const lastRunsControl = runsControls.last();
  await lastRunsControl.focus();
  await page.keyboard.press("Tab");
  await expect(firstRunsControl).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastRunsControl).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(center).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Runs" })).toBeVisible();
  await page.locator(".activity-center-backdrop").click({ position: { x: 3, y: 3 } });
  await expect(page.getByRole("dialog", { name: "Runs" })).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test("keeps seen distinct from explicit acknowledgement and preserves dismissed run history", async () => {
  const runId = randomUUID();
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const fixtureStore = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  let fixtureSnapshot = fixtureStore.shellSnapshot();
  const fixtureProject = fixtureSnapshot.projects.find(
    ({ id }) => id === fixtureSnapshot.activeProjectId,
  ) ?? fixtureSnapshot.projects[0]
    ?? fixtureStore.createProject("Inertia", workspaceDirectory);
  fixtureSnapshot = fixtureStore.shellSnapshot();
  const fixtureConversation = fixtureSnapshot.conversations.find(
    ({ id }) => id === fixtureSnapshot.activeConversationId,
  ) ?? fixtureSnapshot.conversations.find(
    ({ projectId }) => projectId === fixtureProject.id,
  ) ?? fixtureStore.createConversation(fixtureProject.id, "Runs fixture");
  fixtureStore.selectConversation(fixtureConversation.id);
  fixtureStore.close();

  let database = new Database(databasePath);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO workspace_runs (
      id, kind, project_id, conversation_id, action_id, label, detail,
      status, attention_state, port, started_at, finished_at
    ) VALUES (?, 'source-control', ?, ?, NULL, 'Simulated push failure',
      'The remote rejected this test push.', 'failed', 'unseen', NULL, ?, ?)
  `).run(runId, fixtureProject.id, fixtureConversation.id, now, now);
  database.close();

  await page.reload();
  const trigger = page.getByRole("button", { name: /^Open runs/u });
  await expect(trigger).toHaveAccessibleName(/1 item needs attention/u);
  await trigger.click();
  const center = page.getByRole("dialog", { name: "Runs" });
  const row = center.locator(".activity-run").filter({ hasText: "Simulated push failure" });
  await expect(row.getByText("New", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "View details" }).click();
  await expect(row.getByText("The remote rejected this test push.")).toBeVisible();
  await expect.poll(() => {
    database = new Database(databasePath, { readonly: true });
    const attention = (database.prepare(
      "SELECT attention_state AS state FROM workspace_runs WHERE id = ?",
    ).get(runId) as { state: string }).state;
    database.close();
    return attention;
  }).toBe("seen");
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Acknowledge Simulated push failure" }).click();
  await expect.poll(() => {
    database = new Database(databasePath, { readonly: true });
    const attention = (database.prepare(
      "SELECT attention_state AS state FROM workspace_runs WHERE id = ?",
    ).get(runId) as { state: string }).state;
    database.close();
    return attention;
  }).toBe("acknowledged");
  await expect(trigger).not.toHaveAccessibleName(/needs attention/u);

  await row.getByRole("button", { name: "Dismiss Simulated push failure" }).click();
  await expect(row).toHaveCount(0);
  database = new Database(databasePath, { readonly: true });
  expect(database.prepare(
    "SELECT status, attention_state AS attentionState, detail FROM workspace_runs WHERE id = ?",
  ).get(runId)).toEqual({
    status: "failed",
    attentionState: "dismissed",
    detail: "The remote rejected this test push.",
  });
  database.close();
  await page.keyboard.press("Escape");
  await expect(center).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

test("keeps delegated-agent traces compact while the active composer accepts a parent follow-up", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  let snapshot = store.shellSnapshot();
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    const project = store.createProject("Inertia", workspaceDirectory);
    store.createConversation(project.id, "E2E base conversation");
    snapshot = store.shellSnapshot();
  }
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    throw new Error("Delegated-agent fixture setup failed.");
  }
  const previousConversationId = snapshot.activeConversationId;
  const originalSettings = snapshot.settings;
  let unsupportedConversationId: string | null = null;
  let unsupportedTurnId: string | null = null;
  const conversation = store.createConversation(
    snapshot.activeProjectId,
    "Delegated agent trace fixture",
  );
  const selection = nativeModelSelection({
    providerId: "claude",
    modelId: "claude-sonnet-4-5",
    alias: "Claude Sonnet 4.5",
    reasoningEffort: "high",
  });
  const continuationIdentity = continuationIdentityForSelection(
    selection,
    "native:claude:e2e",
  );
  const requestedAt = new Date(Date.now() - 15_000).toISOString();
  const startedAt = new Date(Date.now() - 12_000).toISOString();
  const { turn } = store.beginAgentTurn({
    conversationId: conversation.id,
    runId: `delegated-e2e-${randomUUID()}`,
    content: "Delegate the research and keep me posted.",
    providerId: "claude",
    modelSelection: selection,
    continuationIdentity,
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: "claude-e2e-session",
    configurationRevision: selection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt,
  });
  store.updateAgentTurnLifecycle(turn.id, {
    status: "running",
    startedAt,
    updatedAt: startedAt,
  });
  store.updateConversation(conversation.id, { status: "running" });
  const parentTrace = store.upsertSubagentTrace({
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    providerId: "claude",
    providerTaskId: "task-evidence-scout",
    providerAgentId: "agent-evidence-scout",
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-evidence-scout",
    providerRole: "researcher",
    providerName: "Evidence Scout",
    status: "running",
    description: "Checking the provider lifecycle and exact task identity.",
    progress: "Reviewing authoritative SDK events.",
    result: null,
    sequence: 1,
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
  })?.trace;
  if (!parentTrace) throw new Error("Parent delegated-agent trace was not created.");
  store.upsertSubagentTrace({
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    providerId: "claude",
    providerTaskId: "task-policy-reader",
    providerAgentId: "agent-policy-reader",
    parentProviderAgentId: parentTrace.providerAgentId,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-policy-reader",
    providerRole: "analyst",
    providerName: "Policy Reader",
    status: "completed",
    description: "Read the typed lifecycle contract.",
    progress: null,
    result: "Confirmed exact IDs and bounded provider-authored text.",
    sequence: 2,
    updatedAt: new Date(Date.now() - 8_000).toISOString(),
  });
  store.upsertSubagentTrace({
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    providerId: "claude",
    providerTaskId: "task-build-verifier",
    providerAgentId: "agent-build-verifier",
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-build-verifier",
    providerRole: "verifier",
    providerName: "Build Verifier",
    status: "failed",
    description: "Run the optional provider check.",
    progress: null,
    result: "The optional check ended without changing the parent run.",
    sequence: 3,
    updatedAt: new Date(Date.now() - 6_000).toISOString(),
  });
  store.updateSettings({
    theme: "dark",
    interfaceScale: "default",
    responseDensity: "default",
  });
  store.close();

  try {
    await page.reload();
    await expect(page.getByRole("heading", {
      name: "Delegated agent trace fixture",
      level: 1,
    })).toBeVisible();

    const disclosure = page.locator(".subagent-disclosure");
    await expect(disclosure.getByText("3 delegated tasks · 1 active", {
      exact: true,
    })).toBeVisible();
    await disclosure.locator("summary").click();
    const delegatedWork = disclosure.getByRole("list", {
      name: "Delegated agent work",
    });
    await expect(delegatedWork.getByText("Evidence Scout", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Policy Reader", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Build Verifier", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Working", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Done", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Failed", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByRole("button", {
      name: "Stop Evidence Scout",
    })).toBeVisible();
    await expect(delegatedWork.getByRole("button", { name: /^Stop /u }))
      .toHaveCount(1);

    const traceRows = delegatedWork.locator("li");
    const parentLeft = await traceRows.filter({ hasText: "Evidence Scout" })
      .evaluate((row) => row.getBoundingClientRect().left);
    const childLeft = await traceRows.filter({ hasText: "Policy Reader" })
      .evaluate((row) => row.getBoundingClientRect().left);
    expect(childLeft).toBeGreaterThan(parentLeft);

    const composer = page.getByRole("region", { name: "Message composer" });
    const textbox = composer.getByRole("textbox", { name: "Message" });
    await expect(textbox).toBeEnabled();
    await expect(textbox).toHaveAttribute(
      "placeholder",
      "Add a follow-up while the agent works…",
    );
    await textbox.fill("Please prioritize the lifecycle evidence.");
    await expect(composer.getByRole("button", { name: "Send follow-up" }))
      .toBeVisible();
    await expect(composer.getByRole("button", { name: "Stop agent" }))
      .toBeVisible();
    await expect(composer.getByRole("button", { name: "Stop agent" }))
      .toHaveAttribute("data-composer-action-state", "stop-ready");

    const wideScreenshot = testInfo.outputPath(
      "delegated-agent-trace-wide-dark.png",
    );
    await page.screenshot({ animations: "disabled", path: wideScreenshot });
    await testInfo.attach("delegated-agent-trace-wide-dark", {
      path: wideScreenshot,
      contentType: "image/png",
    });

    await resizeWindow(760, 800);
    await disclosure.scrollIntoViewIfNeeded();
    await expect(disclosure).toBeVisible();
    await expect(delegatedWork.getByRole("button", {
      name: "Stop Evidence Scout",
    })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Send follow-up" }))
      .toBeVisible();
    await expectNoViewportOverflow();
    const narrowScreenshot = testInfo.outputPath(
      "delegated-agent-trace-narrow-dark.png",
    );
    await page.screenshot({ animations: "disabled", path: narrowScreenshot });
    await testInfo.attach("delegated-agent-trace-narrow-dark", {
      path: narrowScreenshot,
      contentType: "image/png",
    });

    const unsupportedStore = new RuntimeStore(
      databasePath,
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    const unsupportedConversation = unsupportedStore.createConversation(
      snapshot.activeProjectId,
      "Unsupported follow-up fixture",
    );
    const unsupportedSelection = nativeModelSelection({
      providerId: "cursor",
      modelId: "cursor-auto",
      alias: "Cursor Auto",
      reasoningEffort: null,
    });
    const unsupportedIdentity = continuationIdentityForSelection(
      unsupportedSelection,
      "native:cursor:e2e",
    );
    unsupportedStore.updateConversation(unsupportedConversation.id, {
      providerId: "cursor",
      modelSelection: unsupportedSelection,
      continuationIdentity: unsupportedIdentity,
    });
    const unsupportedRequestedAt = new Date(Date.now() - 8_000).toISOString();
    const unsupportedTurn = unsupportedStore.beginAgentTurn({
      conversationId: unsupportedConversation.id,
      runId: `unsupported-follow-up-e2e-${randomUUID()}`,
      content: "Keep this active Cursor turn intact.",
      providerId: "cursor",
      modelSelection: unsupportedSelection,
      continuationIdentity: unsupportedIdentity,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: "cursor-e2e-session",
      configurationRevision:
        unsupportedSelection.backendConfigurationRevision,
      association: "authoritative",
      requestedAt: unsupportedRequestedAt,
    }).turn;
    unsupportedStore.updateAgentTurnLifecycle(unsupportedTurn.id, {
      status: "running",
      startedAt: unsupportedRequestedAt,
      updatedAt: unsupportedRequestedAt,
    });
    unsupportedStore.updateConversation(unsupportedConversation.id, {
      status: "running",
    });
    unsupportedConversationId = unsupportedConversation.id;
    unsupportedTurnId = unsupportedTurn.id;
    unsupportedStore.close();

    await resizeWindow(1440, 920);
    await page.reload();
    await expect(page.getByRole("heading", {
      name: "Unsupported follow-up fixture",
      level: 1,
    })).toBeVisible();
    const unsupportedComposer = page.getByRole("region", {
      name: "Message composer",
    });
    const unsupportedTextbox = unsupportedComposer.getByRole("textbox", {
      name: "Message",
    });
    const preservedDraft =
      "Keep this draft while the unsupported route is active.";
    await unsupportedTextbox.fill(preservedDraft);
    await expect(unsupportedComposer.getByText(
      "Follow-up unavailable",
      { exact: true },
    )).toBeVisible();
    await expect(unsupportedComposer.getByRole("button", {
      name: "Send follow-up",
    })).toHaveCount(0);
    await expect(unsupportedComposer.getByRole("button", {
      name: "Stop agent",
    })).toBeVisible();
    await unsupportedTextbox.press("Enter");
    await expect(unsupportedTextbox).toHaveValue(preservedDraft);
    expect(rendererErrors).toEqual([]);
  } finally {
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    cleanup.updateAgentTurnLifecycle(turn.id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      terminalReason: "e2e-fixture-cleanup",
      updatedAt: new Date().toISOString(),
    });
    if (unsupportedTurnId) {
      cleanup.updateAgentTurnLifecycle(unsupportedTurnId, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        terminalReason: "e2e-fixture-cleanup",
        updatedAt: new Date().toISOString(),
      });
    }
    cleanup.updateSettings(originalSettings);
    cleanup.selectConversation(previousConversationId);
    if (unsupportedConversationId) {
      cleanup.deleteConversation(unsupportedConversationId);
    }
    cleanup.deleteConversation(conversation.id);
    cleanup.close();
    await page.reload();
    await resizeWindow(1440, 920);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
      timeout: 10_000,
    });
  }
});

test("keeps a long transcript bounded, anchored, and keyboard navigable", async () => {
  await resizeWindow(1440, 920);
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  let snapshot = store.shellSnapshot();
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    const project = store.createProject("Inertia", workspaceDirectory);
    store.createConversation(project.id, "E2E base conversation");
    snapshot = store.shellSnapshot();
  }
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) throw new Error("Long transcript fixture setup failed.");
  const previousConversationId = snapshot.activeConversationId;
  const originalTheme = snapshot.settings.theme;
  const conversation = store.createConversation(snapshot.activeProjectId, "Long transcript fixture");
  const fixturePrefix = `virtual-e2e-${randomUUID()}`;
  const baseTime = Date.now() - 180_000;
  for (let index = 0; index < 120; index += 1) {
    const requestedAt = new Date(baseTime + index * 1_000).toISOString();
    const startedAt = new Date(baseTime + index * 1_000 + 100).toISOString();
    const completedAt = new Date(baseTime + index * 1_000 + 500).toISOString();
    const id = `${fixturePrefix}-turn-${String(index).padStart(3, "0")}`;
    const { turn } = store.beginAgentTurn({
      id,
      conversationId: conversation.id,
      runId: `${fixturePrefix}-run-${index}`,
      content: `Virtualized request ${index}`,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      model: "gpt-5.6",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 1,
      association: "authoritative",
      requestedAt,
    });
    store.addActivity({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      kind: "tool",
      title: `Checked fixture ${index}`,
      detail: "A measured work-log row for scroll-anchor validation.",
      status: "completed",
    });
    const answer = store.createMessage(
      conversation.id,
      `Final answer ${index}`,
      "assistant",
      [],
      null,
      completedAt,
    );
    store.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      startedAt,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: "provider-completed",
    });
    store.createTurnGitArtifact({
      id: `${fixturePrefix}-artifact-${index}`,
      turnId: turn.id,
      branch: "main",
      createdAt: completedAt,
    });
    store.completeTurnGitArtifact(turn.id, {
      files: [{
        path: `src/fixtures/turn-${index}.ts`,
        previousPath: null,
        status: "M",
        insertions: 4,
        deletions: 1,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      }],
      insertions: 4,
      deletions: 1,
      status: "ready",
      completeness: "complete",
      patchState: "none",
      capturedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      updatedAt: completedAt,
    });
  }
  store.close();

  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Long transcript fixture", level: 1 })).toBeVisible();
    const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
    if (await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toHaveCount(0);
    }
    const workspacePanel = page.locator(".workspace-panel");
    if (await workspacePanel.isVisible()) {
      await page.getByRole("button", { name: "Close workspace tools" }).first().click();
      await expect(workspacePanel).toBeHidden();
    }

    const transcript = page.getByLabel("Thread transcript");
    const virtualWindow = transcript.getByRole("feed", { name: "120 conversation turns" });
    await expect(virtualWindow).toBeVisible();
    await expect.poll(() => virtualWindow.locator(".response-virtual-item").count()).toBeLessThan(24);
    const minimap = transcript.getByRole("navigation", { name: "Conversation minimap" });
    await expect(minimap).toBeVisible();
    await expect(minimap.getByRole("button")).toHaveCount(48);
    const separation = await page.evaluate(() => {
      const minimapBounds = document.querySelector(".timeline-minimap")?.getBoundingClientRect();
      const visibleTurn = [...document.querySelectorAll<HTMLElement>(".response-turn")]
        .find((turn) => turn.getBoundingClientRect().bottom > 0)
        ?.getBoundingClientRect();
      return minimapBounds && visibleTurn
        ? { minimapRight: minimapBounds.right, turnLeft: visibleTurn.left }
        : null;
    });
    expect(separation).not.toBeNull();
    expect(separation?.minimapRight ?? 0).toBeLessThanOrEqual((separation?.turnLeft ?? 0) + 1);

    await transcript.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    });
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await expect.poll(() => virtualWindow.locator(".response-virtual-item").count()).toBeLessThan(24);
    await page.waitForTimeout(500);
    const expansionProbe = async (summarySelector: string): Promise<{
      anchorId: string;
      sourceId: string;
    } | null> => page.evaluate((selector) => {
      const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
      if (!transcriptElement) return null;
      const viewport = transcriptElement.getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")];
      const sourceIndex = rows.findIndex((row) => {
        const summary = row.querySelector<HTMLElement>(selector);
        if (!summary) return false;
        const bounds = summary.getBoundingClientRect();
        return bounds.top >= viewport.top + 8 && bounds.bottom <= viewport.bottom - 8;
      });
      const source = sourceIndex >= 0 ? rows[sourceIndex] : undefined;
      const anchor = sourceIndex >= 0 ? rows[sourceIndex + 1] : undefined;
      const anchorTurn = anchor?.querySelector<HTMLElement>("[data-turn-id]");
      const sourceTurn = source?.querySelector<HTMLElement>("[data-turn-id]");
      return anchorTurn?.dataset.turnId && sourceTurn?.dataset.turnId
        ? { anchorId: anchorTurn.dataset.turnId, sourceId: sourceTurn.dataset.turnId }
        : null;
    }, summarySelector);
    const expectExpansionAnchored = async (summarySelector: string): Promise<void> => {
      await transcript.evaluate((element) => {
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      });
      await page.waitForTimeout(250);
      let probe = await expansionProbe(summarySelector);
      expect(probe).not.toBeNull();
      if (!probe) return;
      let details = page.locator(`[data-turn-id="${probe.sourceId}"]`).locator(summarySelector).locator("..");
      if (await details.getAttribute("open") !== null) {
        await details.locator("summary").click();
        await page.waitForTimeout(250);
        probe = await expansionProbe(summarySelector);
        expect(probe).not.toBeNull();
        if (!probe) return;
        details = page.locator(`[data-turn-id="${probe.sourceId}"]`).locator(summarySelector).locator("..");
      }
      const before = await page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await details.locator("summary").click();
      await expect.poll(() => page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element, anchorTop) => Math.abs(element.getBoundingClientRect().top - anchorTop),
        before,
      )).toBeLessThanOrEqual(2);
    };
    const expectButtonExpansionAnchored = async (
      selector: string,
      expectedExpandedContent?: string,
    ): Promise<void> => {
      await transcript.evaluate((element) => {
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      });
      await page.waitForTimeout(250);
      const probe = await expansionProbe(selector);
      expect(probe).not.toBeNull();
      if (!probe) return;
      const button = page.locator(`[data-turn-id="${probe.sourceId}"]`).locator(selector);
      const before = await page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await button.focus();
      await button.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "true");
      if (expectedExpandedContent) {
        await expect(
          page.locator(`[data-turn-id="${probe.sourceId}"]`)
            .getByText(expectedExpandedContent, { exact: true }),
        ).toBeVisible();
      }
      await expect.poll(() => page.locator(`[data-turn-id="${probe.anchorId}"]`).evaluate(
        (element, anchorTop) => Math.abs(element.getBoundingClientRect().top - anchorTop),
        before,
      )).toBeLessThanOrEqual(2);
      await button.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "false");
    };
    await expectButtonExpansionAnchored(
      ".turn-run-details-toggle",
      "Execution transcript",
    );
    await expectExpansionAnchored(".turn-changed-files > summary");

    await page.getByRole("button", { name: "Jump to latest" }).click();
    await expect.poll(() => transcript.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(120);
    await transcript.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page.locator(".response-turn:focus")).toHaveCount(1);
    await page.keyboard.press("Alt+Home");
    await expect(page.locator('[data-turn-jump-target="request"]:focus')).toHaveCount(1);
    await page.keyboard.press("Alt+End");
    await expect(page.locator('[data-turn-jump-target="final"]:focus')).toHaveCount(1);
    await page.keyboard.press("Alt+g");
    await expect(page.locator('[data-turn-jump-target="artifact"]:focus')).toHaveCount(1);

    await transcript.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    });
    await page.waitForTimeout(250);
    const captureReaderAnchor = () => page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".message-scroll")?.getBoundingClientRect();
      if (!viewport) return null;
      const row = [...document.querySelectorAll<HTMLElement>("[data-response-row-id]")]
        .find((element) => element.getBoundingClientRect().bottom > viewport.top + 8);
      return row?.dataset.responseRowId
        ? {
            id: row.dataset.responseRowId,
            offset: row.getBoundingClientRect().top - viewport.top,
          }
        : null;
    });
    const captureReaderAnchorById = (rowId: string) => page.evaluate((id) => {
      const viewport = document.querySelector<HTMLElement>(".message-scroll")
        ?.getBoundingClientRect();
      const row = [...document.querySelectorAll<HTMLElement>("[data-response-row-id]")]
        .find((element) => element.dataset.responseRowId === id);
      return row && viewport
        ? {
            id,
            offset: row.getBoundingClientRect().top - viewport.top,
          }
        : null;
    }, rowId);
    const readerAnchor = await captureReaderAnchor();
    expect(readerAnchor).not.toBeNull();
    await resizeWindow(1180, 820);
    await expect.poll(async () => {
      const current = readerAnchor
        ? await captureReaderAnchorById(readerAnchor.id)
        : null;
      return current && readerAnchor
        ? Math.abs(current.offset - readerAnchor.offset) <= 3
        : false;
    }).toBe(true);
    await page.locator("html").evaluate((element, eventName) => {
      window.dispatchEvent(new Event(eventName));
      element.dataset.interfaceScale = "large";
    }, INTERFACE_SCALE_WILL_CHANGE_EVENT);
    // Large type metrics land on slightly different fractional pixels across
    // Electron renderers. Keep the same row within a bounded half-em rhythm
    // derived from the active scale instead of relying on one platform's
    // subpixel rounding.
    const scaleAnchorTolerance = await page.locator("html").evaluate((element) => {
      const mainFontSize = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--ui-font-main"),
      );
      return Math.ceil(mainFontSize / 2) + 1;
    });
    await expect.poll(async () => {
      const current = readerAnchor
        ? await captureReaderAnchorById(readerAnchor.id)
        : null;
      return current && readerAnchor
        ? Math.abs(current.offset - readerAnchor.offset)
        : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(scaleAnchorTolerance);
    await page.locator("html").evaluate((element, eventName) => {
      window.dispatchEvent(new Event(eventName));
      element.dataset.interfaceScale = "default";
    }, INTERFACE_SCALE_WILL_CHANGE_EVENT);

    const visualScenarios = [
      { label: "dark-wide-expanded", theme: "dark" as const, colorScheme: "light" as const, width: 1440, height: 920, sidebar: true, tools: true },
      { label: "light-medium-mixed", theme: "light" as const, colorScheme: "dark" as const, width: 1100, height: 760, sidebar: true, tools: false },
      { label: "system-narrow-collapsed", theme: "system" as const, colorScheme: "dark" as const, width: 760, height: 600, sidebar: false, tools: false },
    ];
    for (const scenario of visualScenarios) {
      const settingsStore = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
      settingsStore.updateSettings({ theme: scenario.theme });
      settingsStore.close();
      await page.emulateMedia({ colorScheme: scenario.colorScheme });
      await resizeWindow(scenario.width, scenario.height);
      await page.reload();
      await expect(page.getByRole("heading", { name: "Long transcript fixture", level: 1 })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        scenario.theme === "system" ? scenario.colorScheme : scenario.theme,
      );

      const scenarioNavigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
      if (await scenarioNavigation.isVisible() !== scenario.sidebar) {
        await page.getByRole("button", { name: "Toggle project navigation" }).click();
      }
      if (scenario.sidebar) await expect(scenarioNavigation).toBeVisible();
      else await expect(scenarioNavigation).toBeHidden();

      const scenarioTools = page.locator(".workspace-panel");
      if (await scenarioTools.isVisible() !== scenario.tools) {
        if (scenario.tools) await page.getByRole("button", { name: "Open workspace tools" }).click();
        else await page.getByRole("button", { name: "Close workspace tools" }).first().click();
      }
      if (scenario.tools) await expect(scenarioTools).toBeVisible();
      else await expect(scenarioTools).toBeHidden();

      const scenarioTranscript = page.getByLabel("Thread transcript");
      await scenarioTranscript.evaluate((element) => {
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      });
      await page.waitForTimeout(350);
      await expect.poll(() => scenarioTranscript.locator(".response-virtual-item").count()).toBeLessThan(24);
      await expect.poll(() => page.evaluate(() => {
        const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
        if (!transcriptElement) return false;
        const viewport = transcriptElement.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")]
          .map((row) => row.getBoundingClientRect())
          .filter((bounds) => bounds.bottom > viewport.top && bounds.top < viewport.bottom)
          .sort((left, right) => left.top - right.top);
        return rows.length > 0 && rows.every((bounds, index) =>
          index === 0 || rows[index - 1]!.bottom <= bounds.top + 1);
      })).toBe(true);
      const geometry = await page.evaluate(() => {
        const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
        const composer = document.querySelector<HTMLElement>(".composer");
        const frame = document.querySelector<HTMLElement>(".workspace-frame");
        if (!transcriptElement || !composer || !frame) return null;
        const viewport = transcriptElement.getBoundingClientRect();
        const composerBounds = composer.getBoundingClientRect();
        const frameBounds = frame.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")]
          .map((row) => row.getBoundingClientRect())
          .filter((bounds) => bounds.bottom > viewport.top && bounds.top < viewport.bottom)
          .sort((left, right) => left.top - right.top);
        const minimap = document.querySelector<HTMLElement>(".timeline-minimap")?.getBoundingClientRect() ?? null;
        const visibleTurn = [...document.querySelectorAll<HTMLElement>(".response-turn")]
          .map((turn) => turn.getBoundingClientRect())
          .find((bounds) => bounds.bottom > viewport.top && bounds.top < viewport.bottom) ?? null;
        return {
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          frameInsideViewport: frameBounds.left >= -1
            && frameBounds.top >= -1
            && frameBounds.right <= window.innerWidth + 1
            && frameBounds.bottom <= window.innerHeight + 1,
          transcriptClearOfComposer: viewport.bottom <= composerBounds.top + 1,
          rowsInsideTranscript: rows.every((bounds) =>
            bounds.left >= viewport.left - 1
            && bounds.right <= viewport.right + 1),
          rowsDoNotOverlap: rows.every((bounds, index) =>
            index === 0 || rows[index - 1]!.bottom <= bounds.top + 1),
          minimapClearOfText: !minimap || !visibleTurn || minimap.right <= visibleTurn.left + 1,
          scrollTop: transcriptElement.scrollTop,
          firstRowTop: rows[0]?.top ?? null,
        };
      });
      expect(geometry).not.toBeNull();
      if (geometry) {
        expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.innerWidth + 1);
        expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.innerHeight + 1);
        expect(geometry.frameInsideViewport).toBe(true);
        expect(geometry.transcriptClearOfComposer).toBe(true);
        expect(geometry.rowsInsideTranscript).toBe(true);
        expect(geometry.rowsDoNotOverlap).toBe(true);
        expect(geometry.minimapClearOfText).toBe(true);
        await page.waitForTimeout(160);
        const stableGeometry = await page.evaluate(() => {
          const transcriptElement = document.querySelector<HTMLElement>(".message-scroll");
          const firstRow = [...document.querySelectorAll<HTMLElement>(".response-virtual-item")]
            .find((row) => {
              const bounds = row.getBoundingClientRect();
              const viewport = transcriptElement?.getBoundingClientRect();
              return viewport && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
            });
          return {
            scrollTop: transcriptElement?.scrollTop ?? null,
            firstRowTop: firstRow?.getBoundingClientRect().top ?? null,
          };
        });
        expect(stableGeometry.scrollTop).not.toBeNull();
        expect(Math.abs((stableGeometry.scrollTop ?? 0) - geometry.scrollTop)).toBeLessThanOrEqual(1);
        if (geometry.firstRowTop !== null && stableGeometry.firstRowTop !== null) {
          expect(Math.abs(stableGeometry.firstRowTop - geometry.firstRowTop)).toBeLessThanOrEqual(1);
        }
      }
      const screenshotPath = test.info().outputPath(`long-thread-${scenario.label}.png`);
      await page.screenshot({ animations: "disabled", path: screenshotPath });
      await test.info().attach(`long-thread-${scenario.label}`, {
        path: screenshotPath,
        contentType: "image/png",
      });
    }
    expect(rendererErrors).toEqual([]);
  } finally {
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    cleanup.updateSettings({ theme: originalTheme });
    cleanup.selectConversation(previousConversationId);
    cleanup.deleteConversation(conversation.id);
    cleanup.close();
    await page.emulateMedia({ colorScheme: "no-preference" });
    await page.reload();
    await resizeWindow(1440, 920);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
      timeout: 10_000,
    });
    const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
    if (!await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeVisible();
    }
    if (!await page.locator(".workspace-panel").isVisible()) {
      await page.getByRole("button", { name: "Open workspace tools" }).click();
      await expect(page.locator(".workspace-panel")).toBeVisible();
    }
  }
});

test("presents the Quiet Ledger states as one calm, responsive conversation", async ({}, testInfo) => {
  await resizeWindow(1440, 920);
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  let snapshot = store.shellSnapshot();
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    const project = store.createProject("Inertia", workspaceDirectory);
    store.createConversation(project.id, "E2E base conversation");
    snapshot = store.shellSnapshot();
  }
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    throw new Error("Quiet Ledger fixture setup failed.");
  }
  const previousConversationId = snapshot.activeConversationId;
  const originalSettings = snapshot.settings;
  const conversation = store.createConversation(snapshot.activeProjectId, "Quiet Ledger visual fixture");
  store.updateSettings({
    theme: "dark",
    interfaceScale: "default",
    responseDensity: "default",
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: true,
    showTimestamps: true,
  });

  const fixturePrefix = `quiet-ledger-e2e-${randomUUID()}`;
  const fixtureBaseTime = Date.now() - 12 * 60_000;
  const codexSelection = nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5.6",
    alias: "GPT-5.6",
    reasoningEffort: "xhigh",
  });
  const kimiProfile = createKimiClaudeBackendProfile({
    id: `${fixturePrefix}:kimi`,
    secretReference: "secret:quiet-ledger-e2e",
    primaryModelId: "k3",
    contextWindowTokens: 1_048_576,
  });
  const kimiSelection = createKimiClaudeModelSelection({ profile: kimiProfile });

  const beginTurn = (
    suffix: string,
    index: number,
    content: string,
    selection = codexSelection,
    providerId: "codex" | "claude" = "codex",
  ) => {
    const requestedAt = new Date(fixtureBaseTime + index * 90_000).toISOString();
    const startedAt = new Date(Date.parse(requestedAt) + 3_000).toISOString();
    const result = store.beginAgentTurn({
      id: `${fixturePrefix}-${suffix}`,
      conversationId: conversation.id,
      runId: `${fixturePrefix}-${suffix}-run`,
      content,
      providerId,
      modelSelection: selection,
      reasoningEffort: selection.reasoningEffort ?? "",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: selection.backendConfigurationRevision,
      association: "authoritative",
      requestedAt,
    });
    store.updateAgentTurnLifecycle(result.turn.id, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });
    return { ...result, requestedAt, startedAt };
  };

  const settleTurn = (
    fixture: ReturnType<typeof beginTurn>,
    answerContent: string,
    status: "completed" | "failed" | "cancelled" = "completed",
  ) => {
    const completedAt = new Date(Date.parse(fixture.startedAt) + 42_000).toISOString();
    const answer = store.createMessage(
      conversation.id,
      answerContent,
      "assistant",
      [],
      fixture.turn.id,
      completedAt,
    );
    store.updateAgentTurnLifecycle(fixture.turn.id, {
      status,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: status === "completed"
        ? "provider-completed"
        : status === "failed"
          ? "provider-failed"
          : "user-cancelled",
    });
    return answer;
  };

  const completed = beginTurn(
    "completed",
    0,
    "Explain the provider routing issue and leave a concise implementation summary.",
  );
  for (let index = 0; index < 8; index += 1) {
    store.addActivity({
      conversationId: conversation.id,
      runId: completed.turn.runId,
      turnId: completed.turn.id,
      kind: index % 3 === 0 ? "file" : index % 3 === 1 ? "tool" : "command",
      title: `Verified implementation step ${index + 1}`,
      detail: index === 7 ? "The focused renderer checks are green." : null,
      status: "completed",
    });
  }
  const completedAnswer = settleTurn(completed, [
    "## Result",
    "",
    "The provider route now keeps its historical model identity while the operational work stays in a compact ledger.",
    "",
    "> Historical attribution comes from the persisted route, never today’s selected profile.",
    "",
    "The answer treats `ModelSelection` as the authoritative identity source.",
    "",
    "- The answer remains outside the execution rail.",
    "- Queue and execution timings use the persisted turn lifecycle.",
    "- Changed files stay available as a quiet disclosure.",
    "",
    "| Surface | Presentation | Responsive contract | Overflow owner | Verification |",
    "| --- | --- | --- | --- | --- |",
    "| Final answer | Editorial document | Stays inside the transcript column | Table viewport | Narrow fixture |",
    "| Work history | Compact ledger | Keeps activity labels readable | Activity row | Split fixture |",
    "",
    "```ts",
    "const routeIdentity = \"authoritative\"; const deliberatelyLongVerificationCommand = \"pnpm vitest run tests/renderer/quiet-ledger-responsive.test.ts --coverage --reporter=verbose\";",
    "```",
  ].join("\n"));
  store.createTurnGitArtifact({
    id: `${fixturePrefix}-completed-artifact`,
    turnId: completed.turn.id,
    branch: "main",
    createdAt: completedAnswer.createdAt,
  });
  store.completeTurnGitArtifact(completed.turn.id, {
    files: [
      {
        path: "src/renderer/src/components/ResponseTimeline.tsx",
        previousPath: null,
        status: "M",
        insertions: 84,
        deletions: 21,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      },
      {
        path: "src/renderer/src/styles.css",
        previousPath: null,
        status: "M",
        insertions: 36,
        deletions: 8,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      },
      {
        path: "tests/e2e/app.spec.ts",
        previousPath: null,
        status: "M",
        insertions: 42,
        deletions: 0,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      },
    ],
    insertions: 162,
    deletions: 29,
    status: "ready",
    completeness: "complete",
    patchState: "none",
    capturedAt: completedAnswer.createdAt,
    terminalAssistantMessageId: completedAnswer.id,
    updatedAt: completedAnswer.createdAt,
  });

  const detailed = beginTurn(
    "details",
    1,
    "Show completed operational details only when I ask for them.",
  );
  for (const [index, title] of [
    "Inspected the current response lifecycle",
    "Measured the transcript column",
    "Refined the execution rail",
    "Validated scroll anchoring",
    "Ran the focused renderer suite",
  ].entries()) {
    store.addActivity({
      conversationId: conversation.id,
      runId: detailed.turn.runId,
      turnId: detailed.turn.id,
      kind: index === 4 ? "command" : index === 1 ? "file" : "tool",
      title,
      detail: index === 3 ? "The visible row stays fixed while disclosure height changes." : null,
      status: "completed",
    });
  }
  settleTurn(
    detailed,
    "The completed work is collapsed by default and remains available through the keyboard-accessible Details row.",
  );

  const kimi = beginTurn(
    "kimi",
    2,
    "Keep this Kimi-through-Claude answer historically accurate.",
    kimiSelection,
    "claude",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: kimi.turn.runId,
    turnId: kimi.turn.id,
    kind: "tool",
    title: "Resolved the persisted backend route",
    detail: null,
    status: "completed",
  });
  settleTurn(
    kimi,
    "This answer is attributed from the persisted model selection: Claude harness, Kimi backend, K3 model.",
  );

  const warning = beginTurn(
    "warning",
    3,
    "Keep the successful result and make its provider warning easy to find.",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: warning.turn.runId,
    turnId: warning.turn.id,
    kind: "tool",
    title: "Applied the compatible fallback",
    detail: null,
    status: "completed",
  });
  store.addActivity({
    conversationId: conversation.id,
    runId: warning.turn.runId,
    turnId: warning.turn.id,
    kind: "status",
    title: "Warning: optional provider capability skipped",
    detail: "The final result is complete, but one optional capability was unavailable.",
    status: "completed",
  });
  settleTurn(
    warning,
    "The compatible fallback completed successfully; the optional provider warning remains visible above this answer.",
  );

  const failed = beginTurn(
    "failed",
    4,
    "Run the verification and keep any actionable failure visible.",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: failed.turn.runId,
    turnId: failed.turn.id,
    kind: "tool",
    title: "Prepared the verification environment",
    detail: null,
    status: "completed",
  });
  store.addActivity({
    conversationId: conversation.id,
    runId: failed.turn.runId,
    turnId: failed.turn.id,
    kind: "command",
    title: "Renderer verification failed",
    detail: "One actionable assertion needs attention.",
    status: "failed",
  });
  settleTurn(
    failed,
    "The verification stopped at one actionable renderer failure. The failed command remains visible above this answer.",
    "failed",
  );

  const cancelled = beginTurn(
    "cancelled",
    5,
    "Stop this run and keep its settled state visible.",
  );
  store.addActivity({
    conversationId: conversation.id,
    runId: cancelled.turn.runId,
    turnId: cancelled.turn.id,
    kind: "tool",
    title: "Inspected the cancellation boundary",
    detail: null,
    status: "completed",
  });
  settleTurn(
    cancelled,
    "The run stopped at the requested boundary.",
    "cancelled",
  );

  const approval = beginTurn(
    "approval",
    6,
    "Run the focused renderer verification after I approve it.",
  );
  const approvalUpdatedAt = new Date(
    Date.parse(approval.startedAt) + 18_000,
  ).toISOString();
  store.updateAgentTurnLifecycle(approval.turn.id, {
    status: "waiting-for-approval",
    updatedAt: approvalUpdatedAt,
  });
  const approvalRequest = {
    id: `${fixturePrefix}-approval-request`,
    providerId: "codex",
    conversationId: conversation.id,
    runId: approval.turn.runId,
    turnId: approval.turn.id,
    kind: "command",
    title: "Approve the focused renderer verification",
    detail: "This verifies the updated response and composer surfaces.",
    command: "npm run test -- tests/renderer/quiet-ledger-responsive.test.ts",
    cwd: workspaceDirectory,
    reason: "The supervised command needs your approval before it runs.",
    networkScope: null,
    permissionRoots: [],
    availableDecisions: ["cancel", "deny", "approve"],
  };

  const providerQuestion = beginTurn(
    "provider-question",
    7,
    "Ask which provider-specific presentation should remain visible.",
    kimiSelection,
    "claude",
  );
  const questionUpdatedAt = new Date(
    Date.parse(providerQuestion.startedAt) + 16_000,
  ).toISOString();
  store.updateAgentTurnLifecycle(providerQuestion.turn.id, {
    status: "waiting-for-input",
    updatedAt: questionUpdatedAt,
  });
  const providerInputRequest = {
    id: `${fixturePrefix}-provider-input`,
    providerId: "claude",
    conversationId: conversation.id,
    runId: providerQuestion.turn.runId,
    turnId: providerQuestion.turn.id,
    autoResolutionMs: null,
    questions: [{
      id: `${fixturePrefix}-provider-direction`,
      header: "Presentation",
      question: "Which provider presentation should this fixture preserve?",
      isOther: true,
      isSecret: false,
      allowMultiple: false,
      options: [
        {
          id: "quiet",
          label: "Quiet ledger",
          description: "Keep completed operational work collapsed.",
        },
        {
          id: "expanded",
          label: "Expanded work",
          description: "Keep the full operational history visible.",
        },
      ],
    }],
  };

  const active = beginTurn(
    "active",
    8,
    "Refine the response experience and keep me oriented while the work is running.",
  );
  const activeAt = (seconds: number) =>
    new Date(Date.parse(active.startedAt) + seconds * 1_000).toISOString();
  store.addActivity({
    conversationId: conversation.id,
    runId: active.turn.runId,
    turnId: active.turn.id,
    kind: "status",
    title: "Connected to the local runtime",
    detail: null,
    status: "completed",
    createdAt: activeAt(2),
  });
  store.createMessage(
    conversation.id,
    "I’m tracing the current response path before changing the presentation.",
    "assistant",
    [],
    active.turn.id,
    activeAt(4),
  );
  for (const [seconds, kind, title, status] of [
    [6, "command", "Inspected the repository", "completed"],
    [8, "tool", "Reading provider routing", "completed"],
  ] as const) {
    store.addActivity({
      conversationId: conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind,
      title,
      detail: null,
      status,
      createdAt: activeAt(seconds),
    });
  }
  store.createMessage(
    conversation.id,
    "The event order is sound; I’m applying the focused UI change and validating it now.",
    "assistant",
    [],
    active.turn.id,
    activeAt(10),
  );
  for (const [seconds, kind, title, status] of [
    [12, "file", "Editing backend adapter", "running"],
    [14, "command", "Running focused tests", "running"],
  ] as const) {
    store.addActivity({
      conversationId: conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind,
      title,
      detail: null,
      status,
      createdAt: activeAt(seconds),
    });
  }
  store.close();

  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    const CapturedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList) {
        const socket = Reflect.construct(target, argumentsList) as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    Object.defineProperty(window, "__task41WebSockets", {
      configurable: true,
      value: sockets,
    });
    window.WebSocket = CapturedWebSocket as typeof WebSocket;
  });

  const publishFixtureEvent = async (event: object): Promise<void> => {
    await page.evaluate((fixtureEvent) => {
      const sockets = Reflect.get(window, "__task41WebSockets") as
        | WebSocket[]
        | undefined;
      const socket = sockets?.find(
        ({ readyState }) => readyState === WebSocket.OPEN,
      );
      if (!socket) {
        throw new Error("The Quiet Ledger fixture WebSocket is unavailable.");
      }
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify(fixtureEvent),
      }));
    }, event);
  };

  const captureScenario = async (name: string): Promise<void> => {
    const screenshotPath = testInfo.outputPath(`quiet-ledger-${name}.png`);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`quiet-ledger-${name}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  };
  const captureElementScenario = async (
    name: string,
    target: Locator,
  ): Promise<void> => {
    const screenshotPath = testInfo.outputPath(`quiet-ledger-${name}.png`);
    await target.screenshot({ animations: "disabled", path: screenshotPath });
    await testInfo.attach(`quiet-ledger-${name}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  };

  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Quiet Ledger visual fixture", level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
    if (!await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeVisible();
    }
    const workspacePanel = page.locator(".workspace-panel");
    if (await workspacePanel.isVisible()) {
      await page.getByRole("button", { name: "Close workspace tools" }).first().click();
      await expect(workspacePanel).toBeHidden();
    }

    const activeTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await activeTurn.scrollIntoViewIfNeeded();
    await expect(activeTurn.locator(".turn-execution-rail.is-live")).toBeVisible();
    await expect(activeTurn.locator(".turn-commentary-row")).toHaveCount(2);
    await expect(activeTurn.locator(".turn-activity-group")).toHaveCount(2);
    await expect(activeTurn.locator('[data-activity-visibility="recent"]')).toHaveCount(2);
    await expect(activeTurn.getByRole("button", { name: "+1 previous tool call" })).toHaveCount(2);
    await expect(activeTurn.getByRole("button", { name: "Stop Codex · OpenAI run" })).toBeVisible();
    await expect(activeTurn.locator(".turn-working-elapsed")).toHaveAttribute("aria-live", "off");
    await captureScenario("active-turn");
    const normalMotion = await activeTurn.locator(
      "[data-active-work-region]",
    ).evaluate((element) => ({
      mediaMatches: window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches,
      washAnimation: getComputedStyle(element, "::before").animationName,
    }));
    expect(normalMotion).toEqual({
      mediaMatches: false,
      washAnimation: "active-work-tonal-wash",
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedMotion = await activeTurn.locator(
      "[data-active-work-region]",
    ).evaluate((element) => {
      const runningGlyph = element.querySelector(
        ".agent-activity.is-running svg",
      );
      return {
        mediaMatches: window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches,
        washAnimation: getComputedStyle(element, "::before").animationName,
        glyphAnimation: runningGlyph
          ? getComputedStyle(runningGlyph).animationName
          : null,
      };
    });
    expect(reducedMotion).toEqual({
      mediaMatches: true,
      washAnimation: "none",
      glyphAnimation: "none",
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await publishFixtureEvent({
      type: "agent.approval.requested",
      request: approvalRequest,
    });
    await publishFixtureEvent({
      type: "agent.input.requested",
      request: providerInputRequest,
    });

    const approvalTurn = page.locator(
      `[data-turn-id="${approval.turn.id}"]`,
    );
    await approvalTurn.scrollIntoViewIfNeeded();
    const approvalCard = approvalTurn.locator(
      '[data-agent-request-state="approval"]',
    );
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard).toContainText(
      "Approve the focused renderer verification",
    );
    await expect(approvalCard).toContainText(
      "Codex paused for your review.",
    );
    const approveOnce = approvalCard.getByRole("button", {
      name: "Approve once",
    });
    await approveOnce.focus();
    await expect(approveOnce).toBeFocused();
    await captureScenario("approval-dark-1440x920");

    const providerQuestionTurn = page.locator(
      `[data-turn-id="${providerQuestion.turn.id}"]`,
    );
    await providerQuestionTurn.scrollIntoViewIfNeeded();
    const providerQuestionCard = providerQuestionTurn.locator(
      '[data-agent-request-state="question"]',
    );
    await expect(providerQuestionCard).toBeVisible();
    await expect(providerQuestionCard).toContainText(
      "Claude needs your input",
    );
    await expect(providerQuestionCard).toContainText(
      "Which provider presentation should this fixture preserve?",
    );
    const firstQuestionOption = providerQuestionCard.getByRole("radio", {
      name: /Quiet ledger/u,
    });
    await firstQuestionOption.focus();
    await expect(firstQuestionOption).toBeFocused();
    await captureScenario("provider-question-dark-1440x920");

    const completedTurn = page.locator(`[data-turn-id="${completed.turn.id}"]`);
    const detailedTurn = page.locator(`[data-turn-id="${detailed.turn.id}"]`);
    const kimiTurn = page.locator(`[data-turn-id="${kimi.turn.id}"]`);
    await completedTurn.scrollIntoViewIfNeeded();
    for (const successfulFixture of [completed, detailed, kimi]) {
      const successfulTurn = page.locator(`[data-turn-id="${successfulFixture.turn.id}"]`);
      await expect(successfulTurn.locator(".turn-settled-summary")).toHaveCount(0);
      await expect(successfulTurn.locator(".turn-duration")).toHaveText("Worked 42s");
      await expect(successfulTurn.getByText("Worked 42s", { exact: true })).toHaveCount(1);
    }
    const successfulGeometry = await Promise.all(
      [completedTurn, detailedTurn, kimiTurn].map((successfulTurn) =>
        successfulTurn.evaluate((element) => {
          const request = element.querySelector<HTMLElement>(
            '[data-turn-layer="user-request"]',
          )?.getBoundingClientRect();
          const answer = element.querySelector<HTMLElement>(
            '[data-turn-layer="final-answer"]',
          )?.getBoundingClientRect();
          const metadata = element.querySelector<HTMLElement>(
            ".turn-meta",
          )?.getBoundingClientRect();
          return request && answer && metadata
            ? {
                requestToAnswer: answer.top - request.bottom,
                answerToMetadata: metadata.top - answer.bottom,
                answerHeight: answer.height,
                metadataHeight: metadata.height,
              }
            : null;
        })),
    );
    for (const geometry of successfulGeometry) {
      expect(geometry).not.toBeNull();
      if (!geometry) continue;
      expect(geometry.requestToAnswer).toBeGreaterThanOrEqual(8);
      expect(geometry.requestToAnswer).toBeLessThanOrEqual(17);
      expect(geometry.answerToMetadata).toBeGreaterThanOrEqual(5);
      expect(geometry.answerToMetadata).toBeLessThanOrEqual(13);
      expect(geometry.metadataHeight).toBeLessThanOrEqual(
        geometry.answerHeight,
      );
    }
    const successfulTurnSeparation = await Promise.all([
      completedTurn.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
      detailedTurn.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
      kimiTurn.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
    ]);
    expect(successfulTurnSeparation[1]!.top - successfulTurnSeparation[0]!.bottom)
      .toBeGreaterThanOrEqual(28);
    expect(successfulTurnSeparation[2]!.top - successfulTurnSeparation[1]!.bottom)
      .toBeGreaterThanOrEqual(28);
    const completedLayers = await completedTurn.locator(":scope > [data-turn-layer]").evaluateAll(
      (elements) => elements.map((element) => element.getAttribute("data-turn-layer")),
    );
    expect(completedLayers).toEqual([
      "user-request",
      "agent-execution",
      "final-answer",
      "supporting-ledger",
    ]);
    await expect(completedTurn.locator('[data-turn-layer="agent-execution"] [data-turn-layer="final-answer"]')).toHaveCount(0);
    await expect(completedTurn.locator('[data-turn-layer="final-answer"]')).toContainText("The provider route now");
    await expect(completedTurn.locator('[data-final-answer-identity="historical-model-selection"]'))
      .toHaveText("Codex · OpenAI · GPT-5.6");
    const turnMetaPrimary = completedTurn.locator(".turn-meta-primary");
    const runDetailsToggle = completedTurn.getByRole("button", { name: "Run details" });
    const runDetails = completedTurn.locator(".turn-run-details");
    await expect(turnMetaPrimary).toContainText("Completed");
    await expect(turnMetaPrimary).toContainText("Worked 42s");
    await expect(turnMetaPrimary).not.toContainText(codexSelection.harnessId);
    await expect(turnMetaPrimary).not.toContainText(codexSelection.backendProfileId);
    await expect(turnMetaPrimary).not.toContainText(codexSelection.modelId);
    await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "false");
    await runDetailsToggle.click();
    await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(runDetails).toBeVisible();
    await expect(runDetails).toContainText("Harness ID");
    await expect(runDetails).toContainText(codexSelection.harnessId);
    await expect(runDetails).toContainText("Requested alias");
    await expect(runDetails).toContainText(codexSelection.alias ?? "Not requested");
    await expect(runDetails).toContainText("Session continuation");
    await expect(runDetails).toContainText("Execution transcript");
    await expect(runDetails.getByRole("list", { name: "Agent work transcript" })).toBeVisible();
    await captureElementScenario("completed-run-details", completedTurn.locator(".turn-meta"));
    await runDetailsToggle.click();
    await expect(runDetailsToggle).toHaveAttribute("aria-expanded", "false");
    const changedFiles = completedTurn.getByLabel("Changed by this turn");
    const changedFilesSummary = changedFiles.locator("summary");
    await expect(changedFiles).toContainText("3 files changed");
    await expect(changedFiles).toContainText("+162 −29 · main");
    await expect(changedFilesSummary).toHaveAttribute("aria-expanded", "false");
    const supportingGeometry = await completedTurn.evaluate((element) => {
      const metadata = element.querySelector<HTMLElement>(".turn-meta")
        ?.getBoundingClientRect();
      const changedFiles = element.querySelector<HTMLElement>(
        ".turn-changed-files",
      )?.getBoundingClientRect();
      const runDetailsToggle = element.querySelector<HTMLElement>(
        ".turn-run-details-toggle",
      )?.getBoundingClientRect();
      const changedFilesSummary = element.querySelector<HTMLElement>(
        ".turn-changed-files > summary",
      )?.getBoundingClientRect();
      return metadata && changedFiles && runDetailsToggle && changedFilesSummary
        ? {
            metadataToArtifact: changedFiles.top - metadata.bottom,
            runDetailsTargetHeight: runDetailsToggle.height,
            changedFilesTargetHeight: changedFilesSummary.height,
          }
        : null;
    });
    expect(supportingGeometry).not.toBeNull();
    if (supportingGeometry) {
      expect(supportingGeometry.metadataToArtifact).toBeGreaterThanOrEqual(0);
      expect(supportingGeometry.metadataToArtifact).toBeLessThanOrEqual(6);
      expect(supportingGeometry.runDetailsTargetHeight).toBeGreaterThanOrEqual(26);
      expect(supportingGeometry.changedFilesTargetHeight).toBeGreaterThanOrEqual(32);
    }
    await changedFilesSummary.click();
    await expect(changedFilesSummary).toHaveAttribute("aria-expanded", "true");
    await expect(changedFiles.locator('[role="listitem"]')).toHaveCount(3);
    await expect(changedFiles.getByRole("button", { name: "Open exact turn diff" })).toBeDisabled();
    await expect(changedFiles).toContainText(
      "The historical file summary is available without a stored patch.",
    );
    await expect(changedFiles.getByRole("button", {
      name: "Open src/renderer/src/components/ResponseTimeline.tsx",
    })).toBeEnabled();
    await captureElementScenario("completed-changed-files", changedFiles);
    await changedFilesSummary.click();
    await expect(changedFilesSummary).toHaveAttribute("aria-expanded", "false");
    await captureScenario("completed-answer");
    await captureElementScenario(
      "rich-markdown-dark",
      completedTurn.locator('[data-turn-layer="final-answer"]'),
    );

    await detailedTurn.scrollIntoViewIfNeeded();
    await captureScenario("settled-history-dark-1440x920");
    await detailedTurn.scrollIntoViewIfNeeded();
    const detailsSummary = detailedTurn.getByRole("button", { name: "Run details" });
    await expect(detailsSummary).toHaveAttribute("aria-expanded", "false");
    const followingKimiTurn = page.locator(`[data-turn-id="${kimi.turn.id}"]`);
    const beforeFollowingTurnTop = await followingKimiTurn.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    await detailsSummary.click();
    await expect(detailsSummary).toHaveAttribute("aria-expanded", "true");
    await expect(detailedTurn.locator(".turn-run-work-details")).toBeVisible();
    await expect.poll(() => followingKimiTurn.evaluate(
      (element, top) => Math.abs(element.getBoundingClientRect().top - top),
      beforeFollowingTurnTop,
    )).toBeLessThanOrEqual(2);
    await captureScenario("expanded-details");

    await kimiTurn.scrollIntoViewIfNeeded();
    await expect(kimiTurn.locator('[data-final-answer-identity="historical-model-selection"]'))
      .toHaveText("Claude · Kimi · K3");
    await captureScenario("kimi-through-claude");

    const warningTurn = page.locator(`[data-turn-id="${warning.turn.id}"]`);
    await warningTurn.scrollIntoViewIfNeeded();
    await expect(warningTurn.locator(".turn-settled-summary")).toContainText("Worked for 42s · 1 action");
    await expect(warningTurn.locator('[data-activity-severity="warning"]'))
      .toContainText("optional provider capability skipped");
    await expect(warningTurn.locator('[data-activity-severity="warning"]')).toBeVisible();

    const failedTurn = page.locator(`[data-turn-id="${failed.turn.id}"]`);
    await failedTurn.scrollIntoViewIfNeeded();
    await expect(failedTurn.locator(".turn-settled-summary")).toContainText("Failed after 42s · 2 actions");
    await expect(failedTurn.locator(".agent-activity.is-failed")).toContainText("Renderer verification failed");
    await expect(failedTurn.locator(".agent-activity.is-failed")).toBeVisible();
    const exceptionalGeometry = await Promise.all(
      [warningTurn, failedTurn].map((exceptionalTurn) =>
        exceptionalTurn.evaluate((element) => {
          const request = element.querySelector<HTMLElement>(
            '[data-turn-layer="user-request"]',
          )?.getBoundingClientRect();
          const execution = element.querySelector<HTMLElement>(
            '[data-turn-layer="agent-execution"]',
          )?.getBoundingClientRect();
          const answer = element.querySelector<HTMLElement>(
            '[data-turn-layer="final-answer"]',
          )?.getBoundingClientRect();
          const metadata = element.querySelector<HTMLElement>(
            ".turn-meta",
          )?.getBoundingClientRect();
          return request && execution && answer && metadata
            ? {
                requestToExecution: execution.top - request.bottom,
                executionToAnswer: answer.top - execution.bottom,
                answerToMetadata: metadata.top - answer.bottom,
                metadataHeight: metadata.height,
                answerHeight: answer.height,
              }
            : null;
        })),
    );
    for (const geometry of exceptionalGeometry) {
      expect(geometry).not.toBeNull();
      if (!geometry) continue;
      expect(geometry.requestToExecution).toBeGreaterThanOrEqual(8);
      expect(geometry.requestToExecution).toBeLessThanOrEqual(17);
      expect(geometry.executionToAnswer).toBeGreaterThanOrEqual(8);
      expect(geometry.executionToAnswer).toBeLessThanOrEqual(17);
      expect(geometry.answerToMetadata).toBeGreaterThanOrEqual(5);
      expect(geometry.answerToMetadata).toBeLessThanOrEqual(13);
      expect(geometry.metadataHeight).toBeLessThanOrEqual(
        geometry.answerHeight,
      );
    }
    await captureScenario("failed-tool");
    await captureScenario("exception-history-dark-1440x920");

    const cancelledTurn = page.locator(`[data-turn-id="${cancelled.turn.id}"]`);
    await cancelledTurn.scrollIntoViewIfNeeded();
    await expect(cancelledTurn.locator(".turn-settled-summary"))
      .toContainText("Stopped after 42s · 1 action");
    await expect(cancelledTurn.locator(".turn-settled-summary")).toBeVisible();

    const lightSettings = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    lightSettings.updateSettings({ theme: "light" });
    lightSettings.close();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const lightCompletedTurn = page.locator(`[data-turn-id="${completed.turn.id}"]`);
    await lightCompletedTurn.scrollIntoViewIfNeeded();
    await expect(lightCompletedTurn.locator(".turn-settled-summary")).toHaveCount(0);
    await expect(lightCompletedTurn.getByText("Worked 42s", { exact: true })).toHaveCount(1);
    await captureElementScenario(
      "rich-markdown-light",
      lightCompletedTurn.locator('[data-turn-layer="final-answer"]'),
    );
    await page.locator(`[data-turn-id="${kimi.turn.id}"]`).scrollIntoViewIfNeeded();
    await captureScenario("settled-history-light-1440x920");
    await page.locator(`[data-turn-id="${failed.turn.id}"]`).scrollIntoViewIfNeeded();
    await captureScenario("exception-history-light-1440x920");

    const darkSettings = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    darkSettings.updateSettings({ theme: "dark" });
    darkSettings.close();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(`[data-turn-id="${completed.turn.id}"] .turn-settled-summary`))
      .toHaveCount(0);

    await resizeWindow(760, 680);
    if (await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeHidden();
    }
    await kimiTurn.scrollIntoViewIfNeeded();
    await captureScenario("settled-history-narrow-760x680");
    await activeTurn.scrollIntoViewIfNeeded();
    await expect(activeTurn.getByRole("button", { name: "Stop Codex · OpenAI run" })).toBeVisible();
    await expectNoViewportOverflow();
    const narrowGeometry = await activeTurn.evaluate((element) => {
      const turn = element.getBoundingClientRect();
      const request = element.querySelector<HTMLElement>(".turn-user-request")?.getBoundingClientRect();
      const execution = element.querySelector<HTMLElement>(".turn-execution-rail")?.getBoundingClientRect();
      return {
        turnWidth: turn.width,
        requestInside: request
          ? request.left >= turn.left - 1 && request.right <= turn.right + 1
          : false,
        executionInside: execution
          ? execution.left >= turn.left - 1 && execution.right <= turn.right + 1
          : false,
      };
    });
    expect(narrowGeometry.turnWidth).toBeGreaterThan(0);
    expect(narrowGeometry.requestInside).toBe(true);
    expect(narrowGeometry.executionInside).toBe(true);
    await captureScenario("narrow-workspace");

    await completedTurn.scrollIntoViewIfNeeded();
    await runDetailsToggle.click();
    await changedFilesSummary.click();
    await expect(runDetails).toBeVisible();
    await expect(changedFiles.locator('[role="listitem"]')).toHaveCount(3);
    const narrowCompletedGeometry = await completedTurn.evaluate((element) => {
      const turn = element.getBoundingClientRect();
      const contained = (selector: string) => {
        const target = element.querySelector<HTMLElement>(selector)
          ?.getBoundingClientRect();
        return Boolean(
          target
          && target.left >= turn.left - 1
          && target.right <= turn.right + 1,
        );
      };
      const code = element.querySelector<HTMLElement>(
        ".response-code-block pre",
      );
      const table = element.querySelector<HTMLElement>(
        ".response-table-scroll",
      );
      const changedRows = [
        ...element.querySelectorAll<HTMLElement>(
          ".turn-changed-files [role='listitem']",
        ),
      ];
      return {
        requestInside: contained(".turn-user-request"),
        executionAbsent: !element.querySelector(".turn-execution-rail"),
        answerInside: contained(".turn-final-answer-document"),
        runDetailsInside: contained(".turn-run-details"),
        changedFilesInside: contained(".turn-changed-files"),
        codeShellInside: contained(".response-code-block"),
        tableShellInside: contained(".response-table-shell"),
        codeOverflowOwned: Boolean(
          code
          && code.scrollWidth > code.clientWidth + 1
          && getComputedStyle(code).overflowX === "auto",
        ),
        tableOverflowOwned: Boolean(
          table
          && getComputedStyle(table).overflowX === "auto",
        ),
        changedRowsInside: changedRows.every((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.left >= turn.left - 1 && bounds.right <= turn.right + 1;
        }),
      };
    });
    expect(narrowCompletedGeometry).toEqual({
      requestInside: true,
      executionAbsent: true,
      answerInside: true,
      runDetailsInside: true,
      changedFilesInside: true,
      codeShellInside: true,
      tableShellInside: true,
      codeOverflowOwned: true,
      tableOverflowOwned: true,
      changedRowsInside: true,
    });
    await captureScenario("narrow-completed-surfaces");
    await captureElementScenario(
      "narrow-rich-markdown",
      completedTurn.locator('[data-turn-layer="final-answer"]'),
    );
    await captureElementScenario(
      "narrow-changed-files",
      changedFiles,
    );
    await runDetailsToggle.click();
    await changedFilesSummary.click();

    const recentCompletion = new RuntimeStore(
      databasePath,
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    const recentCompletedAt = activeAt(52);
    const recentAnswer = recentCompletion.createMessage(
      conversation.id,
      "The active run has now settled into the same quiet historical presentation.",
      "assistant",
      [],
      active.turn.id,
      recentCompletedAt,
    );
    recentCompletion.updateAgentTurnLifecycle(active.turn.id, {
      status: "completed",
      completedAt: recentCompletedAt,
      updatedAt: recentCompletedAt,
      terminalAssistantMessageId: recentAnswer.id,
      terminalReason: "provider-completed",
    });
    recentCompletion.createTurnGitArtifact({
      id: `${fixturePrefix}-recent-pending-artifact`,
      turnId: active.turn.id,
      branch: "main",
      status: "pending",
      completeness: "partial",
      createdAt: recentCompletedAt,
    });
    recentCompletion.close();
    await page.reload();
    const recentlySettledTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(recentlySettledTurn.locator(".turn-settled-summary")).toHaveCount(0);
    await expect(recentlySettledTurn.locator(".turn-duration")).toHaveText("Worked 52s");
    await expect(recentlySettledTurn.getByText("Worked 52s", { exact: true })).toHaveCount(1);
    await expect(recentlySettledTurn.locator(".turn-changed-files.is-pending"))
      .toContainText("Capturing changes…");
    await expect(recentlySettledTurn.locator(".turn-execution-rail.is-live")).toHaveCount(0);
    await expect(recentlySettledTurn.locator("[data-active-work-region]")).toHaveCount(0);
    await expect(recentlySettledTurn.getByRole("button", { name: /^Stop /u })).toHaveCount(0);

    await page.reload();
    const reloadedPendingTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(reloadedPendingTurn.locator(".turn-changed-files.is-pending"))
      .toContainText("Capturing changes…");
    await expect(reloadedPendingTurn.locator(".turn-execution-rail.is-live")).toHaveCount(0);
    await expect(reloadedPendingTurn.locator("[data-active-work-region]")).toHaveCount(0);
    await expect(reloadedPendingTurn.getByRole("button", { name: /^Stop /u })).toHaveCount(0);

    const finalizeRecentArtifact = new RuntimeStore(
      databasePath,
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    finalizeRecentArtifact.completeTurnGitArtifact(active.turn.id, {
      files: [{
        path: "src/renderer/src/components/ResponseTimeline.tsx",
        previousPath: null,
        status: "modified",
        insertions: 12,
        deletions: 3,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
        binary: false,
      }],
      insertions: 12,
      deletions: 3,
      status: "ready",
      completeness: "complete",
      patchState: "none",
      capturedAt: activeAt(53),
      terminalAssistantMessageId: recentAnswer.id,
      updatedAt: activeAt(53),
    });
    finalizeRecentArtifact.close();
    await page.reload();
    const finalizedRecentTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(finalizedRecentTurn.locator(".turn-changed-files.is-pending")).toHaveCount(0);
    await expect(finalizedRecentTurn.getByLabel("Changed by this turn"))
      .toContainText("1 file changed");
    await expect(finalizedRecentTurn.locator(".turn-execution-rail.is-live")).toHaveCount(0);
    await expect(finalizedRecentTurn.locator("[data-active-work-region]")).toHaveCount(0);
    await expect(finalizedRecentTurn.getByRole("button", { name: /^Stop /u })).toHaveCount(0);

    const beforeReconnect = await runtimeSnapshot();
    const rendererGenerationBeforeReconnect = await page.locator(".app-shell")
      .getAttribute("data-runtime-generation");
    await electronApp.evaluate((_electron) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        crash: () => RuntimeTestSnapshot;
      } | undefined;
      if (!runtime) throw new Error("The test runtime supervisor is unavailable");
      runtime.crash();
    });
    await expect.poll(async () => {
      const current = await runtimeSnapshot();
      return current.phase === "ready" && current.generation > beforeReconnect.generation;
    }, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page.locator(".app-shell").getAttribute("data-runtime-generation"))
      .not.toBe(rendererGenerationBeforeReconnect);
    await expect(page.getByRole("heading", {
      name: "Quiet Ledger visual fixture",
      level: 1,
    })).toBeVisible();
    const reconnectedRecentTurn = page.locator(`[data-turn-id="${active.turn.id}"]`);
    await expect(reconnectedRecentTurn.locator(".turn-settled-summary")).toHaveCount(0);
    await expect(reconnectedRecentTurn.getByText("Worked 52s", { exact: true })).toHaveCount(1);
    expect(rendererErrors).toEqual([]);
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
    cleanup.updateSettings({
      theme: originalSettings.theme,
      interfaceScale: originalSettings.interfaceScale,
      responseDensity: originalSettings.responseDensity,
      defaultCodeWrap: originalSettings.defaultCodeWrap,
      autoCollapseWorkLog: originalSettings.autoCollapseWorkLog,
      showChangedFileSummaries: originalSettings.showChangedFileSummaries,
      showTimestamps: originalSettings.showTimestamps,
    });
    cleanup.selectConversation(previousConversationId);
    cleanup.deleteConversation(conversation.id);
    cleanup.close();
    await resizeWindow(1440, 920);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
      timeout: 10_000,
    });
    const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
    if (!await navigation.isVisible()) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
      await expect(navigation).toBeVisible();
    }
    if (!await page.locator(".workspace-panel").isVisible()) {
      await page.getByRole("button", { name: "Open workspace tools" }).click();
      await expect(page.locator(".workspace-panel")).toBeVisible();
    }
  }
});

test("resizes and persists the internal workspace panes", async () => {
  await resizeWindow(1440, 920);
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();

  const sidebarHandle = page.getByRole("separator", { name: "Resize project navigation" });
  const sidebarBefore = Number(await sidebarHandle.getAttribute("aria-valuenow"));
  await sidebarHandle.focus();
  await sidebarHandle.press("ArrowRight");
  await expect.poll(async () => Number(await sidebarHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(sidebarBefore);

  const toolsHandle = page.getByRole("separator", { name: "Resize workspace tools" });
  const toolsBefore = Number(await toolsHandle.getAttribute("aria-valuenow"));
  await toolsHandle.focus();
  await toolsHandle.press("ArrowRight");
  await expect.poll(async () => Number(await toolsHandle.getAttribute("aria-valuenow"))).toBeLessThan(toolsBefore);

  const splitButton = page.getByRole("button", { name: "Split terminals" });
  if (await splitButton.getAttribute("aria-pressed") !== "true") await splitButton.click();
  const terminalHandle = page.getByRole("separator", { name: "Resize split terminals" });
  const terminalBefore = Number(await terminalHandle.getAttribute("aria-valuenow"));
  await terminalHandle.focus();
  await terminalHandle.press("ArrowLeft");
  await expect.poll(async () => Number(await terminalHandle.getAttribute("aria-valuenow"))).toBeLessThan(terminalBefore);

  const persisted = await page.evaluate(() => ({
    sidebar: window.localStorage.getItem("inertia:layout:sidebar-width:v1"),
    tools: window.localStorage.getItem("inertia:layout:workspace-tools-width:v1"),
    terminal: window.localStorage.getItem("inertia:layout:terminal-split-percent:v1"),
  }));
  expect(Number(persisted.sidebar)).toBeGreaterThan(sidebarBefore);
  expect(Number(persisted.tools)).toBeLessThan(toolsBefore);
  expect(Number(persisted.terminal)).toBeLessThan(terminalBefore);
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

test("collapses and restores both workspace sides without losing layout", async () => {
  await resizeWindow(1440, 920);
  const navigationToggle = page.getByRole("button", { name: "Toggle project navigation" });
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("inertia:layout:sidebar-collapsed:v1"))).toBe("true");
  await navigationToggle.click();
  await expect(page.getByRole("complementary", { name: "Project navigation", exact: true })).toBeVisible();

  const toolsToggle = page.getByRole("button", { name: "Close workspace tools" }).first();
  await toolsToggle.click();
  await expect(page.locator(".workspace-panel")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("inertia:layout:active-tool:v1"))).toBe("collapsed");
  const readingCanvas = await page.evaluate(() => {
    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    const chat = document.querySelector<HTMLElement>(".chat-workspace");
    const visibleTurn = [...document.querySelectorAll<HTMLElement>(".response-turn")]
      .find((turn) => {
        const bounds = turn.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
      }) ?? document.querySelector<HTMLElement>(".empty-thread");
    if (!workspaceBody || !chat || !visibleTurn) return null;
    const chatBounds = chat.getBoundingClientRect();
    const turnBounds = visibleTurn.getBoundingClientRect();
    return {
      hasTools: workspaceBody.classList.contains("has-tools"),
      canvasBackground: getComputedStyle(workspaceBody).backgroundColor,
      chatBackground: getComputedStyle(chat).backgroundColor,
      chatCenter: chatBounds.left + (chatBounds.width / 2),
      turnCenter: turnBounds.left + (turnBounds.width / 2),
    };
  });
  expect(readingCanvas).not.toBeNull();
  expect(readingCanvas?.hasTools).toBe(false);
  expect(readingCanvas?.chatBackground).toBe(readingCanvas?.canvasBackground);
  expect(Math.abs((readingCanvas?.chatCenter ?? 0) - (readingCanvas?.turnCenter ?? 0))).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.locator(".workspace-panel")).toBeVisible();
  await expect(page.locator(".workspace-body")).toHaveClass(/has-tools/u);
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

for (const size of [
  { width: 1440, height: 920, label: "wide" },
  { width: 1024, height: 760, label: "stacked" },
  { width: 760, height: 600, label: "compact" },
]) {
  test(`keeps the ${size.label} layout reachable without overlap`, async () => {
    await resizeWindow(size.width, size.height);
    await expectNoViewportOverflow();
    await expect(page.locator(".workspace-header")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

    if (size.width <= 760) {
      const navigationToggle = page.getByRole("button", { name: "Toggle project navigation" });
      await navigationToggle.click();
      const mobileSidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
      await expect(mobileSidebar).toBeVisible();
      await expect(mobileSidebar.getByRole("button", { name: "Close navigation" })).toBeFocused();
      await expect(page.locator(".workspace-shell")).toHaveAttribute("inert", "");
      await expectNoViewportOverflow();
      const drawerControls = mobileSidebar.locator('button:not([disabled]), input:not([disabled])');
      const firstDrawerControl = drawerControls.first();
      const lastDrawerControl = drawerControls.last();
      await lastDrawerControl.focus();
      await page.keyboard.press("Tab");
      await expect(firstDrawerControl).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(lastDrawerControl).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(mobileSidebar).toBeHidden();
      await expect(navigationToggle).toBeFocused();
      await expect(page.locator(".workspace-shell")).not.toHaveAttribute("inert", "");
      await expect(page.locator(".sidebar-scrim")).toHaveAttribute("tabindex", "-1");
      await expect(page.locator(".sidebar-scrim")).toHaveAttribute("aria-hidden", "true");
    }

    const geometry = await page.evaluate(() => {
      const frame = document.querySelector(".workspace-frame")?.getBoundingClientRect();
      const chat = document.querySelector(".chat-workspace")?.getBoundingClientRect();
      const tools = document.querySelector(".workspace-panel")?.getBoundingClientRect();
      return frame && chat && tools ? { frame: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom }, chat: { left: chat.left, top: chat.top, right: chat.right, bottom: chat.bottom }, tools: { left: tools.left, top: tools.top, right: tools.right, bottom: tools.bottom } } : null;
    });
    expect(geometry).not.toBeNull();
    if (geometry) {
      expect(geometry.frame.left).toBeGreaterThanOrEqual(0);
      expect(geometry.frame.top).toBeGreaterThanOrEqual(0);
      expect(geometry.frame.right).toBeLessThanOrEqual(size.width + 1);
      expect(geometry.frame.bottom).toBeLessThanOrEqual(size.height + 1);
      if (size.width > 1024) expect(geometry.chat.right).toBeLessThanOrEqual(geometry.tools.left + 1);
      else expect(geometry.chat.bottom).toBeLessThanOrEqual(geometry.tools.top + 1);
    }
    if (size.width <= 760) {
      const transcriptHeight = await page.getByLabel("Thread transcript").evaluate((element) => element.getBoundingClientRect().height);
      // Persisted usage, backend status, and split-terminal state may all be
      // visible at once. Keep multiple readable transcript lines reachable
      // without forcing those controls or the tool panel out of the viewport.
      // Windows can report a quarter-pixel less at fractional display scales.
      expect(transcriptHeight).toBeGreaterThanOrEqual(71.5);
    }

    expect(rendererErrors).toEqual([]);
  });
}

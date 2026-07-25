import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";
import { nativeProviderMetadataScope } from "../../src/server/provider/metadata";
import type { DiffSelectionReviewAnswer } from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import {
  MAC_BRAND_MIN_CLEAR_GAP,
  MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH,
  MAC_TRAFFIC_LIGHT_POSITION,
} from "../../src/shared/window-chrome";

const execFileAsync = promisify(execFile);

let electronApp: ElectronApplication;
let page: Page;
let testDirectory: string;
let workspaceDirectory: string;
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

function escapeFixtureHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function selectionAnswerFixtureMarkup(answer: DiffSelectionReviewAnswer): string {
  const model = answer.modelSelection.alias ?? answer.modelSelection.modelId;
  const lineLabel = answer.selectedLineCount === 1 ? "line" : "lines";
  return `
    <aside class="diff-selection-answer" aria-label="Agent answer about selected lines">
      <header>
        <span>
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"></circle>
            <path d="M9.1 9a3 3 0 1 1 5.83 1c0 2-3 2-3 4" fill="none" stroke="currentColor" stroke-width="2"></path>
            <path d="M12 18h.01" stroke="currentColor" stroke-width="2"></path>
          </svg>
          <strong>Agent answer</strong>
        </span>
        <small>${escapeFixtureHtml(answer.modelSelection.backendProfileDisplayName)} · ${escapeFixtureHtml(model)} · ${answer.selectedLineCount} selected ${lineLabel}</small>
        <button type="button" aria-label="Dismiss selection answer" title="Dismiss selection answer" class="icon-button">
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2"></path>
          </svg>
        </button>
      </header>
      <blockquote>${escapeFixtureHtml(answer.question)}</blockquote>
      <div class="diff-selection-answer-body">${escapeFixtureHtml(answer.answer)}</div>
    </aside>
  `;
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
      window?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await page.waitForTimeout(250);
}

async function expectNoViewportOverflow(): Promise<void> {
  const measurements = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
  }));

  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.innerWidth + 1);
  expect(measurements.bodyWidth).toBeLessThanOrEqual(measurements.innerWidth + 1);
  expect(measurements.documentHeight).toBeLessThanOrEqual(measurements.innerHeight + 1);
  expect(measurements.bodyHeight).toBeLessThanOrEqual(measurements.innerHeight + 1);
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
  await writeFile(join(workspaceDirectory, "sample.ts"), "export const version = '0.0.1';\n", "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["add", "sample.ts"], { cwd: workspaceDirectory });
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

test("keeps every ordinary New chat entry point isolated from the viewed chat", async () => {
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

test("reveals the fixed local runtime diagnostics directory from settings", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Archive & data", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local data" })).toBeVisible();
  await expect(page.getByText("Local-only lifecycle and failure metadata.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Reveal log folder" }).click();
  await expect(page.getByText("Runtime log folder opened.", { exact: true })).toBeVisible();

  const logDirectory = join(testDirectory, "electron-profile", "logs", "runtime");
  await expect.poll(async () => (await stat(logDirectory)).isDirectory()).toBe(true);
  if (process.platform !== "win32") {
    expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
  }
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("persists composer usage modes without losing the followed transcript", async () => {
  await resizeWindow(1440, 920);
  const transcript = page.getByLabel("Thread transcript");
  const compact = page.getByRole("region", { name: "Usage and context" });
  await expect(compact).toHaveAttribute("data-mode", "compact");
  const expand = compact.getByRole("button", { name: "Expand usage and context" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });

  await expand.focus();
  await expand.press("Space");
  const expanded = page.getByRole("region", { name: "Usage and context" });
  await expect(expanded).toHaveAttribute("data-mode", "expanded");
  await expect(expanded.getByText("Context remaining", { exact: true })).toBeVisible();
  await expect(expanded.getByText("Provider quota", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("expanded");

  const collapse = expanded.getByRole("button", { name: "Collapse usage and context" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.focus();
  await collapse.press("Enter");

  const collapsed = page.getByRole("region", { name: "Usage and context" });
  await expect(collapsed).toHaveAttribute("data-mode", "compact");
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");
  await expect.poll(() => transcript.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(2);

  await collapsed.getByRole("button", { name: "Expand usage and context" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveAttribute("data-mode", "expanded");
  await page.getByRole("region", { name: "Usage and context" }).getByRole("button", { name: "Hide usage and context" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveCount(0);
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
  const autoCollapsed = page.getByRole("region", { name: "Usage and context" });
  await expect(autoCollapsed).toHaveAttribute("data-mode", "compact");
  await expect(autoCollapsed).toHaveAttribute("data-auto-collapsed", "true");
  await expect(autoCollapsed).toHaveAttribute("data-collapse-reason", /^(?:space|unavailable)$/u);
  await autoCollapsed.getByRole("button", { name: "Expand usage and context" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveAttribute("data-mode", "expanded");
  expect(rendererErrors).toEqual([]);
});

test("applies every interface scale live and remains usable at common Linux display scales", async () => {
  await resizeWindow(1440, 920);
  const terminalFontSize = await page.locator("aside.terminal-panel").first().getAttribute("data-terminal-font-size");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const scaleGroup = page.getByRole("radiogroup", { name: "Interface scale" });
  const expected = [
    ["Compact", "compact", "12.5px", "30px"],
    ["Default", "default", "13.5px", "32px"],
    ["Comfortable", "comfortable", "14.5px", "35px"],
    ["Large", "large", "16px", "38px"],
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

test("dismisses Composer menus and enforces authoritative route boundaries", async () => {
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

  const providerTrigger = page.getByRole("button", { name: "Choose provider and model" });
  const providerMenu = page.getByRole("menu", { name: "Provider and model" });

  await providerTrigger.click();
  await expect(providerTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(providerTrigger).toHaveAttribute("aria-controls", "composer-provider-menu");
  await expect(providerMenu).toBeVisible();
  await expect(providerMenu.getByRole("group", { name: "Claude harness" })).toBeVisible();
  const [headerBounds, providerMenuBounds] = await Promise.all([
    workspaceHeader.boundingBox(),
    providerMenu.boundingBox(),
  ]);
  expect(providerMenuBounds?.y ?? 0).toBeGreaterThanOrEqual(
    (headerBounds?.y ?? 0) + (headerBounds?.height ?? 0),
  );

  await providerMenu.getByText("Harness · backend · model", { exact: true }).click();
  await expect(providerMenu).toBeVisible();

  await page.locator(".workspace-header").click({ position: { x: 12, y: 12 } });
  await expect(providerMenu).toBeHidden();
  await expect(providerTrigger).toHaveAttribute("aria-expanded", "false");

  await providerTrigger.click();
  await page.keyboard.press("Escape");
  await expect(providerMenu).toBeHidden();
  await expect(providerTrigger).toBeFocused();

  await providerTrigger.click();
  const modeTrigger = page.getByRole("button", { name: "Choose work mode" });
  const modeMenu = page.getByRole("menu", { name: "Work mode" });
  await modeTrigger.click();
  await expect(providerMenu).toBeHidden();
  await expect(modeMenu).toBeVisible();

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

  await providerTrigger.click();
  await expect(providerMenu).toBeVisible();
  await expect(providerMenu.getByText(
    "This chat has an agent turn. Supported same-backend model changes continue here; other route changes open a new chat.",
    { exact: true },
  )).toBeVisible();
  const codexGroup = providerMenu.getByRole("group", { name: "Codex harness" });
  const codexBeta = codexGroup.getByRole("menuitemradio").filter({
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
    await providerTrigger.click();
    const kimi = providerMenu.getByRole("group", { name: "Claude harness" })
      .locator(".composer-backend-profile")
      .filter({ hasText: /^Kimi/u })
      .getByRole("menuitemradio")
      .filter({ hasText: /^K3 · Default/u });
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
  await routeConfirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(routeConfirmation).toHaveCount(0);

  await chooseKimi();
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

test("collapses composer settings without displacing send and right-aligns user turns", async () => {
  await resizeWindow(1180, 600);
  const composer = page.locator(".composer");
  const more = page.getByRole("button", { name: "More composer options" });
  const send = page.getByRole("button", { name: "Send message" });
  await expect(more).toBeVisible();
  await expect(send).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose provider and model" })).toBeHidden();

  const bounds = await composer.boundingBox();
  const sendBounds = await send.boundingBox();
  expect(bounds).not.toBeNull();
  expect(sendBounds).not.toBeNull();
  expect((sendBounds?.x ?? 0) + (sendBounds?.width ?? 0)).toBeLessThanOrEqual((bounds?.x ?? 0) + (bounds?.width ?? 0));

  await more.click();
  const compactOptions = page.getByRole("menu", { name: "More composer options" });
  const backendItem = compactOptions.getByRole("menuitem", { name: /^Backend\b/ });
  await expect(backendItem).toBeVisible();
  const modelItem = compactOptions.getByRole("menuitem", { name: /^Model\b/ });
  await expect(modelItem).toBeVisible();
  await expect(compactOptions.getByRole("menuitem", { name: /^Mode\b/ })).toBeVisible();
  await expect(compactOptions.getByRole("menuitem", { name: /^Access\b/ })).toBeVisible();
  await backendItem.hover();
  const backendOptions = page.getByRole("menu", { name: "Backend options" });
  await expect(backendOptions).toBeVisible();
  await expect(backendOptions.getByRole("menuitemradio").first()).toBeVisible();
  await backendItem.click();
  await expect(backendOptions).toBeVisible();
  await page.mouse.move(20, 20);
  await expect(backendOptions).toBeHidden();
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
  await expect(page.getByRole("option", { name: /Open settings/ })).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
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

test("keeps the Changes panel readable when the side tool area is narrow", async () => {
  await resizeWindow(1180, 800);
  await page.getByRole("tab", { name: /Changes/ }).click();
  const picker = page.getByRole("combobox", { name: "Changed file" });
  await expect(picker).toBeVisible();
  await expect(picker.locator("option:checked")).toHaveText("M · sample.ts");
  await expect(page.getByLabel("Changed files")).toBeHidden();
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
    await expectExpansionAnchored(".turn-work-log details > summary");
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
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.locator(".workspace-panel")).toBeVisible();
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

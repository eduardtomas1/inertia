import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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

const execFileAsync = promisify(execFile);

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
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
  await expect(page.getByRole("dialog", { name: "Environment summary" })).toBeVisible();
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

  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.getByRole("dialog", { name: "Environment summary" })).toHaveCount(0);
  await expect(page.getByLabel("Terminal panel").first()).toBeVisible();
  expect(conversationCount()).toBe(0);
  await page.locator(".workspace-panel")
    .getByRole("button", { name: "Close workspace tools" })
    .click();

  await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
  await expect.poll(conversationCount).toBe(1);
  await expect(page.getByRole("dialog", { name: "Environment summary" })).toHaveCount(0);
  await expect(page.getByLabel("Terminal panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await expect(page.getByRole("dialog", { name: "Environment summary" })).toHaveCount(0);
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
  await page.getByRole("button", { name: "Open workspace tools" }).click();
  await page.getByRole("complementary", { name: "Workspace tools" })
    .getByRole("tab", { name: "Terminal", exact: true })
    .click();
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

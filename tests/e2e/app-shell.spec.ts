import { openLocalProjectFromDialog } from "./support/add-project";
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";
import { clientCommandSchema } from "../../src/shared/contracts";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";
import { expectRuntimeCrashRecovery } from "./support/runtime-crash-safety";
import { seedViewedConversationContext } from "./support/viewed-conversation-context";
import { selectWorkspaceTool } from "./support/workspace-tools";

const execFileAsync = promisify(execFile);

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  app = await createAppFixture({ name: "app-shell", initialState: "empty" });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  rendererErrors = app.rendererErrors;
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
  await expect(sidebar.getByRole("button", { name: "New chat", exact: true })).toBeDisabled();
  await expect(sidebar.getByText("No projects yet", { exact: true })).toHaveCount(1);
  await expect(sidebar.getByText("No work yet", { exact: true })).toHaveCount(0);

  await electronApp.evaluate(({ dialog }, directory) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [directory],
      bookmarks: [],
    }));
  }, workspaceDirectory);
  await page.getByRole("button", { name: "Add your first project" }).click();
  await openLocalProjectFromDialog(page);
  await expect(page.getByRole("heading", {
    name: /^What should we build in .+\?$/u,
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
  await expect(page.getByRole("tab", { name: "Environment" })).toHaveAttribute("aria-selected", "true");
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Terminal");
  await expect(page.locator(
    '.terminal-panel[data-terminal-id][data-terminal-state="ready"]',
  ).first()).toBeVisible();
  await expect.poll(async () => (await app.runtimeSnapshot()).phase).toBe("ready");
  const currentBranch = (await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: workspaceDirectory },
  )).stdout.trim();
  await selectWorkspaceTool(page.locator(".workspace-panel"), "Changes");
  const changesPanel = page.getByRole("tabpanel", { name: "Changes" });
  await expect(changesPanel.locator(
    `.workspace-repository-scope-branch[title=${JSON.stringify(currentBranch)}]`,
  )).toBeVisible();
  await expect(page.getByRole("alert").filter({
    hasText: "The request could not be completed.",
  })).toHaveCount(0);
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
  const projectId = initialSnapshot.activeProjectId;
  const originalSettings = initialSnapshot.settings;
  if (!conversationId || !projectId) {
    throw new Error("The Send and Stop test needs an active project and conversation.");
  }
  const originalStatus = initialStore.conversation(conversationId).status;
  initialStore.updateSettings({ theme: "light", interfaceScale: "compact" });
  initialStore.updateConversation(conversationId, { status: "idle" });
  initialStore.close();

  const stopFrames: string[] = [];
  let stopConversationId: string | null = null;
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
    await expect(disabledSend).toHaveAttribute("data-motion-state", "send");
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
    expect(readyGeometry.width).toBeCloseTo(readyGeometry.height, 3);
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
    await expect(submitting.locator('[data-icon-state="sending"]')).toHaveCount(1);
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
    await expect(darkSend).toHaveAttribute("data-motion-state", "send");
    const darkSendGeometry = await darkSend.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    await capture("composer-send-disabled-dark-large-1440x920");

    const runningStore = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    const stopConversation = runningStore.createConversation(
      projectId,
      "Synthetic running conversation",
    );
    stopConversationId = stopConversation.id;
    runningStore.updateConversation(stopConversation.id, { status: "running" });
    runningStore.selectConversation(stopConversation.id);
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
    await expect(stop.locator('[data-icon-state="stop"]')).toHaveCount(1);
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
    // Fractional layout coordinates can differ by floating-point roundoff.
    expect(stopGeometry.width).toBeCloseTo(darkSendGeometry.width, 3);
    expect(stopGeometry.height).toBeCloseTo(darkSendGeometry.height, 3);
    expect(stopGeometry.width).toBeCloseTo(stopGeometry.height, 3);
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
    const stopCommand = clientCommandSchema.parse(JSON.parse(stopFrames[0]!));
    if (stopCommand.type !== "agent.stop") {
      throw new Error("The captured command is not an agent stop request.");
    }
    expect(stopCommand.payload.conversationId).toBe(stopConversationId);
  } finally {
    collectStopFrames = false;
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    cleanup.updateSettings({
      theme: originalSettings.theme,
      interfaceScale: originalSettings.interfaceScale,
    });
    cleanup.selectConversation(conversationId);
    if (stopConversationId) cleanup.deleteConversation(stopConversationId);
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
  await expect(sidebar.getByRole("list", { name: "Work" })).toBeVisible();

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
  test.setTimeout(75_000);
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
    await expect(page.getByRole("heading", { name: "New chat", level: 1 }))
      .toBeVisible();
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
  await sidebar.getByRole("button", { name: "Filter work by project" }).click();
  await sidebar.getByRole("button", { name: "Project actions for Inertia", exact: true }).click();
  const projectQuickChat = sidebar.getByRole("menuitem", { name: "New chat in Inertia", exact: true });
  await projectQuickChat.focus();
  await expect(projectQuickChat).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("project-quick-chat.png") });
  await projectQuickChat.click();
  await expectIsolatedConversation(count);
  await expect(sidebar.getByRole("list", { name: "Work" })).toBeVisible();
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

test("keeps the window alive and reconnects with a rotated capability after a runtime crash", {
  tag: "@runtime-recovery",
}, async () => {
  await expectRuntimeCrashRecovery(app, test.info());
});

// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import type { UpsertSubagentTraceInput } from "../../src/server/persistence/types";
import type { ProviderId, SubagentTaskUsage } from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";
import {
  ensureWorkspaceTools,
  rightPanelToggle,
  selectWorkspaceTool,
} from "./support/workspace-tools";

interface SeededChat {
  conversationId: string;
  title: string;
}

interface Seed {
  codex: SeededChat;
  claude: SeededChat;
  opencode: SeededChat;
  cursor: SeededChat;
  kimi: SeededChat;
}

function usage(update: Partial<SubagentTaskUsage>): SubagentTaskUsage {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    contextTokens: null,
    maxContextTokens: null,
    ...update,
  };
}

const FIXED_NOW = Date.parse("2026-09-30T16:20:00.000Z");

function ago(milliseconds: number): string {
  return new Date(FIXED_NOW - milliseconds).toISOString();
}

interface RunTimes {
  id: string;
  startedAt: string;
  finishedAt: string | null;
}

function databasePath(app: AppFixture): string {
  return join(app.testDirectory, "data", "inertia.sqlite");
}

function openStore(app: AppFixture): RuntimeStore {
  return new RuntimeStore(databasePath(app), app.workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
}

function seedChat(
  store: RuntimeStore,
  projectId: string,
  providerId: ProviderId,
  title: string,
  modelId: string,
  running: boolean,
  traces: readonly Omit<UpsertSubagentTraceInput, "conversationId" | "runId" | "turnId" | "providerId" | "sequence">[],
): SeededChat & { turnId: string | null } {
  const conversation = store.createConversation(projectId, title, { providerId });
  if (traces.length === 0) return { conversationId: conversation.id, title, turnId: null };
  const selection = providerNativeModelSelection({ providerId, modelId });
  const continuationIdentity = continuationIdentityForSelection(selection, `native:${providerId}:e2e`);
  const requestedAt = ago(240_000);
  const { turn } = store.beginAgentTurn({
    conversationId: conversation.id,
    runId: `background-tasks-${providerId}-${randomUUID()}`,
    content: "Split the usage work across helpers and report back.",
    providerId,
    modelSelection: selection,
    continuationIdentity,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: `${providerId}-e2e-session`,
    configurationRevision: selection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt,
  });
  store.updateAgentTurnLifecycle(turn.id, running
    ? { status: "running", startedAt: requestedAt, updatedAt: requestedAt }
    : { status: "completed", startedAt: requestedAt, completedAt: ago(30_000), updatedAt: ago(30_000) });
  if (running) store.updateConversation(conversation.id, { status: "running" });
  traces.forEach((trace, index) => {
    store.upsertSubagentTrace({
      ...trace,
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      providerId,
      sequence: index + 1,
    });
  });
  return { conversationId: conversation.id, title, turnId: turn.id };
}

const traceDefaults = {
  providerTaskId: null,
  parentProviderAgentId: null,
  parentProviderToolUseId: null,
  providerToolUseId: null,
  providerRole: null,
  providerStatus: null,
  description: null,
  progress: null,
  result: null,
} as const;

function seedFixture(app: AppFixture): Seed {
  const store = openStore(app);
  const runTimes: RunTimes[] = [];
  try {
    let snapshot = store.shellSnapshot();
    if (!snapshot.activeProjectId) {
      store.createProject("Inertia", app.workspaceDirectory);
      snapshot = store.shellSnapshot();
    }
    const projectId = snapshot.activeProjectId;
    if (!projectId) throw new Error("Background tasks fixture setup failed.");
    const codex = seedChat(store, projectId, "codex", "Usage pipeline refactor", "gpt-5.3-codex", true, [
      {
        ...traceDefaults,
        providerAgentId: "agent-explorer",
        providerName: "Explorer",
        status: "running",
        isLive: true,
        description: "Map every place that parses provider token usage.",
        progress: "Mapping the token usage pipeline",
        model: "gpt-5.3-codex",
        activity: "Searching src/server for usage parsers",
        usage: usage({
          totalTokens: 128_400,
          inputTokens: 18_200,
          cachedInputTokens: 12_800,
          outputTokens: 1_900,
          reasoningOutputTokens: 640,
          contextTokens: 51_000,
          maxContextTokens: 200_000,
        }),
        toolUseCount: 14,
        updatedAt: ago(95_000),
      },
      {
        ...traceDefaults,
        providerAgentId: "agent-fixture-writer",
        parentProviderAgentId: "agent-explorer",
        providerName: "Fixture writer",
        status: "running",
        isLive: true,
        description: "Write fixtures for the parsers the explorer finds.",
        model: "gpt-5.3-codex-mini",
        activity: "Editing tests/fixtures/usage.json",
        usage: usage({ totalTokens: 12_800, inputTokens: 3_100, outputTokens: 420 }),
        toolUseCount: 5,
        updatedAt: ago(48_000),
      },
      {
        ...traceDefaults,
        providerAgentId: "agent-build-verifier",
        providerName: "Build verifier",
        providerStatus: "errored",
        status: "failed",
        isLive: false,
        description: "Typecheck the refactored usage module.",
        result: "Typecheck failed: 2 errors in src/server/provider/usage.ts",
        model: "gpt-5.3-codex",
        usage: usage({ totalTokens: 4_100 }),
        toolUseCount: 2,
        durationMs: 42_000,
        updatedAt: ago(60_000),
      },
      {
        ...traceDefaults,
        providerAgentId: "agent-docs-reviewer",
        providerName: "Docs reviewer",
        status: "completed",
        isLive: false,
        description: "Check the usage documentation against the new contract.",
        result: "Docs match the new usage contract.",
        model: "gpt-5.3-codex",
        usage: usage({ totalTokens: 31_250, inputTokens: 6_400, outputTokens: 880 }),
        toolUseCount: 6,
        durationMs: 96_000,
        updatedAt: ago(120_000),
      },
    ]);
    const devServer = store.createWorkspaceRun({
      id: randomUUID(),
      kind: "service",
      projectId,
      conversationId: codex.conversationId,
      actionId: "dev",
      label: "npm run dev",
      detail: "http://localhost:5173",
      status: "running",
      port: 5173,
    });
    runTimes.push({ id: devServer.id, startedAt: ago(75_000), finishedAt: null });
    const failedTests = store.createWorkspaceRun({
      id: randomUUID(),
      kind: "check",
      projectId,
      conversationId: codex.conversationId,
      actionId: "test",
      attentionState: "unseen",
      label: "npm test",
      detail: "2 failing tests in usage.test.ts",
      status: "failed",
      port: null,
    });
    runTimes.push({ id: failedTests.id, startedAt: ago(50_000), finishedAt: ago(20_000) });
    for (const [label, status] of [["rg usage src", "running"], ["sed -n 1,80p src/usage.ts", "succeeded"]] as const) {
      const providerCommand = store.createWorkspaceRun({
        kind: "check",
        projectId,
        conversationId: codex.conversationId,
        label,
        detail: "Codex · Usage pipeline refactor",
        status,
        port: null,
      });
      runTimes.push({ id: providerCommand.id, startedAt: ago(40_000), finishedAt: status === "running" ? null : ago(39_000) });
    }
    const claude = seedChat(store, projectId, "claude", "Claude delegated review", "claude-sonnet-4-5", true, [
      {
        ...traceDefaults,
        providerTaskId: "task-code-reviewer",
        providerAgentId: "agent-code-reviewer",
        providerName: "Code reviewer",
        status: "running",
        isLive: true,
        description: "Review the usage refactor for regressions.",
        progress: "Reading the provider adapters",
        model: "claude-sonnet-4-5",
        activity: "Grep",
        usage: usage({ totalTokens: 18_600 }),
        toolUseCount: 9,
        updatedAt: ago(70_000),
      },
      {
        ...traceDefaults,
        providerTaskId: "task-test-runner",
        providerAgentId: "agent-test-runner",
        providerName: "Test runner",
        status: "completed",
        isLive: false,
        description: "Run the focused unit tests.",
        result: "All 214 tests passed.",
        usage: usage({ totalTokens: 9_000 }),
        toolUseCount: 3,
        durationMs: 83_000,
        updatedAt: ago(150_000),
      },
    ]);
    const opencode = seedChat(store, projectId, "opencode", "OpenCode schema sweep", "anthropic/claude-haiku-4-5", true, [
      {
        ...traceDefaults,
        providerAgentId: "session-schema",
        providerName: "Schema sweep",
        status: "running",
        isLive: true,
        description: "Find schema drift in the usage records.",
        model: "anthropic/claude-haiku-4-5",
        activity: "read src/shared/contracts/agent.ts",
        usage: usage({
          totalTokens: 22_340,
          inputTokens: 4_800,
          cachedInputTokens: 2_048,
          cacheWriteInputTokens: 512,
          outputTokens: 610,
          reasoningOutputTokens: 120,
        }),
        updatedAt: ago(52_000),
      },
      {
        ...traceDefaults,
        providerAgentId: "session-schema-child",
        parentProviderAgentId: "session-schema",
        providerName: "Schema checker",
        status: "completed",
        isLive: false,
        result: "No drift in the persisted usage JSON.",
        model: "anthropic/claude-haiku-4-5",
        usage: usage({ totalTokens: 3_900 }),
        durationMs: 27_000,
        updatedAt: ago(100_000),
      },
    ]);
    const cursor = seedChat(store, projectId, "cursor", "Cursor thread summary", "gpt-5", false, [
      {
        ...traceDefaults,
        providerAgentId: "cursor-task-summary",
        providerName: null,
        status: "completed",
        isLive: false,
        description: "Summarize the open review threads",
        result: "Three threads remain open.",
        model: "gpt-5",
        durationMs: 4_200,
        updatedAt: ago(90_000),
      },
    ]);
    const kimi = seedChat(store, projectId, "kimi", "Kimi quick fix", "kimi-k2", false, []);
    store.updateSettings({ theme: "dark", interfaceScale: "default", responseDensity: "default" });
    store.selectConversation(codex.conversationId);
    return { codex, claude, opencode, cursor, kimi };
  } finally {
    store.close();
    const database = new Database(databasePath(app));
    try {
      const update = database.prepare("UPDATE workspace_runs SET started_at = ?, finished_at = ? WHERE id = ?");
      for (const { id, startedAt, finishedAt } of runTimes) update.run(startedAt, finishedAt, id);
    } finally {
      database.close();
    }
  }
}

async function showChat(app: AppFixture, chat: SeededChat): Promise<Locator> {
  const store = openStore(app);
  try {
    store.selectConversation(chat.conversationId);
  } finally {
    store.close();
  }
  await app.page.reload();
  await expect(app.page.getByRole("heading", { name: chat.title, level: 1 })).toBeVisible();
  return openBackgroundTasks(app.page);
}

async function openBackgroundTasks(page: Page): Promise<Locator> {
  const panel = await ensureWorkspaceTools(page);
  if (await panel.locator('[data-workspace-tab="agents"][aria-selected="true"]').count() === 0) {
    await selectWorkspaceTool(panel, "Background tasks");
  }
  const region = page.getByRole("region", { name: "Background tasks" });
  await expect(region).toBeVisible();
  return region;
}

function card(region: Locator, title: string): Locator {
  return region.locator("li").filter({
    has: region.page().locator(".background-task-title").getByText(title, { exact: true }),
  });
}

function toggle(region: Locator, title: string): Locator {
  return card(region, title).getByRole("button", { name: new RegExp(`^${title}`, "u") });
}

async function openFinished(region: Locator): Promise<Locator> {
  const finished = region.getByRole("button", { name: /^Finished/u });
  if (await finished.getAttribute("aria-expanded") === "false") await finished.click();
  await expect(finished).toHaveAttribute("aria-expanded", "true");
  return region.getByRole("list", { name: "Finished" });
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectLayoutHolds(app: AppFixture, region: Locator): Promise<void> {
  await app.expectNoViewportOverflow();
  await expectComposerEndsAtDock(app.page.getByRole("region", { name: "Message composer" }));
  const layout = await region.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(".workspace-surface-scroll");
    return {
      overflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
      nested: [...element.querySelectorAll("button")]
        .filter((button) => button.parentElement?.closest("button")).length,
      truncatedTitles: [...element.querySelectorAll<HTMLElement>(".background-task-title")]
        .filter((title) => title.scrollWidth > title.clientWidth + 1).length,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.nested).toBe(0);
  expect(layout.truncatedTitles).toBe(0);
}

let app!: AppFixture;
let seed!: Seed;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "background-tasks", initialState: "conversation" });
  seed = seedFixture(app);
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app.close();
});

async function attachFailure(info: TestInfo): Promise<void> {
  if (app.page.isClosed()) return;
  const path = info.outputPath("background-tasks-failure.png");
  await app.page.screenshot({ path, animations: "disabled" })
    .then(() => info.attach("Background tasks failure", { path, contentType: "image/png" }))
    .catch(() => undefined);
}

test("lists a chat's running work as plain cards with keyboard access", async ({ browserName: _browserName }, info) => {
  try {
    await app.resizeWindow(1440, 1100);
    const region = await showChat(app, seed.codex);
    const page = app.page;

    await expect(region.getByRole("heading")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Background tasks, 3 active" })).toHaveAttribute("aria-selected", "true");
    await expect(rightPanelToggle(page)).toHaveAttribute("aria-label", "Toggle right panel, 3 background tasks active");
    const running = region.getByRole("list", { name: "Running" });
    await expect(running.getByRole("listitem")).toHaveCount(3);
    const explorer = card(region, "Explorer");
    await expect(explorer).toContainText("Agent");
    await expect(explorer).toContainText("1m 35s");
    await expect(explorer).toContainText("gpt-5.3-codex");
    await expect(explorer).toContainText("128.4K tokens");
    await expect(explorer).toContainText("14 tool uses");
    await expect(explorer).toContainText("Searching src/server for usage parsers");
    await expect(explorer.getByRole("button", { name: "View turn for Explorer" })).toBeVisible();
    await expect(card(region, "Fixture writer")).toContainText("Agent · from Explorer");
    const devServer = card(region, "npm run dev");
    await expect(devServer).toContainText("Command");
    await expect(devServer).toContainText("1m 15s");
    await expect(devServer).toContainText("http://localhost:5173");
    await expect(devServer).not.toContainText("tokens");
    await expect(region.getByText("rg usage src")).toHaveCount(0);
    await expect(region.getByText("sed -n 1,80p src/usage.ts")).toHaveCount(0);
    const finishedToggle = region.getByRole("button", { name: "Finished 3 · 2 failed" });
    await expect(finishedToggle).toHaveAttribute("aria-expanded", "false");
    await expect(region.getByRole("button", { name: "Dismiss finished commands" })).toBeVisible();

    for (const button of await region.getByRole("button").all()) {
      await expect(button).toHaveAccessibleName(/\S/u);
    }
    await page.getByRole("tab", { name: "Background tasks, 3 active" }).focus();
    const explorerToggle = toggle(region, "Explorer");
    for (let presses = 0; presses < 12; presses += 1) {
      if (await explorerToggle.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(explorerToggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(explorerToggle).toHaveAttribute("aria-expanded", "true");
    const details = explorer.locator(".background-task-details");
    await expect(details.getByText("Latest step", { exact: true })).toBeVisible();
    await expect(details.getByText("Input 18.2K · Cached 12.8K · Output 1.9K · Reasoning 640", { exact: true })).toBeVisible();
    await expect(details.getByRole("meter", { name: "Context window remaining" })).toHaveAttribute("aria-valuenow", "75");
    await expect(details.getByText("Mapping the token usage pipeline", { exact: true })).toBeVisible();
    await expectLayoutHolds(app, region);
    await page.keyboard.press("Enter");
    await expect(explorerToggle).toHaveAttribute("aria-expanded", "false");
    await explorerToggle.blur();

    await capture(page, info, "background-tasks-wide-dark");
    await setAppearanceInPlace(app, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await capture(page, info, "background-tasks-wide-light");

    await app.resizeWindow(1000, 800);
    await expect(explorer).toBeVisible();
    await explorerToggle.click();
    await expect(details).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-narrow-light");
    await setAppearanceInPlace(app, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "background-tasks-narrow-dark");
    await explorerToggle.click();

    await app.resizeWindow(760, 600);
    await expect(explorer).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-760x600-dark");
    await app.resizeWindow(1440, 1100);

    const finished = await openFinished(region);
    await expect(finished.getByRole("listitem")).toHaveCount(3);
    const verifier = card(region, "Build verifier");
    await expect(verifier).toContainText("Agent · Failed");
    await expect(verifier.locator(".background-task-danger")).toHaveText("Failed");
    await expect(verifier).toContainText("42s");
    await expect(card(region, "npm test")).toContainText("Command · Failed");
    await expect(card(region, "npm test")).toContainText("30s");
    await region.getByRole("button", { name: "Dismiss finished commands" }).click();
    await expect(card(region, "npm test")).toHaveCount(0);
    await expect(region.getByRole("button", { name: "Finished 2 · 1 failed" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Dismiss finished commands" })).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await attachFailure(info);
    throw error;
  }
});

test("shows what each harness reports and nothing more", async ({ browserName: _browserName }, info) => {
  try {
    await app.resizeWindow(1440, 1100);
    const page = app.page;
    let region = await showChat(app, seed.claude);
    const reviewer = card(region, "Code reviewer");
    await expect(reviewer).toContainText("Grep");
    await expect(reviewer).toContainText("18.6K tokens");
    await expect(reviewer).toContainText("9 tool uses");
    await expect(reviewer.getByRole("button", { name: "Stop Code reviewer" })).toBeVisible();
    await openFinished(region);
    await toggle(region, "Test runner").click();
    const runnerDetails = card(region, "Test runner").locator(".background-task-details");
    await expect(runnerDetails.getByText("9,000", { exact: true })).toBeVisible();
    await expect(runnerDetails.getByText("Latest step", { exact: true })).toHaveCount(0);
    await expect(runnerDetails.getByText("1m 23s", { exact: true })).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-claude-wide-dark");

    region = await showChat(app, seed.opencode);
    const sweep = card(region, "Schema sweep");
    await expect(sweep).toContainText("read src/shared/contracts/agent.ts");
    await toggle(region, "Schema sweep").click();
    await expect(sweep.locator(".background-task-details").getByText(
      "Input 4.8K · Cached 2.05K · Cache write 512 · Output 610 · Reasoning 120",
      { exact: true },
    )).toBeVisible();
    await openFinished(region);
    await expect(card(region, "Schema checker")).toContainText("Agent · from Schema sweep");
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-opencode-wide-dark");

    region = await showChat(app, seed.cursor);
    await expect(region.getByRole("list", { name: "Running" })).toHaveCount(0);
    await openFinished(region);
    const summary = card(region, "Summarize the open review threads");
    await expect(summary).toContainText("Three threads remain open.");
    await expect(summary).toContainText("gpt-5");
    await expect(summary).not.toContainText("tokens");
    await toggle(region, "Summarize the open review threads").click();
    await expect(summary.locator(".background-task-details").getByText("Not reported by Cursor", { exact: true }))
      .toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-cursor-wide-dark");

    region = await showChat(app, seed.kimi);
    await expect(region.getByText("No background tasks.", { exact: true })).toBeVisible();
    await expect(region.getByText(/Kimi/u)).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await attachFailure(info);
    throw error;
  }
});

test("keeps the surface and reported tokens across a restart", async ({ browserName: _browserName }, info) => {
  try {
    await app.resizeWindow(1440, 1100);
    await showChat(app, seed.codex);
    await app.restart();
    const restarted = app.page;
    await expect(restarted.getByRole("heading", { name: seed.codex.title, level: 1 })).toBeVisible();
    await expect(restarted.locator('[data-workspace-tab="agents"]')).toHaveAttribute("aria-selected", "true");
    const region = restarted.getByRole("region", { name: "Background tasks" });
    await expect(region).toBeVisible();
    await expect(region.getByRole("list", { name: "Running" })).toHaveCount(0);
    await openFinished(region);
    const explorer = card(region, "Explorer");
    await expect(explorer).toContainText("Agent · Lost");
    await expect(explorer).toContainText("128.4K tokens");
    await expect(explorer.locator(".subagent-elapsed")).toHaveCount(0);
    await expect(card(region, "Docs reviewer")).toContainText("31.25K tokens");
    await expect(card(region, "npm run dev")).toContainText("Command · Failed");
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await attachFailure(info);
    throw error;
  }
});

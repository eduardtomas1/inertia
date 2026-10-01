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

function row(region: Locator, title: string): Locator {
  return region.getByRole("listitem", { name: new RegExp(`^${title},`, "u") });
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
  const overflow = await region.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(".workspace-surface-scroll");
    return scroll ? scroll.scrollWidth - scroll.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(1);
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

test("summarizes a chat's agents, tokens and commands with keyboard access", async ({ browserName: _browserName }, info) => {
  try {
    await app.resizeWindow(1440, 1100);
    const region = await showChat(app, seed.codex);
    const page = app.page;

    await expect(region.getByRole("heading", { name: "Background tasks", level: 3 })).toBeVisible();
    await expect(region.getByText("3 active · 2 need review · 1 finished", { exact: true })).toBeVisible();
    await expect(region.getByText("176.55K tokens reported", { exact: true })).toBeVisible();
    await expect(region.getByText(
      "Sum of what the providers reported for these agents. This chat's own usage is in Usage.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("tab", { name: "Background tasks, 3 active" })).toHaveAttribute("aria-selected", "true");
    await expect(rightPanelToggle(page)).toHaveAttribute("aria-label", "Toggle right panel, 3 background tasks active");

    const active = region.getByRole("list", { name: "Active" });
    await expect(active.getByRole("listitem")).toHaveCount(3);
    const explorer = row(region, "Explorer");
    await expect(explorer.locator(".background-task-status")).toHaveText("Running");
    await expect(explorer.getByText("gpt-5.3-codex", { exact: true })).toBeVisible();
    await expect(explorer.getByText("Searching src/server for usage parsers", { exact: true })).toBeVisible();
    await expect(explorer.getByText("128.4K", { exact: true })).toBeVisible();
    await expect(explorer.getByRole("img", { name: "Codex" })).toBeVisible();
    const writer = row(region, "Fixture writer");
    await expect(writer).toHaveAttribute("data-depth", "1");
    await expect(writer.getByText("Child of Explorer", { exact: true })).toBeVisible();
    const explorerLeft = await explorer.evaluate((element) => element.getBoundingClientRect().left);
    const writerLeft = await writer.evaluate((element) => element.getBoundingClientRect().left);
    expect(writerLeft).toBeGreaterThan(explorerLeft);
    const verifier = row(region, "Build verifier");
    await expect(verifier.locator(".background-task-status")).toHaveText("Failed (errored)");
    await expect(verifier.getByText("42s", { exact: true })).toBeVisible();
    await expect(region.getByRole("list", { name: "Finished" }).getByRole("listitem")).toHaveCount(1);

    const commands = region.getByRole("list", { name: "Commands" });
    await expect(commands.getByRole("listitem")).toHaveCount(2);
    const devServer = commands.getByRole("listitem", { name: "npm run dev, Running" });
    await expect(devServer.getByText("http://localhost:5173", { exact: true })).toBeVisible();
    await expect(devServer.getByText(/tokens/u)).toHaveCount(0);
    await expect(devServer.getByText("1m 15s", { exact: true })).toBeVisible();
    await expect(region.getByText("rg usage src")).toHaveCount(0);
    await expect(region.getByText("sed -n 1,80p src/usage.ts")).toHaveCount(0);
    const failedTest = commands.getByRole("listitem", { name: "npm test, Failed" });
    await expect(failedTest.getByRole("button", { name: "Dismiss npm test" })).toBeVisible();

    for (const button of await region.getByRole("button").all()) {
      await expect(button).toHaveAccessibleName(/\S/u);
    }
    await page.getByRole("tab", { name: "Background tasks, 3 active" }).focus();
    const explorerDetails = explorer.getByRole("button", { name: "Details for Explorer" });
    for (let presses = 0; presses < 12; presses += 1) {
      if (await explorerDetails.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(explorerDetails).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(explorerDetails).toHaveAttribute("aria-expanded", "true");
    const explorerDetailList = explorer.locator(".background-task-details");
    await expect(explorerDetailList.getByText("Latest step", { exact: true })).toBeVisible();
    await expect(explorerDetailList.getByText("Input 18.2K · Cached 12.8K · Output 1.9K · Reasoning 640", { exact: true })).toBeVisible();
    await expect(explorerDetailList.getByRole("meter", { name: "Context window remaining" })).toHaveAttribute("aria-valuenow", "75");
    await expect(explorerDetailList.getByText("75% of 200K remaining", { exact: true })).toBeVisible();
    await expect(explorerDetailList.getByText("Doing now", { exact: true })).toBeVisible();
    await expect(explorerDetailList.getByText("Mapping the token usage pipeline", { exact: true })).toBeVisible();
    await expect(explorerDetailList.getByText("gpt-5.3-codex", { exact: true })).toBeVisible();
    await expectLayoutHolds(app, region);
    await page.keyboard.press("Enter");
    await expect(explorerDetails).toHaveAttribute("aria-expanded", "false");
    await explorerDetails.blur();
    await expect(commands).toBeInViewport();

    await capture(page, info, "background-tasks-wide-dark");
    await setAppearanceInPlace(app, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await capture(page, info, "background-tasks-wide-light");

    await app.resizeWindow(1000, 800);
    await expect(region).toBeVisible();
    await expect(explorer).toBeVisible();
    await explorerDetails.click();
    await expect(explorerDetailList).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-narrow-light");
    await setAppearanceInPlace(app, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "background-tasks-narrow-dark");

    await app.resizeWindow(760, 600);
    await expect(region).toBeVisible();
    await expect(explorer).toBeVisible();
    await expectLayoutHolds(app, region);
    expect(await region.evaluate((element) => [...element.querySelectorAll<HTMLElement>(".background-task-heading > strong")]
      .filter((title) => title.scrollWidth > title.clientWidth + 1)
      .map((title) => title.textContent))).toEqual([]);
    await capture(page, info, "background-tasks-760x600-dark");
    await app.resizeWindow(1000, 800);

    await failedTest.getByRole("button", { name: "Dismiss npm test" }).click();
    await expect(commands.getByRole("listitem")).toHaveCount(1);
    await expect(region.getByText("3 active · 1 needs review · 1 finished", { exact: true })).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await attachFailure(info);
    throw error;
  }
});

test("labels each harness's reporting honestly", async ({ browserName: _browserName }, info) => {
  try {
    await app.resizeWindow(1440, 1100);
    const page = app.page;
    let region = await showChat(app, seed.claude);
    const reviewer = row(region, "Code reviewer");
    await expect(reviewer.getByText("Grep", { exact: true })).toBeVisible();
    await expect(reviewer.getByText("18.6K", { exact: true })).toBeVisible();
    const runner = row(region, "Test runner");
    await runner.getByRole("button", { name: "Details for Test runner" }).click();
    const runnerDetails = runner.locator(".background-task-details");
    await expect(runnerDetails.getByText("9,000", { exact: true })).toBeVisible();
    await expect(runnerDetails.getByText("Latest step", { exact: true })).toHaveCount(0);
    await expect(runnerDetails.getByText("1m 23s", { exact: true })).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-claude-wide-dark");

    region = await showChat(app, seed.opencode);
    const sweep = row(region, "Schema sweep");
    await expect(sweep.getByText("read src/shared/contracts/agent.ts", { exact: true })).toBeVisible();
    await sweep.getByRole("button", { name: "Details for Schema sweep" }).click();
    await expect(sweep.locator(".background-task-details").getByText(
      "Input 4.8K · Cached 2.05K · Cache write 512 · Output 610 · Reasoning 120",
      { exact: true },
    )).toBeVisible();
    await expect(row(region, "Schema checker").getByText("Child of Schema sweep", { exact: true })).toBeVisible();
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-opencode-wide-dark");

    region = await showChat(app, seed.cursor);
    const summary = row(region, "Summarize the open review threads");
    await expect(summary.getByText("Three threads remain open.", { exact: true })).toBeVisible();
    await expect(summary.getByText("Tokens: Cursor does not report tokens for delegated tasks")).toBeAttached();
    await expect(region.getByText(/tokens reported/u)).toHaveCount(0);
    await expectLayoutHolds(app, region);
    await capture(page, info, "background-tasks-cursor-wide-dark");

    region = await showChat(app, seed.kimi);
    await expect(region.getByText("No background tasks in this chat.", { exact: true })).toBeVisible();
    await expect(region.getByText(
      "Kimi Code does not report delegated agents. Commands it starts appear here.",
      { exact: true },
    )).toBeVisible();
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
    await expect(row(region, "Explorer").locator(".background-task-status")).toHaveText("Lost");
    await expect(row(region, "Explorer").getByText("128.4K", { exact: true })).toBeVisible();
    await expect(row(region, "Explorer").getByText("Runtime not reported", { exact: true })).toBeAttached();
    await expect(row(region, "Docs reviewer").getByText("31.25K", { exact: true })).toBeVisible();
    await expect(region.getByRole("list", { name: "Commands" }).getByRole("listitem", {
      name: "npm run dev, Failed",
    })).toBeVisible();
    await expect(region.getByText("176.55K tokens reported", { exact: true })).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await attachFailure(info);
    throw error;
  }
});

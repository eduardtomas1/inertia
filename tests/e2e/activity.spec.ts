import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.beforeAll(async () => {
  app = await createAppFixture({ name: "activity", initialState: "conversation" });
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

test("presents chronological activity with provider, project, and branch identity", async (_fixtures, testInfo) => {
  await resizeWindow(1440, 920);
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  let snapshot = store.shellSnapshot();
  const project = snapshot.projects.find(
    ({ id }) => id === snapshot.activeProjectId,
  ) ?? snapshot.projects[0] ?? store.createProject("Inertia", workspaceDirectory);
  snapshot = store.shellSnapshot();
  const conversation = store.createConversation(
    project.id,
    "Review provider activity",
  );
  store.updateConversation(conversation.id, { branch: "codex/activity-list" });
  store.close();

  const recent = new Date();
  const yesterday = new Date(recent);
  yesterday.setDate(yesterday.getDate() - 1);
  const earlier = new Date(recent);
  earlier.setDate(earlier.getDate() - 3);
  const database = new Database(databasePath);
  const insertRun = database.prepare(`
    INSERT INTO workspace_runs (
      id, kind, project_id, conversation_id, action_id, label, detail,
      status, attention_state, port, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', 'acknowledged', NULL, ?, ?)
  `);
  insertRun.run(
    randomUUID(),
    "agent",
    project.id,
    conversation.id,
    null,
    "Codex · GPT-5",
    conversation.title,
    new Date(recent.getTime() - 5_000).toISOString(),
    recent.toISOString(),
  );
  insertRun.run(
    randomUUID(),
    "check",
    project.id,
    conversation.id,
    "typecheck",
    "Typecheck workspace",
    "npm run typecheck",
    new Date(yesterday.getTime() - 5_000).toISOString(),
    yesterday.toISOString(),
  );
  insertRun.run(
    randomUUID(),
    "source-control",
    project.id,
    conversation.id,
    null,
    "Publish reviewed branch",
    "Push completed",
    new Date(earlier.getTime() - 5_000).toISOString(),
    earlier.toISOString(),
  );
  database.close();

  await page.reload();
  await page.getByRole("button", { name: /^Open runs/u }).click();
  const center = page.getByRole("dialog", { name: "Runs" });
  await expect(center.getByRole("heading", { name: "Recent" })).toBeVisible();
  await expect(center.getByRole("heading", { name: "Yesterday" })).toBeVisible();
  await expect(center.getByRole("heading", { name: "Earlier" })).toBeVisible();
  const providerIcon = center.locator('[data-provider-id="codex"]').first();
  const providerRun = providerIcon.locator("..").locator("..");
  await expect(providerIcon).toBeVisible();
  await expect(providerRun).toContainText("Codex");
  await expect(providerRun).toContainText("Inertia");
  await expect(providerRun).toContainText("codex/activity-list");
  await expectNoViewportOverflow();

  const screenshotPath = testInfo.outputPath("activity-list-wide.png");
  await page.screenshot({ animations: "disabled", path: screenshotPath });
  await testInfo.attach("activity-list-wide", {
    path: screenshotPath,
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
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

test("keeps delegated-agent traces compact while the active composer accepts a parent follow-up", async ({ browserName: _browserName }, testInfo) => {
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
    providerStatus: "running",
    status: "running",
    isLive: true,
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
    providerStatus: "completed",
    status: "completed",
    isLive: false,
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
    providerStatus: "failed",
    status: "failed",
    isLive: false,
    description: "Run the optional provider check.",
    progress: null,
    result: "The optional check ended without changing the parent run.",
    sequence: 3,
    updatedAt: new Date(Date.now() - 6_000).toISOString(),
  });
  store.upsertAgentGoal({
    conversationId: conversation.id,
    source: "inertia-local",
    providerSessionId: null,
    objective: "Keep delegated work truthful and reviewable",
    status: "active",
    tokenBudget: null,
    tokensUsed: null,
    timeUsedSeconds: null,
    createdAt: requestedAt,
    updatedAt: startedAt,
    synchronizedAt: null,
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

    if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Open workspace tools" }).click();
    }
    await page.getByRole("tab", { name: /Goal/ }).click();
    const goalPanel = page.getByRole("region", {
      name: "Goals and agent workflows",
    });
    await expect(goalPanel).toBeVisible();
    await expect(goalPanel.getByText("Inertia local", { exact: true }))
      .toBeVisible();
    await expect(goalPanel.getByText(
      "Keep delegated work truthful and reviewable",
      { exact: true },
    )).toBeVisible();
    await expect(goalPanel.getByText(
      "Latest conversation plan · not linked to this goal",
      { exact: true },
    )).toHaveCount(0);
    await expect(goalPanel.getByText("Evidence Scout", { exact: true }))
      .toBeVisible();
    await expect(goalPanel.getByText("Policy Reader", { exact: true }))
      .toBeVisible();
    await expect(goalPanel.getByText("Build Verifier", { exact: true }))
      .toBeVisible();
    await expect(goalPanel.getByText(/Claude · Agent SDK ·/u).first())
      .toBeVisible();
    await expect(goalPanel.getByText("Running", { exact: true }))
      .toBeVisible();
    await expect(goalPanel.getByText("Completed", { exact: true }))
      .toBeVisible();
    await expect(goalPanel.getByText("Failed", { exact: true }))
      .toBeVisible();
    await goalPanel.getByRole("button", { name: "Complete" }).click();
    await expect(goalPanel.getByText("Complete", { exact: true })).toBeVisible();
    const goalWideScreenshot = testInfo.outputPath(
      "goal-workflows-wide-dark.png",
    );
    await page.screenshot({
      animations: "disabled",
      path: goalWideScreenshot,
    });
    await testInfo.attach("goal-workflows-wide-dark", {
      path: goalWideScreenshot,
      contentType: "image/png",
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const goalLightScreenshot = testInfo.outputPath(
      "goal-workflows-wide-light.png",
    );
    await page.screenshot({
      animations: "disabled",
      path: goalLightScreenshot,
    });
    await testInfo.attach("goal-workflows-wide-light", {
      path: goalLightScreenshot,
      contentType: "image/png",
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });

    await resizeWindow(760, 800);
    await expect(goalPanel).toBeVisible();
    await expectNoViewportOverflow();
    const goalNarrowScreenshot = testInfo.outputPath(
      "goal-workflows-narrow-dark.png",
    );
    await page.screenshot({
      animations: "disabled",
      path: goalNarrowScreenshot,
    });
    await testInfo.attach("goal-workflows-narrow-dark", {
      path: goalNarrowScreenshot,
      contentType: "image/png",
    });
    const goalPolicyRow = goalPanel.getByRole("listitem", {
      name: /Policy Reader, Claude · Agent SDK, Completed/u,
    });
    await goalPolicyRow.getByRole("button", { name: "Details" }).click();
    await expect(goalPolicyRow.getByText("Outcome", { exact: true }))
      .toBeVisible();
    await expect(goalPolicyRow.getByRole("definition").filter({
      hasText: "Confirmed exact IDs and bounded provider-authored text.",
    })).toBeVisible();
    await goalPolicyRow.getByRole("button", {
      name: "View parent turn for Policy Reader",
    }).click();
    await expect(page.locator(`[data-turn-id="${turn.id}"]`)).toBeFocused();
    await resizeWindow(1440, 920);

    const disclosure = page.locator(".subagent-disclosure");
    await expect(disclosure.getByText(
      "3 delegated tasks · 1 working · 1 needs review · 1 settled",
      {
      exact: true,
      },
    )).toBeVisible();
    await expect(disclosure).toHaveAttribute("open");
    const delegatedWork = disclosure.getByRole("list", {
      name: "Delegated agent tree",
    });
    await expect(delegatedWork.getByText("Evidence Scout", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Policy Reader", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Build Verifier", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText(/Claude · Agent SDK · Running ·/u))
      .toBeVisible();
    await expect(delegatedWork.getByText(/Claude · Agent SDK · Completed/u))
      .toBeVisible();
    await expect(delegatedWork.getByText(/Claude · Agent SDK · Failed/u))
      .toBeVisible();
    await expect(delegatedWork.getByRole("button", {
      name: "Stop Evidence Scout",
    })).toBeVisible();
    await expect(delegatedWork.getByRole("button", { name: /^Stop /u }))
      .toHaveCount(1);

    const traceRows = delegatedWork.locator("li");
    const parentLeft = await traceRows.filter({
      has: page.getByText("Evidence Scout", { exact: true }),
    })
      .evaluate((row) => row.getBoundingClientRect().left);
    const childLeft = await traceRows.filter({
      has: page.getByText("Policy Reader", { exact: true }),
    })
      .evaluate((row) => row.getBoundingClientRect().left);
    expect(childLeft).toBeGreaterThan(parentLeft);

    const composer = page.getByRole("region", { name: "Message composer" });
    const textbox = composer.getByRole("textbox", { name: "Message" });
    await expect(textbox).toBeEnabled();
    await expect(textbox).toHaveAttribute(
      "placeholder",
      "Add a follow-up while the agent works…",
    );
    const evidenceRow = delegatedWork.getByRole("listitem", {
      name: /Evidence Scout, Claude · Agent SDK, Running/u,
    });
    await evidenceRow.getByRole("button", { name: "Guide parent" }).click();
    await expect(textbox).toHaveValue(
      "Please follow up on the delegated task “Checking the provider lifecycle and exact task identity.” and incorporate its latest result.",
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

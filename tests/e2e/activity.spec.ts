import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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

test("omits Runs and preserves adjacent toolbar navigation responsively", async () => {
  const verifyToolbar = async (): Promise<void> => {
    const header = page.locator(".workspace-header");
    const environment = header.getByRole("button", {
      name: /environment summary$/u,
    });
    const theme = header.getByRole("button", {
      name: /^Change theme/u,
    });
    const tools = header.getByRole("button", {
      name: /workspace tools$/u,
    });

    await expect(header.getByRole("button", { name: /^Open runs/u }))
      .toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Runs" })).toHaveCount(0);
    await expect(environment).toBeVisible();
    await expect(theme).toBeVisible();
    await expect(tools).toBeVisible();

    if (await environment.getAttribute("aria-pressed") === "true") {
      await environment.click();
      await expect(page.getByRole("dialog", { name: "Environment summary" }))
        .toHaveCount(0);
    }
    await environment.click();
    await expect(page.getByRole("dialog", { name: "Environment summary" }))
      .toBeVisible();
    await page.keyboard.press("Escape");
    await expect(environment).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(theme).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tools).toBeFocused();

    const gaps = await Promise.all([
      environment.evaluate((button) => {
        const current = button.getBoundingClientRect();
        const next = button.closest(".environment-summary-anchor")
          ?.nextElementSibling?.getBoundingClientRect();
        return next ? next.left - current.right : Number.NaN;
      }),
      theme.evaluate((button) => {
        const current = button.getBoundingClientRect();
        const next = button.nextElementSibling?.getBoundingClientRect();
        return next ? next.left - current.right : Number.NaN;
      }),
    ]);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(6);
    }
    await expectNoViewportOverflow();
  };

  await resizeWindow(1440, 920);
  await verifyToolbar();
  await resizeWindow(420, 760);
  await verifyToolbar();
  expect(rendererErrors).toEqual([]);
});

test("keeps preview and failed-run actions in Environment", async () => {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  const snapshot = store.shellSnapshot();
  if (!snapshot.activeProjectId || !snapshot.activeConversationId) {
    store.close();
    throw new Error("Environment action fixture setup failed.");
  }
  const preview = store.createWorkspaceRun({
    id: randomUUID(),
    kind: "service",
    projectId: snapshot.activeProjectId,
    conversationId: snapshot.activeConversationId,
    actionId: "preview",
    label: "Docs preview",
    detail: "npm run preview",
    status: "running",
    port: 4173,
  });
  const failure = store.createWorkspaceRun({
    id: randomUUID(),
    kind: "check",
    projectId: snapshot.activeProjectId,
    conversationId: snapshot.activeConversationId,
    actionId: "typecheck",
    attentionState: "unseen",
    label: "Typecheck fixture",
    detail: "npm run typecheck",
    status: "failed",
    port: null,
  });
  const dismissedFailure = store.createWorkspaceRun({
    id: randomUUID(),
    kind: "check",
    projectId: snapshot.activeProjectId,
    conversationId: snapshot.activeConversationId,
    actionId: "lint",
    attentionState: "unseen",
    label: "Lint fixture",
    detail: "npm run lint",
    status: "failed",
    port: null,
  });
  store.close();

  try {
    await page.reload();
    await resizeWindow(420, 760);
    const environment = page.getByRole("dialog", {
      name: "Environment summary",
    });
    if (await environment.count() === 0) {
      await page.getByRole("button", { name: /environment summary$/u })
        .click();
    }
    await expect(environment.getByText("Docs preview", { exact: false }))
      .toBeVisible();
    await expect(environment.getByText("Typecheck fixture", { exact: false }))
      .toBeVisible();
    await expect(environment.getByText("Lint fixture", { exact: false }))
      .toBeVisible();
    await expectNoViewportOverflow();

    await environment.getByRole("button", {
      name: "Acknowledge Typecheck fixture · npm run typecheck",
    }).click();
    await expect(environment.getByText("Typecheck fixture", { exact: false }))
      .toHaveCount(0);
    await environment.getByRole("button", {
      name: "Dismiss Lint fixture · npm run lint",
    }).click();
    await expect(environment.getByText("Lint fixture", { exact: false }))
      .toHaveCount(0);

    const openPreview = environment.getByRole("button", {
      name: "Open preview for Docs preview · npm run preview",
    });
    await openPreview.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: /Preview/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("textbox", { name: "Preview address" }))
      .toHaveValue("http://127.0.0.1:4173/");
    await expect(page.getByRole("textbox", { name: "Preview address" }))
      .toBeFocused();
    await expectNoViewportOverflow();
    expect(rendererErrors).toEqual([]);
  } finally {
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    cleanup.updateWorkspaceRun(preview.id, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
    cleanup.dismissWorkspaceRun(failure.id);
    cleanup.dismissWorkspaceRun(dismissedFailure.id);
    cleanup.close();
  }
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

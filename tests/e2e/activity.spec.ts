import { expect, test, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import {
  ensureWorkspaceTools,
  selectWorkspaceTool,
} from "./support/workspace-tools";

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let attachmentImagePath!: AppFixture["attachmentImagePath"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

const measureComposerRail = async (composer: Locator): Promise<{
  dockWidth: number;
  containerType: string;
  toolbarFits: boolean;
  groupsContained: boolean;
  groupGaps: number[];
  attachmentBeforeMessage: boolean | null;
}> => composer.evaluate((dock) => {
  const toolbar = dock.querySelector<HTMLElement>(".composer-toolbar");
  const groups = [
    dock.querySelector<HTMLElement>(".composer-options"),
    dock.querySelector<HTMLElement>(".composer-tools"),
    dock.querySelector<HTMLElement>(".composer-actions"),
  ].flatMap((group) => group ? [group.getBoundingClientRect()] : []);
  const toolbarBounds = toolbar?.getBoundingClientRect();
  const attachmentBounds = dock.querySelector<HTMLElement>(
    ".composer-attachments",
  )?.getBoundingClientRect();
  const textareaBounds = dock.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]',
  )?.getBoundingClientRect();
  return {
    dockWidth: dock.getBoundingClientRect().width,
    containerType: getComputedStyle(dock).containerType,
    toolbarFits: Boolean(
      toolbar
      && toolbar.scrollWidth <= toolbar.clientWidth + 1
    ),
    groupsContained: Boolean(
      toolbarBounds
      && groups.length === 3
      && groups.every((bounds) =>
        bounds.left >= toolbarBounds.left - 1
        && bounds.right <= toolbarBounds.right + 1),
    ),
    groupGaps: groups.slice(1).map((bounds, index) =>
      bounds.left - groups[index]!.right),
    attachmentBeforeMessage: attachmentBounds && textareaBounds
      ? attachmentBounds.bottom <= textareaBounds.top
      : null,
  };
});

test.beforeAll(async () => {
  app = await createAppFixture({ name: "activity", initialState: "conversation" });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  attachmentImagePath = app.attachmentImagePath;
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
      name: "Open Environment",
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

    await environment.click();
    await expect(page.getByRole("tabpanel", { name: "Environment" }))
      .toBeVisible();
    await expect(environment).toHaveAttribute("aria-pressed", "true");

    await environment.focus();
    await page.keyboard.press("Tab");
    await expect(theme).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tools).toBeFocused();

    const gaps = await Promise.all([
      environment.evaluate((button) => {
        const current = button.getBoundingClientRect();
        const next = button.closest(".environment-panel-anchor")
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
    const tools = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(tools, "Environment");
    const environment = tools.getByRole("tabpanel", { name: "Environment" });
    await environment.locator("details > summary").filter({
      hasText: "Local Servers",
    }).click();
    await environment.locator("details > summary").filter({
      hasText: "Active work",
    }).click();
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
    await selectWorkspaceTool(page.locator(".workspace-panel"), "Goal");
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
    await expect(disclosure).not.toHaveAttribute("open");
    await disclosure.locator("summary").click();
    await expect(disclosure).toHaveAttribute("open");
    const disclosurePreferenceKey =
      `inertia:subagent-disclosure:v1:${encodeURIComponent(conversation.id)}:${encodeURIComponent(turn.id)}`;
    await expect.poll(() => page.evaluate(
      (key) => window.localStorage.getItem(key),
      disclosurePreferenceKey,
    )).not.toBeNull();
    await page.reload();
    await expect(page.getByRole("heading", {
      name: "Delegated agent trace fixture",
      level: 1,
    })).toBeVisible();
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
    await expect(delegatedWork.locator(".subagent-route")).toHaveCount(3);
    await expect(delegatedWork.getByText("Running", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Completed", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.getByText("Failed", { exact: true }))
      .toBeVisible();
    await expect(delegatedWork.locator(
      '.subagent-status-mark[data-live="true"]',
    )).toHaveCount(1);
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
      "Enter sends · Tab queues",
    );
    const evidenceRow = delegatedWork.getByRole("listitem", {
      name: /Evidence Scout, Checking the provider lifecycle and exact task identity\., Claude · Agent SDK, Running/u,
    });
    await evidenceRow.getByRole("button", { name: "Guide parent" }).click();
    await expect(textbox).toHaveValue(
      "Please follow up on the delegated task “Checking the provider lifecycle and exact task identity.” and incorporate its latest result.",
    );
    await textbox.fill("Please prioritize the lifecycle evidence.");
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

    await resizeWindow(744, 800);
    const compactMore = composer.getByRole("button", {
      name: "More composer options",
    });
    await expect(compactMore).toBeVisible();
    await expect(composer.getByRole("group", { name: "Composer settings" }))
      .toBeHidden();
    const compactRailGeometry = await measureComposerRail(composer);
    expect(compactRailGeometry.dockWidth).toBeLessThanOrEqual(760);
    expect(compactRailGeometry.containerType).toBe("inline-size");
    expect(compactRailGeometry.toolbarFits).toBe(true);
    expect(compactRailGeometry.groupsContained).toBe(true);
    expect(Math.min(...compactRailGeometry.groupGaps)).toBeGreaterThanOrEqual(7);
    await expectNoViewportOverflow();
    const compactComposerScreenshot = testInfo.outputPath("composer-working-compact-744x800.png");
    await page.screenshot({ animations: "disabled", path: compactComposerScreenshot });
    await testInfo.attach("composer-working-compact-744x800", {
      path: compactComposerScreenshot,
      contentType: "image/png",
    });

    await resizeWindow(866, 800);
    const navigation = page.getByRole("complementary", {
      name: "Project navigation",
      exact: true,
    });
    if (await navigation.isVisible()) {
      await page.getByRole("button", {
        name: "Toggle project navigation",
      }).click();
      await expect(navigation).toBeHidden();
    }
    const workspacePanel = page.locator(".workspace-panel");
    if (await workspacePanel.isVisible()) {
      await page.getByRole("button", {
        name: "Close workspace tools",
      }).first().click();
      await expect(workspacePanel).toBeHidden();
    }
    await expect(compactMore).toBeVisible();
    await expect(composer.getByRole("group", { name: "Composer settings" }))
      .toBeHidden();
    const constrainedRailGeometry = await measureComposerRail(composer);
    expect(constrainedRailGeometry.dockWidth).toBeGreaterThanOrEqual(775);
    expect(constrainedRailGeometry.dockWidth).toBeLessThanOrEqual(785);
    expect(constrainedRailGeometry.toolbarFits).toBe(true);
    expect(constrainedRailGeometry.groupsContained).toBe(true);
    expect(Math.min(...constrainedRailGeometry.groupGaps))
      .toBeGreaterThanOrEqual(7);
    await expectNoViewportOverflow();
    const constrainedComposerScreenshot = testInfo.outputPath("composer-working-constrained-779x800.png");
    await page.screenshot({ animations: "disabled", path: constrainedComposerScreenshot });
    await testInfo.attach("composer-working-constrained-779x800", {
      path: constrainedComposerScreenshot,
      contentType: "image/png",
    });

    await resizeWindow(933, 800);
    await electronApp.evaluate(({ dialog }, imagePath) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [imagePath],
        bookmarks: [],
      }));
    }, attachmentImagePath);
    await composer.getByRole("button", {
      name: "Attach follow-up images",
    }).click();
    const activeAttachments = composer.getByRole("list", {
      name: "Attachments",
    });
    const attachmentPreview = activeAttachments.locator("img");
    await expect(attachmentPreview).toHaveCount(1);
    await expect.poll(() => attachmentPreview.evaluate((element) => ({
      complete: (element as HTMLImageElement).complete, width: (element as HTMLImageElement).naturalWidth,
    }))).toEqual({ complete: true, width: 1 });
    const expandedRailGeometry = await measureComposerRail(composer);
    expect(expandedRailGeometry.dockWidth).toBeGreaterThanOrEqual(838);
    expect(expandedRailGeometry.toolbarFits).toBe(true);
    expect(expandedRailGeometry.groupsContained).toBe(true);
    expect(Math.min(...expandedRailGeometry.groupGaps)).toBeGreaterThanOrEqual(7);
    expect(expandedRailGeometry.attachmentBeforeMessage).toBe(true);
    await expect(compactMore).toBeHidden();
    await expect(composer.getByRole("group", { name: "Composer settings" }))
      .toBeVisible();
    await expectNoViewportOverflow();
    const attachmentComposerScreenshot = testInfo.outputPath("composer-working-attachment-expanded-933x800.png");
    await page.screenshot({ animations: "disabled", path: attachmentComposerScreenshot });
    await testInfo.attach("composer-working-attachment-expanded-933x800", {
      path: attachmentComposerScreenshot,
      contentType: "image/png",
    });
    await activeAttachments.getByRole("button", {
      name: "Remove attachment preview.png",
    }).click();

    await resizeWindow(760, 800);
    await disclosure.scrollIntoViewIfNeeded();
    await expect(disclosure).toBeVisible();
    await expect(delegatedWork.getByRole("button", {
      name: "Stop Evidence Scout",
    })).toBeVisible();
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
      "Refresh needed",
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

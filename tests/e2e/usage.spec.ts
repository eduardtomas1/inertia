import { expect, test } from "@playwright/test";
import { join } from "node:path";

import type {
  AgentTurnUsageSnapshot,
  Conversation,
  ModelSelection,
  ProviderId,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let page!: AppFixture["page"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];
let rendererErrors!: AppFixture["rendererErrors"];

function localTime(daysAgo: number, hour: number, seconds = 0): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysAgo,
    hour,
    0,
    seconds,
  ).toISOString();
}

function usage(
  capturedAt: string,
  update: Partial<AgentTurnUsageSnapshot> = {},
): AgentTurnUsageSnapshot {
  return {
    usedTokens: null,
    totalProcessedTokens: null,
    totalProcessedScope: null,
    maxTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    compactsAutomatically: null,
    capturedAt,
    ...update,
  };
}

function addTurn(
  store: RuntimeStore,
  conversation: Conversation,
  input: {
    providerId: ProviderId;
    modelSelection: ModelSelection;
    daysAgo: number;
    total?: number;
    scope?: "thread" | "session" | "run";
    startTotal?: number;
    status?: "completed" | "failed";
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  },
): void {
  const requestedAt = localTime(input.daysAgo, 10);
  const startedAt = localTime(input.daysAgo, 10, 1);
  const completedAt = localTime(input.daysAgo, 10, input.daysAgo + 3);
  const message = store.createMessage(
    conversation.id,
    `Private fixture prompt ${input.daysAgo}`,
    "user",
    [],
    null,
    requestedAt,
  );
  const startUsage = input.startTotal === undefined
    ? null
    : usage(requestedAt, {
        totalProcessedTokens: input.startTotal,
        totalProcessedScope: input.scope ?? "thread",
      });
  const turn = store.createAgentTurn({
    conversationId: conversation.id,
    runId: crypto.randomUUID(),
    userMessageId: message.id,
    providerId: input.providerId,
    modelSelection: input.modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: input.startTotal !== undefined
      && input.scope !== "run"
      ? `usage-${input.providerId}-session`
      : null,
    requestedAt,
    usageAtStart: startUsage,
    configurationRevision: input.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
  store.updateAgentTurnLifecycle(turn.id, {
    status: input.status ?? "completed",
    providerSessionAfter: input.startTotal !== undefined
      && input.scope !== "run"
      ? `usage-${input.providerId}-session`
      : null,
    startedAt,
    completedAt,
    updatedAt: completedAt,
    usageAtCompletion: input.total === undefined
      ? null
      : usage(completedAt, {
          totalProcessedTokens: input.total,
          totalProcessedScope: input.scope ?? "run",
          inputTokens: input.inputTokens ?? null,
          cachedInputTokens: input.cachedInputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
        }),
  });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "usage",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const project = store.shellSnapshot().projects[0]!;
      const codex = store.shellSnapshot().conversations[0]!;
      const kimiSelection = {
        ...nativeModelSelection({ providerId: "claude", modelId: "k3-256k" }),
        backendProfileId: "preset:kimi",
        backendProfileDisplayName: "Kimi",
      };
      const kimi = store.createConversation(project.id, "Kimi usage", {
        providerId: "claude",
        modelSelection: kimiSelection,
        activate: false,
      });
      const cursor = store.createConversation(project.id, "Cursor usage", {
        providerId: "cursor",
        model: "cursor-managed",
        activate: false,
      });
      const synthetic = store.createConversation(project.id, "Synthetic usage", {
        providerId: "opencode",
        model: "<synthetic>",
        activate: false,
      });
      addTurn(store, codex, {
        providerId: "codex",
        modelSelection: nativeModelSelection({
          providerId: "codex",
          modelId: "gpt-unknown-preview",
        }),
        daysAgo: 1,
        startTotal: 1_000,
        total: 1_800,
        scope: "thread",
        inputTokens: 650,
        cachedInputTokens: 250,
        outputTokens: 150,
      });
      addTurn(store, kimi, {
        providerId: "claude",
        modelSelection: kimiSelection,
        daysAgo: 5,
        total: 1_200,
        scope: "run",
        inputTokens: 1_000,
        cachedInputTokens: 500,
        outputTokens: 200,
      });
      addTurn(store, cursor, {
        providerId: "cursor",
        modelSelection: nativeModelSelection({
          providerId: "cursor",
          modelId: "cursor-managed",
        }),
        daysAgo: 10,
        inputTokens: 80,
        outputTokens: 20,
      });
      addTurn(store, synthetic, {
        providerId: "opencode",
        modelSelection: nativeModelSelection({
          providerId: "opencode",
          modelId: "<synthetic>",
        }),
        daysAgo: 2,
        status: "failed",
      });
      store.updateSettings({ theme: "light" });
      store.close();
    },
  });
  page = app.page;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
  rendererErrors = app.rendererErrors;
});

test.afterAll(async () => {
  await app.close();
});

test("navigates to Usage and preserves the editorial dashboard geometry", async ({ browserName: _browserName }, testInfo) => {
  // The supplied T3 Code reference is 1280 × 734, so this is also the
  // comparison viewport used for the committed wide screenshots.
  await resizeWindow(1280, 734);
  const usageDestination = page.getByRole("button", { name: "Usage", exact: true });
  await expect(page.locator(".sidebar-footer .sidebar-destination")).toHaveText([
    "Daily work",
    "Usage",
    "Settings",
  ]);
  const navigationPath = testInfo.outputPath("usage-dashboard-navigation.png");
  await page.locator(".sidebar-footer").screenshot({
    path: navigationPath,
    animations: "disabled",
  });
  await testInfo.attach("Usage navigation · above Settings", {
    path: navigationPath,
    contentType: "image/png",
  });
  const dailyWorkDestination = page.getByRole("button", {
    name: "Daily work",
    exact: true,
  });
  const navigationMark = dailyWorkDestination.locator(".daily-work-mark");
  await expect(navigationMark).toBeVisible();
  await expect(navigationMark).toHaveAttribute("aria-hidden", "true");
  await expect(navigationMark).toHaveAttribute("focusable", "false");
  await dailyWorkDestination.click();
  const dailyWorkDialog = page.getByRole("dialog", { name: "Daily work" });
  await expect(dailyWorkDialog).toBeVisible();
  const headerMark = dailyWorkDialog.locator(".daily-work-mark");
  await expect(headerMark).toBeVisible();
  await expect(headerMark).toHaveAttribute("width", "19");
  await expect(dailyWorkDialog.getByRole("region", {
    name: "Today’s totals",
  })).toBeVisible();
  const dailyWorkPath = testInfo.outputPath("daily-work-day-ledger-mark.png");
  await dailyWorkDialog.screenshot({
    path: dailyWorkPath,
    animations: "disabled",
  });
  await testInfo.attach("Daily work · day-ledger mark", {
    path: dailyWorkPath,
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Close daily work" }).click();
  await expect(dailyWorkDialog).toBeHidden();
  await page.getByRole("button", { name: /^Connections & devices/u }).click();
  await expect(page.getByRole("button", {
    name: "Connections & devices",
    exact: true,
  })).toHaveAttribute("aria-current", "page");
  await usageDestination.focus();
  await usageDestination.press("Enter");

  await expect(usageDestination).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main", { name: "Usage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
  const environmentSummary = page.getByRole("dialog", { name: "Environment summary" });
  if (await environmentSummary.isVisible()) {
    await page.getByRole("button", { name: "Close environment summary" }).click();
    await expect(environmentSummary).toBeHidden();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "General", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await usageDestination.click();
  await expect(page.getByRole("main", { name: "Usage" })).toBeVisible();
  const projectNavigation = page.getByRole("button", {
    name: "Toggle project navigation",
  });
  await expect(projectNavigation).toHaveAttribute("aria-pressed", "true");
  await projectNavigation.click();
  await expect(projectNavigation).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "Usage totals" })).toContainText("4");
  await expect(page.getByText(/Claude · Kimi/u)).toBeVisible();
  await expect(page.getByText("<synthetic>", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cost", exact: true }))
    .toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Tokens", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/partial · measured across/u)).toBeVisible();
  await expect(page.getByRole("img", {
    name: /^Daily measured tokens by provider/u,
  })).toBeVisible();
  expect(await page.locator(".usage-provider-summary .usage-provider-mark")
    .evaluateAll((marks) => marks.map((mark) => ({
      kind: mark.getAttribute("data-provider-icon-kind"),
      providerId: mark.getAttribute("data-provider-id"),
    }))))
    .toEqual([
      { kind: "official", providerId: "claude" },
      { kind: "official", providerId: "codex" },
      { kind: "official", providerId: "cursor" },
      { kind: "official", providerId: "opencode" },
    ]);
  await expectNoViewportOverflow();

  const geometry = await page.locator(".usage-view").evaluate((view) => {
    const viewBounds = view.getBoundingClientRect();
    const summary = view.querySelector(".usage-summary-column")?.getBoundingClientRect();
    const chartPanel = view.querySelector(".usage-daily-panel")?.getBoundingClientRect();
    const chart = view.querySelector(".usage-provider-chart")?.getBoundingClientRect();
    const metrics = [...view.querySelectorAll(".usage-metric")]
      .map((metric) => metric.getBoundingClientRect());
    const table = view.querySelector(".usage-table-wrap")?.getBoundingClientRect();
    return {
      view: { left: viewBounds.left, right: viewBounds.right, width: viewBounds.width },
      summary: summary ? { left: summary.left, right: summary.right, width: summary.width } : null,
      chartPanel: chartPanel
        ? { left: chartPanel.left, right: chartPanel.right, width: chartPanel.width }
        : null,
      chart: chart ? { left: chart.left, right: chart.right, height: chart.height } : null,
      metrics: metrics.map(({ left, right, width, height }) => ({ left, right, width, height })),
      table: table ? { left: table.left, right: table.right, width: table.width } : null,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.summary?.width).toBeGreaterThan(200);
  expect(geometry.chartPanel?.width).toBeGreaterThan(350);
  expect(geometry.summary!.right).toBeLessThan(geometry.chartPanel!.left);
  expect(geometry.metrics).toHaveLength(5);
  expect(geometry.metrics.every(({ width, height }) => width > 120 && height > 65)).toBe(true);
  expect(geometry.metrics.every(({ left, right }) => left >= geometry.view.left && right <= geometry.view.right + 1)).toBe(true);
  expect(geometry.chart?.height).toBeGreaterThan(200);
  expect(geometry.chart?.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.table?.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);

  const desktopPath = testInfo.outputPath("usage-dashboard-desktop.png");
  await page.screenshot({ path: desktopPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · desktop", {
    path: desktopPath,
    contentType: "image/png",
  });

  const explorer = page.getByRole("slider", { name: "Explore daily token chart" });
  await explorer.focus();
  await explorer.press("ArrowLeft");
  await expect(page.locator(".usage-chart-tooltip")).toBeVisible();
  await expect(page.locator(".usage-chart-tooltip")).toContainText("Total measured");
  await expectNoViewportOverflow();
  await explorer.evaluate((element) => element.blur());
  await expect(page.locator(".usage-chart-tooltip")).toBeHidden();

  await page.getByRole("heading", { name: "Breakdown" }).evaluate((heading) => {
    heading.scrollIntoView({ block: "start" });
  });
  const modelsPath = testInfo.outputPath("usage-dashboard-models.png");
  await page.screenshot({ path: modelsPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · model detail", {
    path: modelsPath,
    contentType: "image/png",
  });

  const dayMode = page.getByRole("button", { name: "Day", exact: true });
  await dayMode.focus();
  await dayMode.press("Enter");
  await expect(dayMode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Day usage table" })).toBeVisible();
  const breakdownPath = testInfo.outputPath("usage-dashboard-breakdown.png");
  await page.screenshot({ path: breakdownPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · day breakdown", {
    path: breakdownPath,
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.locator(".usage-view").evaluate((view) => view.scrollTo(0, 0));

  await page.getByRole("button", { name: "Change theme (current: light)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkPath = testInfo.outputPath("usage-dashboard-dark.png");
  await page.screenshot({ path: darkPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · dark", {
    path: darkPath,
    contentType: "image/png",
  });
  await dailyWorkDestination.click();
  await expect(dailyWorkDialog).toBeVisible();
  await expect(headerMark).toBeVisible();
  const dailyWorkDarkPath = testInfo.outputPath(
    "daily-work-day-ledger-mark-dark.png",
  );
  await dailyWorkDialog.screenshot({
    path: dailyWorkDarkPath,
    animations: "disabled",
  });
  await testInfo.attach("Daily work · day-ledger mark · dark", {
    path: dailyWorkDarkPath,
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Close daily work" }).click();
  await expect(dailyWorkDialog).toBeHidden();

  const methodNote = page.getByText("Measured locally.", { exact: true });
  await methodNote.scrollIntoViewIfNeeded();
  await expect(methodNote).toBeInViewport();
  expect(await page.locator(".usage-view").evaluate((view) => view.scrollTop))
    .toBeGreaterThan(0);
  await expectNoViewportOverflow();
  await page.locator(".usage-view").evaluate((view) => view.scrollTo(0, 0));

  await resizeWindow(680, 800);
  await page.getByRole("button", { name: "Change theme (current: dark)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
  await expectNoViewportOverflow();
  const compactGeometry = await page.locator(".usage-view").evaluate((view) => {
    const viewBounds = view.getBoundingClientRect();
    const summary = view.querySelector(".usage-summary-column")?.getBoundingClientRect();
    const chart = view.querySelector(".usage-daily-panel")?.getBoundingClientRect();
    const metrics = [...view.querySelectorAll(".usage-metric")]
      .map((metric) => metric.getBoundingClientRect());
    return {
      view: { left: viewBounds.left, right: viewBounds.right },
      summary: summary ? { left: summary.left, right: summary.right, bottom: summary.bottom } : null,
      chart: chart ? { left: chart.left, right: chart.right, top: chart.top } : null,
      metrics: metrics.map(({ left, right, width }) => ({ left, right, width })),
    };
  });
  expect(compactGeometry.summary?.right).toBeLessThanOrEqual(compactGeometry.view.right + 1);
  expect(compactGeometry.chart?.right).toBeLessThanOrEqual(compactGeometry.view.right + 1);
  expect(compactGeometry.summary!.bottom).toBeLessThan(compactGeometry.chart!.top);
  expect(compactGeometry.metrics.every(({ left, right }) => (
    left >= compactGeometry.view.left && right <= compactGeometry.view.right + 1
  ))).toBe(true);
  const compactPath = testInfo.outputPath("usage-dashboard-compact.png");
  await page.screenshot({ path: compactPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · compact", {
    path: compactPath,
    contentType: "image/png",
  });
  await expectNoViewportOverflow();
  const mobileProjectNavigation = page.getByRole("button", {
    name: "Toggle project navigation",
  });
  await mobileProjectNavigation.focus();
  await mobileProjectNavigation.press("Enter");
  await expect(page.locator(".sidebar")).toHaveClass(/\bis-open\b/u);
  const mobileUsageDestination = page.locator(".sidebar").getByRole("button", {
    name: "Usage",
    exact: true,
  });
  await mobileUsageDestination.focus();
  await mobileUsageDestination.press("Enter");
  await expect(page.locator(".sidebar")).not.toHaveClass(/\bis-open\b/u);
  await expect(mobileProjectNavigation).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".sidebar :focus")).toHaveCount(0);
  expect(rendererErrors).toEqual([]);
});

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

test("navigates to Usage and keeps dashboard geometry contained", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  const usageDestination = page.getByRole("button", { name: "Usage", exact: true });
  await expect(page.locator(".sidebar-footer .sidebar-destination")).toHaveText([
    "Usage",
    "Settings",
  ]);
  await usageDestination.focus();
  await usageDestination.press("Enter");

  await expect(usageDestination).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Usage overview" })).toBeVisible();
  const environmentSummary = page.getByRole("dialog", { name: "Environment summary" });
  if (await environmentSummary.isVisible()) {
    await page.getByRole("button", { name: "Close environment summary" }).click();
    await expect(environmentSummary).toBeHidden();
  }
  await expect(page.getByRole("region", { name: "Usage totals" })).toContainText("4");
  await expect(page.getByText(/Claude · Kimi/u)).toBeVisible();
  await expect(page.getByText("<synthetic>", { exact: true })).toBeVisible();
  await expect(page.getByText("Estimated cost", { exact: true })).toBeVisible();
  await expect(page.getByText(/Token totals are partial/u)).toBeVisible();
  await expect(page.getByRole("img", {
    name: /Request share by provider\. Claude 25\s*%, Codex 25\s*%, Cursor 25\s*%, OpenCode 25\s*%/u,
  })).toBeVisible();
  expect(await page.locator(".usage-provider-list .usage-provider-mark")
    .evaluateAll((marks) => marks.map((mark) => mark.getAttribute("data-provider"))))
    .toEqual(["claude", "codex", "cursor", "opencode"]);
  await expectNoViewportOverflow();

  const geometry = await page.locator(".usage-view").evaluate((view) => {
    const viewBounds = view.getBoundingClientRect();
    const stats = [...view.querySelectorAll(".usage-headline-stat")]
      .map((stat) => stat.getBoundingClientRect());
    const chart = view.querySelector(".usage-trend-chart")?.getBoundingClientRect();
    const providerShare = view.querySelector(".usage-provider-share-rail")
      ?.getBoundingClientRect();
    const table = view.querySelector(".usage-table-wrap")?.getBoundingClientRect();
    return {
      view: { left: viewBounds.left, right: viewBounds.right, width: viewBounds.width },
      stats: stats.map(({ left, right, width, height }) => ({ left, right, width, height })),
      chart: chart ? { left: chart.left, right: chart.right, height: chart.height } : null,
      providerShare: providerShare
        ? { left: providerShare.left, right: providerShare.right, width: providerShare.width }
        : null,
      table: table ? { left: table.left, right: table.right, width: table.width } : null,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.stats).toHaveLength(4);
  expect(geometry.stats.every(({ width, height }) => width > 150 && height > 120)).toBe(true);
  expect(geometry.stats.every(({ left, right }) => left >= geometry.view.left && right <= geometry.view.right + 1)).toBe(true);
  expect(geometry.chart?.height).toBeGreaterThan(260);
  expect(geometry.chart?.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.providerShare?.width).toBeGreaterThan(500);
  expect(geometry.providerShare?.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.table?.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);

  const desktopPath = testInfo.outputPath("usage-dashboard-desktop.png");
  await page.screenshot({ path: desktopPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · desktop", {
    path: desktopPath,
    contentType: "image/png",
  });

  await page.getByRole("heading", { name: "Where requests ran" })
    .scrollIntoViewIfNeeded();
  const breakdownPath = testInfo.outputPath("usage-dashboard-breakdown.png");
  await page.screenshot({ path: breakdownPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · provider breakdown", {
    path: breakdownPath,
    contentType: "image/png",
  });
  await page.getByRole("heading", { name: "Models and backends" })
    .scrollIntoViewIfNeeded();
  const modelsPath = testInfo.outputPath("usage-dashboard-models.png");
  await page.screenshot({ path: modelsPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · model detail", {
    path: modelsPath,
    contentType: "image/png",
  });
  await page.locator(".usage-view").evaluate((view) => view.scrollTo(0, 0));

  await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(page.getByText(/Gaps are unavailable totals/u)).toBeVisible();
  await page.getByRole("button", { name: "Change theme (current: light)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkPath = testInfo.outputPath("usage-dashboard-dark.png");
  await page.screenshot({ path: darkPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · dark", {
    path: darkPath,
    contentType: "image/png",
  });

  const methodNote = page.getByText(
    "Measured locally, with explicit coverage",
    { exact: true },
  );
  await methodNote.scrollIntoViewIfNeeded();
  await expect(methodNote).toBeInViewport();
  expect(await page.locator(".usage-view").evaluate((view) => view.scrollTop))
    .toBeGreaterThan(0);
  await expectNoViewportOverflow();
  await page.locator(".usage-view").evaluate((view) => view.scrollTo(0, 0));

  await resizeWindow(680, 800);
  await page.getByRole("button", { name: "Requests", exact: true }).click();
  await page.getByRole("button", { name: "Change theme (current: dark)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("heading", { name: "Usage overview" })).toBeVisible();
  await expectNoViewportOverflow();
  const compactStats = await page.locator(".usage-headline-stat").evaluateAll(
    (stats) => stats.map((stat) => stat.getBoundingClientRect().width),
  );
  expect(Math.max(...compactStats) - Math.min(...compactStats)).toBeLessThan(2);
  const compactPath = testInfo.outputPath("usage-dashboard-compact.png");
  await page.screenshot({ path: compactPath, animations: "disabled" });
  await testInfo.attach("Usage dashboard · compact", {
    path: compactPath,
    contentType: "image/png",
  });
  await page.getByRole("heading", { name: "Where requests ran" })
    .scrollIntoViewIfNeeded();
  const compactBreakdown = await page.locator(".usage-view").evaluate((view) => {
    const viewBounds = view.getBoundingClientRect();
    const providerRows = [...view.querySelectorAll(".usage-provider-row")]
      .map((row) => row.getBoundingClientRect());
    const providerShare = view.querySelector(".usage-provider-share-rail")
      ?.getBoundingClientRect();
    const table = view.querySelector(".usage-table-wrap")?.getBoundingClientRect();
    return {
      view: { left: viewBounds.left, right: viewBounds.right },
      providerRows: providerRows.map(({ left, right }) => ({ left, right })),
      providerShare: providerShare
        ? { left: providerShare.left, right: providerShare.right }
        : null,
      table: table ? { left: table.left, right: table.right } : null,
    };
  });
  expect(compactBreakdown.providerRows.every(({ left, right }) => (
    left >= compactBreakdown.view.left
    && right <= compactBreakdown.view.right + 1
  ))).toBe(true);
  expect(compactBreakdown.providerShare?.right)
    .toBeLessThanOrEqual(compactBreakdown.view.right + 1);
  expect(compactBreakdown.table?.right)
    .toBeLessThanOrEqual(compactBreakdown.view.right + 1);
  await expectNoViewportOverflow();
  expect(rendererErrors).toEqual([]);
});

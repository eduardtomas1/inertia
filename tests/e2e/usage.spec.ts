// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import type {
  AgentTurnUsageSnapshot,
  Conversation,
  ModelSelection,
  ProviderId,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

let app!: AppFixture;
let page!: AppFixture["page"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];
let rendererErrors!: AppFixture["rendererErrors"];
let priceServer!: Server;
let priceListRequests = 0;

const PRICE_LIST = {
  "fixture-model": {
    input_cost_per_token: 0.002,
    output_cost_per_token: 0.01,
    cache_read_input_token_cost: 0.0002,
    cache_creation_input_token_cost: 0.0025,
    litellm_provider: "openai",
    mode: "chat",
  },
  "k3-256k": {
    input_cost_per_token: 0.001,
    output_cost_per_token: 0.005,
    cache_read_input_token_cost: 0.0001,
    litellm_provider: "moonshot",
    mode: "chat",
  },
};

async function startPriceServer(): Promise<string> {
  priceServer = createServer((request, response) => {
    if (request.url !== "/prices.json") {
      response.writeHead(404).end();
      return;
    }
    priceListRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(PRICE_LIST));
  });
  await new Promise<void>((resolve) => priceServer.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(priceServer.address() as AddressInfo).port}/prices.json`;
}

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
  const providerSessionBound = input.startTotal !== undefined
    && input.scope !== "run";
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
        providerSessionBound,
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
    providerSessionBefore: providerSessionBound
      ? `usage-${input.providerId}-session`
      : null,
    requestedAt,
    usageAtStart: startUsage,
    configurationRevision: input.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
  store.updateAgentTurnLifecycle(turn.id, {
    status: input.status ?? "completed",
    providerSessionAfter: providerSessionBound
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
          providerSessionBound,
        }),
  });
}

test.beforeAll(async () => {
  const priceListUrl = await startPriceServer();
  app = await createAppFixture({
    name: "usage",
    initialState: "conversation",
    additionalEnvironment: { INERTIA_TEST_USAGE_PRICE_LIST_URL: priceListUrl },
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const project = store.shellSnapshot().projects[0]!;
      const codex = store.shellSnapshot().conversations[0]!;
      const kimiBackendSelection = {
        ...providerNativeModelSelection({ providerId: "claude", modelId: "k3-256k" }),
        backendProfileId: "preset:kimi",
        backendProfileDisplayName: "Kimi",
      };
      const kimiBackend = store.createConversation(project.id, "Kimi backend usage", {
        providerId: "claude",
        modelSelection: kimiBackendSelection,
        activate: false,
      });
      const claudeSelection = providerNativeModelSelection({
        providerId: "claude",
        modelId: "fixture-model",
      });
      const claude = store.createConversation(project.id, "Claude usage", {
        providerId: "claude",
        modelSelection: claudeSelection,
        activate: false,
      });
      const cursor = store.createConversation(project.id, "Cursor usage", {
        providerId: "cursor",
        model: "cursor-managed",
        activate: false,
      });
      const antigravity = store.createConversation(project.id, "Antigravity usage", {
        providerId: "antigravity",
        modelSelection: providerNativeModelSelection({
          providerId: "antigravity",
        }),
        activate: false,
      });
      const kimi = store.createConversation(project.id, "Kimi usage", {
        providerId: "kimi",
        modelSelection: providerNativeModelSelection({
          providerId: "kimi",
          modelId: "kimi-code",
        }),
        activate: false,
      });
      const synthetic = store.createConversation(project.id, "Synthetic usage", {
        providerId: "opencode",
        model: "<synthetic>",
        activate: false,
      });
      addTurn(store, codex, {
        providerId: "codex",
        modelSelection: providerNativeModelSelection({
          providerId: "codex",
          modelId: "fixture-model",
        }),
        daysAgo: 0,
        total: 4_000,
        scope: "run",
        inputTokens: 3_000,
        cachedInputTokens: 2_000,
        outputTokens: 1_000,
      });
      addTurn(store, codex, {
        providerId: "codex",
        modelSelection: providerNativeModelSelection({
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
      addTurn(store, claude, {
        providerId: "claude",
        modelSelection: claudeSelection,
        daysAgo: 2,
        total: 2_600,
        scope: "run",
        inputTokens: 2_000,
        cachedInputTokens: 1_000,
        outputTokens: 600,
      });
      addTurn(store, kimiBackend, {
        providerId: "claude",
        modelSelection: kimiBackendSelection,
        daysAgo: 5,
        total: 1_200,
        scope: "run",
        inputTokens: 1_000,
        cachedInputTokens: 500,
        outputTokens: 200,
      });
      addTurn(store, cursor, {
        providerId: "cursor",
        modelSelection: providerNativeModelSelection({
          providerId: "cursor",
          modelId: "cursor-managed",
        }),
        daysAgo: 10,
        inputTokens: 80,
        outputTokens: 20,
      });
      addTurn(store, antigravity, {
        providerId: "antigravity",
        modelSelection: antigravity.modelSelection,
        daysAgo: 3,
        total: 900,
        scope: "run",
        inputTokens: 700,
        outputTokens: 200,
      });
      addTurn(store, kimi, {
        providerId: "kimi",
        modelSelection: kimi.modelSelection,
        daysAgo: 7,
        total: 700,
        scope: "run",
        inputTokens: 550,
        outputTokens: 150,
      });
      addTurn(store, synthetic, {
        providerId: "opencode",
        modelSelection: providerNativeModelSelection({
          providerId: "opencode",
          modelId: "<synthetic>",
        }),
        daysAgo: 2,
        status: "failed",
      });
      store.updateSettings({ theme: "dark" });
      store.close();
    },
  });
  page = app.page;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
  rendererErrors = app.rendererErrors;
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => priceServer.close(() => resolve()));
});

function usageDialog(): Locator {
  return page.getByRole("dialog", { name: "Usage", exact: true });
}

async function openUsageTab(tab: "Cost" | "Tokens"): Promise<Locator> {
  const dialog = usageDialog();
  if (!await dialog.isVisible()) {
    await page.getByRole("button", { name: "Usage", exact: true }).click();
  }
  await expect(dialog).toBeVisible();
  const button = dialog.getByRole("tablist", { name: "Usage view" })
    .getByRole("tab", { name: tab, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-selected", "true");
  const overview = dialog.getByRole("region", { name: tab, exact: true });
  await expect(overview).toBeVisible();
  await expect(overview).toHaveAttribute("aria-busy", "false");
  return overview;
}

async function choose(menu: "Period" | "Providers", option: string): Promise<void> {
  const dialog = usageDialog();
  await dialog.getByRole("button", { name: new RegExp(`^${menu}: `, "u") }).click();
  const list = dialog.getByRole("menu", { name: menu, exact: true });
  await list.getByRole(menu === "Period" ? "menuitemradio" : "menuitemcheckbox", {
    name: option,
    exact: true,
  }).click();
  if (menu === "Providers") await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
}

async function scrollToTop(overview: Locator): Promise<void> {
  await overview.evaluate((element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== "visible") {
        node.scrollTo(0, 0);
        return;
      }
    }
  });
}

async function capture(
  testInfo: TestInfo,
  name: string,
  title: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(title, { path, contentType: "image/png" });
}

test("opens Usage as a popup and estimates cost at list prices", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1360, 1000);
  expect(await page.locator(".sidebar-footer .sidebar-destination").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label")))).toEqual([
    "Daily work",
    "Usage",
    "Settings",
    "Help",
  ]);
  const dailyWorkDestination = page.getByRole("button", { name: "Daily work", exact: true });
  const navigationMark = dailyWorkDestination.locator(".daily-work-mark");
  await expect(navigationMark).toBeVisible();
  await expect(navigationMark).toHaveAttribute("aria-hidden", "true");
  await expect(navigationMark).toHaveAttribute("focusable", "false");
  await dailyWorkDestination.click();
  const dailyWorkDialog = page.getByRole("dialog", { name: "Daily work" });
  await expect(dailyWorkDialog).toBeVisible();
  await expect(dailyWorkDialog.locator(".daily-work-mark")).toHaveCount(0);
  await expect(dailyWorkDialog.getByRole("region", { name: "Daily work totals" })).toBeVisible();
  const dailyWorkPath = testInfo.outputPath("daily-work-day-ledger-mark.png");
  await dailyWorkDialog.screenshot({ path: dailyWorkPath, animations: "disabled" });
  await testInfo.attach("Daily work · day-ledger mark", { path: dailyWorkPath, contentType: "image/png" });
  await page.getByRole("button", { name: "Close daily work" }).click();
  await expect(dailyWorkDialog).toBeHidden();

  const usageDestination = page.getByRole("button", { name: "Usage", exact: true });
  await usageDestination.focus();
  await usageDestination.press("Enter");
  await expect(usageDialog()).toBeVisible();

  const cost = await openUsageTab("Cost");
  await expect(cost.getByRole("heading", { name: "Daily cost" })).toBeVisible();
  expect(priceListRequests).toBeGreaterThan(0);
  const headline = cost.locator(".usage-overview-headline");
  await expect(headline.locator("strong")).toHaveText("$22.15");
  await expect(headline.locator("p")).toContainText("8 requests");
  await expect(headline.locator("p")).toContainText("API estimate");
  await expect(headline.locator("p")).toContainText("priced 3 of 8");
  await expect(cost.getByRole("button", { name: "About this estimate" })).toBeVisible();

  const providers = cost.locator(".usage-overview-providers > article");
  expect(await providers.evaluateAll((items) => items.map((item) => item.getAttribute("data-provider"))))
    .toEqual(["codex", "claude", "antigravity", "kimi", "cursor", "opencode"]);
  await expect(providers.nth(0)).toContainText("2 requests$12.40");
  await expect(providers.nth(0)).toContainText("Partial · 56% of cost · 4.8K tokens");
  await expect(providers.nth(1)).toContainText("2 requests$9.75");
  await expect(providers.nth(1)).toContainText("44% of cost · 3.8K tokens");
  await expect(providers.nth(2)).toContainText("Unpriced · 900 tokens");
  await expect(providers.nth(4)).toContainText("Unpriced · tokens unavailable");
  expect(await cost.locator(".usage-overview-providers .usage-provider-mark")
    .evaluateAll((marks) => marks.map((mark) => mark.getAttribute("data-provider-icon-kind"))))
    .toEqual(Array.from({ length: 6 }, () => "official"));

  await expect(cost.getByRole("img", { name: /^Daily estimated cost by provider/u })).toBeVisible();
  const totals = cost.getByRole("region", { name: "Usage totals" });
  expect(await totals.locator(".usage-overview-total > span").allTextContents())
    .toEqual(["Processed tokens", "Reported input", "Cached input", "Output", "Cache savings", "Requests"]);
  await expect(totals.locator(".usage-overview-total").nth(4)).toContainText("$5.85");
  await expect(totals.locator(".usage-overview-total").nth(5)).toContainText(/^Requests8/u);
  expect(await cost.getByRole("region", { name: "Cost by type" })
    .locator(".usage-overview-share-legend > li").allTextContents())
    .toEqual(["Uncached input$4.5020.3%", "Cache read$0.652.9%", "Output$17.0076.7%"]);

  const models = cost.getByRole("region", { name: "Model usage table" });
  const modelRows = models.getByRole("row");
  await expect(modelRows).toHaveCount(9);
  await expect(modelRows.nth(1)).toContainText("fixture-model");
  await expect(modelRows.nth(1)).toContainText("$12.40");
  await expect(modelRows.nth(2)).toContainText("$8.20");
  await expect(modelRows.nth(3)).toContainText("k3-256k");
  await expect(modelRows.nth(3)).toContainText("Claude · Kimi");
  await expect(modelRows.nth(3)).toContainText("$1.55");
  await expect(modelRows.filter({ hasText: "gpt-unknown-preview" })).toContainText("Unpriced");
  await expect(modelRows.filter({ hasText: "<synthetic>" })).toContainText("Unpriced");
  await expect(cost.getByText(/Prices: LiteLLM model price list, updated (just now|\d+ minutes ago) · 2 models\./u))
    .toContainText("API estimate, not a bill.");
  await expect(cost.getByText("Measured locally.", { exact: true })).toBeVisible();
  await expectNoViewportOverflow();

  const geometry = await cost.evaluate((view) => {
    const box = (selector: string) => {
      const bounds = view.querySelector(selector)?.getBoundingClientRect();
      return bounds
        ? { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
        : null;
    };
    return {
      view: box(":scope > .usage-overview-summary")!,
      lead: box(".usage-overview-lead")!,
      trend: box(".usage-overview-trend")!,
      chart: box(".usage-overview-chart-svg")!,
      headline: Number.parseFloat(getComputedStyle(view.querySelector(".usage-overview-headline > strong")!).fontSize),
      totals: [...view.querySelectorAll(".usage-overview-total")].map((total) => total.getBoundingClientRect().width),
    };
  });
  expect(geometry.view.width).toBeGreaterThan(900);
  expect(geometry.view.width).toBeLessThanOrEqual(976);
  expect(geometry.lead.width).toBeGreaterThan(240);
  expect(geometry.lead.width).toBeLessThanOrEqual(288);
  expect(geometry.lead.right).toBeLessThan(geometry.trend.left);
  expect(geometry.chart.height).toBeGreaterThan(200);
  expect(geometry.chart.right).toBeLessThanOrEqual(geometry.view.right + 1);
  expect(geometry.headline).toBe(36);
  expect(geometry.totals).toHaveLength(6);
  await capture(testInfo, "usage-cost-dark", "Usage · Cost · dark");

  const explorer = cost.getByRole("slider", { name: "Explore daily cost chart" });
  await explorer.focus();
  await expect(explorer).toHaveAttribute("aria-valuetext", /\$12\.40 estimated cost$/u);
  await explorer.press("ArrowLeft");
  await expect(cost.locator(".usage-overview-chart-tooltip")).toContainText("Total estimate");
  await expect(explorer).toHaveAttribute("aria-valuetext", /cost unavailable$/u);
  await explorer.press("ArrowLeft");
  await expect(explorer).toHaveAttribute("aria-valuetext", /\$8\.20 estimated cost, partial$/u);
  await expectNoViewportOverflow();
  await explorer.evaluate((element) => element.blur());
  await expect(cost.locator(".usage-overview-chart-tooltip")).toBeHidden();

  const dayMode = cost.getByRole("button", { name: "Day", exact: true });
  await dayMode.focus();
  await dayMode.press("Enter");
  await expect(dayMode).toHaveAttribute("aria-pressed", "true");
  const days = cost.getByRole("region", { name: "Day usage table" });
  await expect(days.getByRole("row")).toHaveCount(8);
  await expect(days.getByRole("row").nth(1)).toContainText("$12.40");
  await days.scrollIntoViewIfNeeded();
  await capture(testInfo, "usage-cost-days-dark", "Usage · Cost · day breakdown · dark");
  await cost.getByRole("button", { name: "Model", exact: true }).click();

  await setAppearanceInPlace(app, "light");
  await scrollToTop(cost);
  await capture(testInfo, "usage-cost-light", "Usage · Cost · light");
  await models.scrollIntoViewIfNeeded();
  await capture(testInfo, "usage-cost-models-light", "Usage · Cost · models · light");
  expect(rendererErrors).toEqual([]);
});

test("shows measured tokens and follows the period and provider filters", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1360, 1000);
  await setAppearanceInPlace(app, "dark");
  const tokens = await openUsageTab("Tokens");
  await expect(tokens.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
  const headline = tokens.locator(".usage-overview-headline");
  await expect(headline.locator("strong")).toHaveText("10.2K");
  await expect(headline.locator("p")).toContainText("Processed tokens");
  await expect(headline.locator("p")).toContainText("measured for 6 of 8 requests");
  await expect(tokens.getByRole("button", { name: "About this estimate" })).toHaveCount(0);
  const providers = tokens.locator(".usage-overview-providers > article");
  expect(await providers.evaluateAll((items) => items.map((item) => item.getAttribute("data-provider"))))
    .toEqual(["codex", "claude", "antigravity", "kimi", "cursor", "opencode"]);
  await expect(providers.nth(0)).toContainText("2 requests4.8K");
  await expect(providers.nth(0)).toContainText("47.1% of tokens · $12.40");
  await expect(providers.nth(1)).toContainText("37.3% of tokens · $9.75");
  await expect(providers.nth(2)).toContainText("8.8% of tokens · unpriced");
  await expect(providers.nth(4)).toContainText("Token total unavailable");
  await expect(tokens.getByRole("img", { name: /^Daily measured tokens by provider/u })).toBeVisible();
  expect(await tokens.getByRole("region", { name: "Tokens by type" })
    .locator(".usage-overview-share-legend > li").allTextContents())
    .toEqual(["Uncached input2.9K33.7%", "Cache read3.75K43.6%", "Output1.95K22.7%"]);
  const models = tokens.getByRole("region", { name: "Model usage table" });
  await expect(models.getByRole("row").nth(1)).toContainText("fixture-model");
  await expect(models.getByRole("row").nth(1)).toContainText("39.2%");
  await expect(models.getByRole("row").filter({ hasText: "gpt-unknown-preview" })).toContainText("Unpriced");
  await expectNoViewportOverflow();
  await scrollToTop(tokens);
  await capture(testInfo, "usage-tokens-dark", "Usage · Tokens · dark");
  const explorer = tokens.getByRole("slider", { name: "Explore daily token chart" });
  await explorer.focus();
  await expect(tokens.locator(".usage-overview-chart-tooltip")).toContainText("Total measured");
  await explorer.evaluate((element) => element.blur());

  await setAppearanceInPlace(app, "light");
  await capture(testInfo, "usage-tokens-light", "Usage · Tokens · light");

  await choose("Period", "Last 7 days");
  await expect(tokens).toHaveAttribute("aria-busy", "false");
  await expect(headline.locator("p")).toContainText("measured for 5 of 6 requests");
  await expect(headline.locator("strong")).toHaveText("9.5K");
  await expect(tokens.getByRole("slider", { name: "Explore daily token chart" }))
    .toHaveAttribute("aria-valuemax", "7");
  expect(await providers.evaluateAll((items) => items.map((item) => item.getAttribute("data-provider"))))
    .toEqual(["codex", "claude", "antigravity", "opencode"]);

  await choose("Providers", "Codex");
  await expect(headline.locator("strong")).toHaveText("4.7K");
  await expect(headline.locator("p")).toContainText("measured for 3 of 4 requests");
  expect(await providers.evaluateAll((items) => items.map((item) => item.getAttribute("data-provider"))))
    .toEqual(["claude", "antigravity", "opencode"]);
  await expect(tokens.getByRole("region", { name: "Tokens by type" })).toContainText("All providers");
  const cost = await openUsageTab("Cost");
  await expect(cost.locator(".usage-overview-headline > strong")).toHaveText("$9.75");
  await expect(cost.locator(".usage-overview-headline > p")).toContainText("priced 2 of 4");
  await expect(cost.getByRole("region", { name: "Model usage table" }).getByRole("row")).toHaveCount(5);

  await choose("Providers", "Codex");
  await choose("Period", "Last 30 days");
  await expect(cost.locator(".usage-overview-headline > strong")).toHaveText("$22.15");

  await resizeWindow(680, 900);
  await expect(cost.getByRole("heading", { name: "Daily cost" })).toBeVisible();
  await expectNoViewportOverflow();
  const compact = await cost.evaluate((view) => {
    const bounds = (selector: string) => view.querySelector(selector)!.getBoundingClientRect();
    const lead = bounds(".usage-overview-lead");
    const trend = bounds(".usage-overview-trend");
    const frame = view.getBoundingClientRect();
    return {
      stacked: lead.bottom <= trend.top,
      inside: lead.left >= frame.left && trend.right <= frame.right + 1,
      shareColumn: getComputedStyle(view.querySelector(".usage-overview-table .is-share")!).display,
    };
  });
  expect(compact).toEqual({ stacked: true, inside: true, shareColumn: "table-cell" });
  await scrollToTop(cost);
  await capture(testInfo, "usage-cost-compact-light", "Usage · Cost · compact · light");
  await setAppearanceInPlace(app, "dark");
  await scrollToTop(await openUsageTab("Tokens"));
  await capture(testInfo, "usage-tokens-compact-dark", "Usage · Tokens · compact · dark");

  await page.keyboard.press("Escape");
  await expect(usageDialog()).toBeHidden();
  expect(rendererErrors).toEqual([]);
});

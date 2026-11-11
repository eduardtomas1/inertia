import type {
  ServerEvent,
  UsageCostValue,
  UsageDashboard,
  UsageDashboardDay,
  UsageMeasuredValue,
  UsageRangeDays,
} from "../../src/shared/contracts";

export const PRICE_LIST_SOURCE =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export function metric(
  value: number | null,
  measuredRequests: number,
  totalRequests: number,
): UsageMeasuredValue {
  return {
    value,
    measuredRequests,
    totalRequests,
    coverage: measuredRequests === 0
      ? "unavailable"
      : measuredRequests === totalRequests ? "complete" : "partial",
  };
}

export const cost: (
  value: number | null,
  measuredRequests: number,
  totalRequests: number,
) => UsageCostValue = metric;

export function zero(): UsageMeasuredValue {
  return { value: 0, measuredRequests: 0, totalRequests: 0, coverage: "complete" };
}

function emptyDay(date: string): UsageDashboardDay {
  return {
    date,
    requestCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    interruptedCount: 0,
    runtime: zero(),
    processedTokens: zero(),
    cost: zero(),
    providers: [],
  };
}

export function usageDashboard(days: UsageRangeDays = 30): UsageDashboard {
  const end = new Date("2026-06-30T12:00:00.000Z");
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - days + index + 1);
    return emptyDay(date.toISOString().slice(0, 10));
  });
  daily[days - 1] = {
    ...daily[days - 1]!,
    requestCount: 5,
    completedCount: 4,
    failedCount: 1,
    runtime: metric(25_000, 5, 5),
    processedTokens: metric(4_000, 5, 5),
    cost: cost(13.75, 4, 5),
    providers: [
      {
        key: "claude",
        providerId: "claude",
        providerLabel: "Claude",
        requestCount: 4,
        runtime: metric(20_000, 4, 4),
        processedTokens: metric(3_000, 4, 4),
        cost: cost(12.5, 3, 4),
      },
      {
        key: "codex",
        providerId: "codex",
        providerLabel: "Codex",
        requestCount: 1,
        runtime: metric(5_000, 1, 1),
        processedTokens: metric(1_000, 1, 1),
        cost: cost(1.25, 1, 1),
      },
    ],
  };
  daily[days - 4] = {
    ...daily[days - 4]!,
    requestCount: 1,
    interruptedCount: 1,
    runtime: metric(null, 0, 1),
    processedTokens: metric(null, 0, 1),
    cost: cost(null, 0, 1),
    providers: [{
      key: "codex",
      providerId: "codex",
      providerLabel: "Codex",
      requestCount: 1,
      runtime: metric(null, 0, 1),
      processedTokens: metric(null, 0, 1),
      cost: cost(null, 0, 1),
    }],
  };
  const startDate = daily[0]!.date;
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    range: {
      days,
      fromInclusive: `${startDate}T00:00:00.000Z`,
      toExclusive: "2026-07-01T00:00:00.000Z",
      startDate,
      endDate: "2026-06-30",
      timeZone: "UTC",
    },
    totals: {
      requestCount: 6,
      completedCount: 4,
      failedCount: 1,
      cancelledCount: 0,
      interruptedCount: 1,
      activeDays: 2,
      runtime: metric(25_000, 5, 6),
      processedTokens: metric(4_000, 5, 6),
      cost: cost(13.75, 4, 6),
    },
    daily,
    providers: [
      {
        key: "claude",
        providerId: "claude",
        providerLabel: "Claude",
        requestCount: 4,
        runtime: metric(20_000, 4, 4),
        processedTokens: metric(3_000, 4, 4),
        cost: cost(12.5, 3, 4),
      },
      {
        key: "codex",
        providerId: "codex",
        providerLabel: "Codex",
        requestCount: 2,
        runtime: metric(5_000, 1, 2),
        processedTokens: metric(1_000, 1, 2),
        cost: cost(1.25, 1, 2),
      },
    ],
    models: [
      {
        key: "model-0",
        providerId: "claude",
        providerLabel: "Claude",
        requestCount: 3,
        runtime: metric(15_000, 3, 3),
        processedTokens: metric(2_500, 3, 3),
        cost: cost(12.5, 3, 3),
        model: "claude-fable-5",
        pricedAs: "claude-fable-5",
        backendProfileId: "provider-native:claude",
        backendLabel: "Claude",
        backendConfigurationRevision: 1,
      },
      {
        key: "model-1",
        providerId: "codex",
        providerLabel: "Codex",
        requestCount: 2,
        runtime: metric(5_000, 1, 2),
        processedTokens: metric(1_000, 1, 2),
        cost: cost(1.25, 1, 2),
        model: "gpt-6.1-codex-high",
        pricedAs: "gpt-6.1-codex",
        backendProfileId: "provider-native:codex",
        backendLabel: "Codex",
        backendConfigurationRevision: 1,
      },
      {
        key: "model-2",
        providerId: "claude",
        providerLabel: "Claude",
        requestCount: 1,
        runtime: metric(5_000, 1, 1),
        processedTokens: metric(500, 1, 1),
        cost: cost(null, 0, 1),
        model: "<synthetic>",
        pricedAs: null,
        backendProfileId: "preset:kimi",
        backendLabel: "Kimi",
        backendConfigurationRevision: 3,
      },
    ],
    tokens: {
      input: metric(2_800, 5, 6),
      cachedInput: metric(900, 3, 6),
      cacheWriteInput: metric(120, 1, 6),
      output: metric(700, 5, 6),
      reasoningOutput: metric(40, 1, 6),
    },
    cost: {
      status: "estimated",
      reason: null,
      pricing: {
        status: "fresh",
        source: PRICE_LIST_SOURCE,
        fetchedAt: "2026-06-30T21:00:00.000Z",
        modelCount: 1_912,
      },
      byType: { input: 6, cachedInput: 0.75, cacheWriteInput: 0.5, output: 6.5 },
      cacheSavings: 2.4,
    },
  };
}

export function unpricedDashboard(days: UsageRangeDays = 30): UsageDashboard {
  const value = usageDashboard(days);
  const unpriced = <T extends { requestCount: number; cost: UsageCostValue }>(entry: T): T => ({
    ...entry,
    cost: entry.requestCount === 0 ? zero() : cost(null, 0, entry.requestCount),
  });
  return {
    ...value,
    totals: unpriced(value.totals),
    daily: value.daily.map((day) => ({
      ...unpriced(day),
      providers: day.providers.map(unpriced),
    })),
    providers: value.providers.map(unpriced),
    models: value.models.map((model) => ({ ...unpriced(model), pricedAs: null })),
    cost: {
      status: "unavailable",
      reason: "The model price list could not be downloaded and no saved copy exists.",
      pricing: { status: "unavailable", source: PRICE_LIST_SOURCE, fetchedAt: null, modelCount: 0 },
      byType: { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 },
      cacheSavings: 0,
    },
  };
}

export function emptyDashboard(days: UsageRangeDays = 30): UsageDashboard {
  const value = usageDashboard(days);
  return {
    ...value,
    totals: {
      requestCount: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      interruptedCount: 0,
      activeDays: 0,
      runtime: metric(null, 0, 0),
      processedTokens: metric(null, 0, 0),
      cost: cost(null, 0, 0),
    },
    daily: value.daily.map((day) => emptyDay(day.date)),
    providers: [],
    models: [],
    tokens: {
      input: metric(null, 0, 0),
      cachedInput: metric(null, 0, 0),
      cacheWriteInput: metric(null, 0, 0),
      output: metric(null, 0, 0),
      reasoningOutput: metric(null, 0, 0),
    },
    cost: {
      ...value.cost,
      byType: { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 },
      cacheSavings: 0,
    },
  };
}

export function dashboardResult(value: UsageDashboard): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: { kind: "usage.dashboard", dashboard: value },
  };
}

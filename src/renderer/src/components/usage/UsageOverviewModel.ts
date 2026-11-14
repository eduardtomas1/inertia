import type {
  UsageCostValue,
  UsageDashboard,
  UsageDashboardBreakdown,
  UsageDashboardModelBreakdown,
  UsageMeasuredValue,
  UsageRangeDays,
  UsageRuntimeValue,
} from "@shared/contracts";

import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { formatCount } from "../../lib/usageFormat";

export type UsageOverviewMetric = "cost" | "tokens";

type UsageDashboardCommand = Extract<
  CommandWithoutId,
  { type: "usage.dashboard.get" }
>;

export interface UsageOverviewDay {
  date: string;
  requestCount: number;
  processedTokens: UsageMeasuredValue;
  cost: UsageCostValue;
  providers: UsageDashboardBreakdown[];
}

interface UsageOverviewStatusCounts {
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
}

export interface UsageOverviewData {
  filtered: boolean;
  hiddenProviderCount: number;
  requestCount: number;
  activeDays: number;
  runtime: UsageRuntimeValue;
  processedTokens: UsageMeasuredValue;
  cost: UsageCostValue;
  statusCounts: UsageOverviewStatusCounts | null;
  providers: UsageDashboardBreakdown[];
  models: UsageDashboardModelBreakdown[];
  daily: UsageOverviewDay[];
}

const shortDateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const fullDateFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const timestampFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function localDateKey(date: Date): string {
  const part = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

export function usageDashboardCommand(
  days: UsageRangeDays,
  now = new Date(),
): UsageDashboardCommand {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days + 1,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return {
    type: "usage.dashboard.get",
    payload: {
      days,
      fromInclusive: start.toISOString(),
      toExclusive: end.toISOString(),
      endDate: localDateKey(now),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  };
}

export function displayDate(value: string, includeYear = false): string {
  return (includeYear ? fullDateFormatter : shortDateFormatter)
    .format(new Date(`${value}T12:00:00Z`));
}

export function metricOf(
  item: { processedTokens: UsageMeasuredValue; cost: UsageCostValue },
  metric: UsageOverviewMetric,
): UsageMeasuredValue {
  return metric === "cost" ? item.cost : item.processedTokens;
}

export function sumMeasured(
  values: readonly UsageMeasuredValue[],
  emptyIsZero = false,
): UsageMeasuredValue {
  let total = 0;
  let measuredRequests = 0;
  let totalRequests = 0;
  let measuredEntries = 0;
  for (const entry of values) {
    totalRequests += entry.totalRequests;
    if (entry.value === null) continue;
    total += entry.value;
    measuredRequests += entry.measuredRequests;
    measuredEntries += 1;
  }
  if (totalRequests === 0 && emptyIsZero) {
    return { value: 0, measuredRequests: 0, totalRequests: 0, coverage: "complete" };
  }
  if (measuredEntries === 0 || measuredRequests === 0) {
    return { value: null, measuredRequests: 0, totalRequests, coverage: "unavailable" };
  }
  return {
    value: total,
    measuredRequests,
    totalRequests,
    coverage: measuredRequests === totalRequests ? "complete" : "partial",
  };
}

function sumRequests(items: readonly { requestCount: number }[]): number {
  return items.reduce((sum, { requestCount }) => sum + requestCount, 0);
}

export function visibleUsage(
  dashboard: UsageDashboard,
  hiddenProviderIds: ReadonlySet<string>,
): UsageOverviewData {
  const hiddenProviderCount = dashboard.providers
    .filter(({ providerId }) => hiddenProviderIds.has(providerId)).length;
  if (hiddenProviderCount === 0) {
    return {
      filtered: false,
      hiddenProviderCount,
      requestCount: dashboard.totals.requestCount,
      activeDays: dashboard.totals.activeDays,
      runtime: dashboard.totals.runtime,
      processedTokens: dashboard.totals.processedTokens,
      cost: dashboard.totals.cost,
      statusCounts: {
        completed: dashboard.totals.completedCount,
        failed: dashboard.totals.failedCount,
        cancelled: dashboard.totals.cancelledCount,
        interrupted: dashboard.totals.interruptedCount,
      },
      providers: dashboard.providers,
      models: dashboard.models,
      daily: dashboard.daily,
    };
  }
  const visible = <T extends { providerId: string }>(items: readonly T[]): T[] =>
    items.filter(({ providerId }) => !hiddenProviderIds.has(providerId));
  const providers = visible(dashboard.providers);
  const daily = dashboard.daily.map((day): UsageOverviewDay => {
    const dayProviders = visible(day.providers);
    return {
      date: day.date,
      requestCount: sumRequests(dayProviders),
      processedTokens: sumMeasured(dayProviders.map((entry) => entry.processedTokens), true),
      cost: sumMeasured(dayProviders.map((entry) => entry.cost), true),
      providers: dayProviders,
    };
  });
  return {
    filtered: true,
    hiddenProviderCount,
    requestCount: sumRequests(providers),
    activeDays: daily.filter(({ requestCount }) => requestCount > 0).length,
    runtime: sumMeasured(providers.map((entry) => entry.runtime)),
    processedTokens: sumMeasured(providers.map((entry) => entry.processedTokens)),
    cost: sumMeasured(providers.map((entry) => entry.cost)),
    statusCounts: null,
    providers,
    models: visible(dashboard.models),
    daily,
  };
}

export function sortByMetric<T extends UsageDashboardBreakdown>(
  items: readonly T[],
  metric: UsageOverviewMetric,
): T[] {
  const other: UsageOverviewMetric = metric === "cost" ? "tokens" : "cost";
  return [...items].sort((left, right) =>
    (metricOf(right, metric).value ?? -1) - (metricOf(left, metric).value ?? -1)
    || (metricOf(right, other).value ?? -1) - (metricOf(left, other).value ?? -1)
    || right.requestCount - left.requestCount
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export function shareOf(
  value: UsageMeasuredValue,
  total: UsageMeasuredValue,
): number | null {
  if (value.value === null || total.value === null || total.value <= 0) return null;
  return value.value / total.value;
}

export function dayProviderMetric(
  day: UsageOverviewDay,
  providerId: string,
  metric: UsageOverviewMetric,
): UsageMeasuredValue {
  const provider = day.providers.find((entry) => entry.providerId === providerId);
  return provider ? metricOf(provider, metric) : {
    value: 0,
    measuredRequests: 0,
    totalRequests: 0,
    coverage: "complete",
  };
}

export function costGapLabel(
  models: readonly UsageDashboardModelBreakdown[],
): "Unpriced" | "No estimate" {
  return models
    .filter(({ cost, requestCount }) => cost.value === null && requestCount > 0)
    .every(({ pricedAs }) => pricedAs === null)
    ? "Unpriced"
    : "No estimate";
}

export function requestsLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "request" : "requests"}`;
}

export function coverageNote(value: UsageMeasuredValue, verb = "Measured"): string | null {
  if (value.totalRequests === 0 || value.coverage === "complete") return null;
  if (value.coverage === "partial") {
    return `${verb} for ${formatCount(value.measuredRequests)} of ${formatCount(value.totalRequests)} requests`;
  }
  return "No defensible total available";
}

export function tokenTotalsUnavailable(
  dashboard: UsageDashboard,
  data: UsageOverviewData,
): boolean {
  return [
    data.processedTokens,
    dashboard.tokens.input,
    dashboard.tokens.cachedInput,
    dashboard.tokens.output,
  ].every(({ value }) => value === null);
}

export interface UsageTypeSegment {
  kind: "input" | "cachedInput" | "cacheWriteInput" | "output";
  label: string;
  value: number;
}

export function costTypeSegments(dashboard: UsageDashboard): UsageTypeSegment[] {
  const { byType } = dashboard.cost;
  return [
    { kind: "input", label: "Uncached input", value: byType.input },
    { kind: "cachedInput", label: "Cache read", value: byType.cachedInput },
    { kind: "cacheWriteInput", label: "Cache write", value: byType.cacheWriteInput },
    { kind: "output", label: "Output", value: byType.output },
  ];
}

export function tokenTypeSegments(dashboard: UsageDashboard): UsageTypeSegment[] {
  const { tokens } = dashboard;
  const input = tokens.input.value;
  const reportedCached = tokens.cachedInput.value ?? 0;
  const reportedWritten = tokens.cacheWriteInput.value ?? 0;
  const cached = input === null ? reportedCached : Math.min(input, reportedCached);
  const written = input === null ? reportedWritten : Math.min(input - cached, reportedWritten);
  return [
    { kind: "input", label: "Uncached input", value: input === null ? 0 : input - cached - written },
    { kind: "cachedInput", label: "Cache read", value: cached },
    { kind: "cacheWriteInput", label: "Cache write", value: written },
    { kind: "output", label: "Output", value: tokens.output.value ?? 0 },
  ];
}

export function priceListName(source: string): string {
  if (/litellm/iu.test(source)) return "LiteLLM model price list";
  try {
    const host = new URL(source).host;
    return host ? `price list at ${host}` : "model price list";
  } catch {
    return "model price list";
  }
}

export function priceListAge(fetchedAt: string | null, generatedAt: string): string | null {
  if (fetchedAt === null) return null;
  const fetched = Date.parse(fetchedAt);
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(fetched)) return null;
  const elapsed = generated - fetched;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return timestampFormatter.format(new Date(fetched));
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function pricingNote(dashboard: UsageDashboard): string {
  const { pricing } = dashboard.cost;
  const name = priceListName(pricing.source);
  const age = priceListAge(pricing.fetchedAt, dashboard.generatedAt);
  if (pricing.status === "unavailable") return `Prices: ${name}, unavailable.`;
  const models = pricing.modelCount > 0
    ? ` · ${formatCount(pricing.modelCount)} ${pricing.modelCount === 1 ? "model" : "models"}`
    : "";
  if (pricing.status === "cached") {
    return `Prices: ${name}, cached copy${age ? ` from ${age}` : ""}${models}. The latest list could not be downloaded.`;
  }
  return `Prices: ${name}${age ? `, updated ${age}` : ""}${models}.`;
}

export function partialEstimateNote(cost: UsageCostValue): string | null {
  if (cost.coverage !== "partial") return null;
  return `The estimate covers ${formatCount(cost.measuredRequests)} of ${formatCount(cost.totalRequests)} requests. The rest used models without a known price or did not report token detail.`;
}

export function chartScale(peak: number): { maximum: number; ticks: number[] } {
  if (!(peak > 0)) return { maximum: 1, ticks: [1, 0] };
  const rawStep = peak / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1)
    * magnitude;
  const count = Math.max(1, Math.ceil(peak / step - 1e-9));
  const ticks: number[] = [];
  for (let index = count; index >= 0; index -= 1) {
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return { maximum: ticks[0]!, ticks };
}

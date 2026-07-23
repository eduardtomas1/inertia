import type { ThreadUsageSnapshot } from "../../shared/contracts";

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clampProviderPercent(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function strictIsoTimestamp(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12
    || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
  ) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

/** Accept provider reset timestamps in ISO form, epoch seconds, or epoch milliseconds. */
export function providerTimestamp(value: unknown): string | null {
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = Math.abs(value) >= 100_000_000_000 ? value : value * 1_000;
  } else if (typeof value === "string" && value.trim()) {
    const parsed = strictIsoTimestamp(value.trim());
    if (parsed === null) return null;
    milliseconds = parsed;
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

type ProviderUsage = Omit<ThreadUsageSnapshot, "conversationId" | "updatedAt">;

const MAX_TOKEN_COUNT = 1_000_000_000_000;
const TOTAL_SCOPES: ReadonlyArray<NonNullable<ProviderUsage["totalProcessedScope"]>> = ["thread", "session", "run"];

function tokenCount(value: unknown, allowZero = true): number | null {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)
    || value > MAX_TOKEN_COUNT
  ) return null;
  return value;
}

/**
 * Provider usage is untrusted process input. Invalid context occupancy is made
 * unavailable instead of manufacturing a percentage from impossible values.
 */
export function validateProviderUsage(value: unknown): ProviderUsage {
  const usage = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ProviderUsage>
    : {};
  const maxTokens = tokenCount(usage.maxTokens, false);
  const reportedUsedTokens = tokenCount(usage.usedTokens);
  const usedTokens = maxTokens !== null && reportedUsedTokens !== null && reportedUsedTokens > maxTokens
    ? null
    : reportedUsedTokens;
  const totalProcessedTokens = tokenCount(usage.totalProcessedTokens);
  const totalProcessedScope = totalProcessedTokens !== null && TOTAL_SCOPES.includes(usage.totalProcessedScope as NonNullable<ProviderUsage["totalProcessedScope"]>)
    ? usage.totalProcessedScope as NonNullable<ProviderUsage["totalProcessedScope"]>
    : null;
  return {
    usedTokens,
    totalProcessedTokens,
    totalProcessedScope,
    maxTokens,
    inputTokens: tokenCount(usage.inputTokens),
    cachedInputTokens: tokenCount(usage.cachedInputTokens),
    cacheWriteInputTokens: tokenCount(usage.cacheWriteInputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    reasoningOutputTokens: tokenCount(usage.reasoningOutputTokens),
    compactsAutomatically: typeof usage.compactsAutomatically === "boolean" ? usage.compactsAutomatically : null,
  };
}

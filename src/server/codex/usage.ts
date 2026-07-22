import { objectValue } from "./protocol";
import type { CodexUsageSnapshot } from "./types";

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseCodexTokenUsage(value: unknown): CodexUsageSnapshot | undefined {
  const usage = objectValue(value);
  const last = objectValue(usage?.last);
  const total = objectValue(usage?.total);
  const usedTokens = nonNegativeNumber(last?.totalTokens);
  const totalProcessedTokens = nonNegativeNumber(total?.totalTokens);
  const maxTokens = nonNegativeNumber(usage?.modelContextWindow);
  if (usedTokens === null && totalProcessedTokens === null && maxTokens === null) return undefined;
  return {
    usedTokens,
    totalProcessedTokens,
    totalProcessedScope: "thread",
    maxTokens,
    inputTokens: nonNegativeNumber(last?.inputTokens),
    cachedInputTokens: nonNegativeNumber(last?.cachedInputTokens),
    cacheWriteInputTokens: nonNegativeNumber(last?.cacheWriteInputTokens),
    outputTokens: nonNegativeNumber(last?.outputTokens),
    reasoningOutputTokens: nonNegativeNumber(last?.reasoningOutputTokens),
    compactsAutomatically: null,
  };
}

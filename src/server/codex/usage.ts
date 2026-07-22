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
  if (usedTokens === null || usedTokens <= 0) return undefined;
  return {
    usedTokens,
    totalProcessedTokens: nonNegativeNumber(total?.totalTokens),
    maxTokens: nonNegativeNumber(usage?.modelContextWindow),
    inputTokens: nonNegativeNumber(last?.inputTokens),
    cachedInputTokens: nonNegativeNumber(last?.cachedInputTokens),
    outputTokens: nonNegativeNumber(last?.outputTokens),
    reasoningOutputTokens: nonNegativeNumber(last?.reasoningOutputTokens),
    compactsAutomatically: true,
  };
}

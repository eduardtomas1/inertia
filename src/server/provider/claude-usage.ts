import type { Query, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

import type { ProviderRateLimit, ThreadUsageSnapshot } from "../../shared/contracts";
import { clampProviderPercent, providerTimestamp } from "./usage-values";

export type ClaudeUsageSnapshot = Omit<
  ThreadUsageSnapshot,
  "conversationId" | "turnId" | "updatedAt"
>;

export interface ClaudeUsageParseOptions {
  /** Exact selected wire model when it is known. */
  selectedModelId?: string | null;
  /**
   * A verified or user-declared route window. This can describe the window,
   * but never manufactures occupancy when the provider did not report usage.
   */
  contextWindowOverride?: number | null;
  /** Point-in-time context returned by the Agent SDK control protocol. */
  contextUsage?: unknown;
}

const MAX_TOKEN_COUNT = 1_000_000_000_000;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function tokenCount(value: unknown, allowZero = true): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= (allowZero ? 0 : 1)
    && value <= MAX_TOKEN_COUNT
    ? value
    : null;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  const total = known.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) && total <= MAX_TOKEN_COUNT ? total : null;
}

interface UsageBreakdown {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalInputTokens: number | null;
  totalTokens: number | null;
}

function usageBreakdown(value: unknown): UsageBreakdown {
  const usage = objectValue(value);
  const uncachedInputTokens = tokenCount(usage?.input_tokens);
  const cachedInputTokens = tokenCount(usage?.cache_read_input_tokens);
  const cacheWriteInputTokens = tokenCount(usage?.cache_creation_input_tokens);
  const outputTokens = tokenCount(usage?.output_tokens);
  const reasoningOutputTokens = tokenCount(
    objectValue(usage?.output_tokens_details)?.thinking_tokens,
  );
  const totalInputTokens = sumKnown([
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
  ]);
  const explicitTotal = tokenCount(usage?.total_tokens);
  return {
    // Anthropic defines total request input as the sum of uncached, cache-read,
    // and cache-creation tokens. The cache fields remain available as a
    // breakdown rather than being silently omitted from the input total.
    inputTokens: totalInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalInputTokens,
    totalTokens: explicitTotal ?? sumKnown([totalInputTokens, outputTokens]),
  };
}

function lastIteration(value: unknown): Record<string, unknown> | undefined {
  const usage = objectValue(value);
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration = objectValue(iterations[index]);
    if (iteration) return iteration;
  }
  return undefined;
}

function contextWindowFromModelUsage(
  value: unknown,
  selectedModelId: string | null | undefined,
): number | null {
  const modelUsage = objectValue(value);
  if (!modelUsage) return null;

  if (selectedModelId) {
    const exact = tokenCount(
      objectValue(modelUsage[selectedModelId])?.contextWindow,
      false,
    );
    if (exact !== null) return exact;
  }

  const windows = [...new Set(
    Object.values(modelUsage)
      .map((entry) => tokenCount(objectValue(entry)?.contextWindow, false))
      .filter((entry): entry is number => entry !== null),
  )];
  // Several model windows can include subagents or fallbacks. Without an exact
  // selected-model match, choosing one would misrepresent the main session.
  return windows.length === 1 ? windows[0]! : null;
}

/**
 * Converts one Claude Agent SDK result into Inertia's truthful point-in-time
 * usage contract.
 *
 * The aggregate result usage is provider-defined run processing. Active
 * context comes only from getContextUsage(), the last reported API iteration,
 * or a single-turn result. Aggregate multi-turn billing totals never stand in
 * for live context occupancy.
 */
export function parseClaudeUsage(
  value: unknown,
  options: ClaudeUsageParseOptions = {},
): ClaudeUsageSnapshot | null {
  const result = objectValue(value) ?? {};
  const resultUsage = objectValue(result.usage);
  const contextUsage = objectValue(options.contextUsage);
  const aggregate = usageBreakdown(resultUsage);
  const contextApiUsage = usageBreakdown(contextUsage?.apiUsage);
  const iteration = lastIteration(resultUsage);
  const iterationUsage = usageBreakdown(iteration);
  const resultTurns = tokenCount(result.num_turns, false);

  const reportedContextTokens = tokenCount(contextUsage?.totalTokens);
  const singleTurnContextTokens = resultTurns === 1
    ? aggregate.totalTokens
    : null;
  const usedTokens = reportedContextTokens
    ?? iterationUsage.totalTokens
    ?? singleTurnContextTokens;

  const contextMax = tokenCount(contextUsage?.maxTokens, false);
  const modelMax = contextWindowFromModelUsage(
    result.modelUsage,
    options.selectedModelId,
  );
  const configuredMax = tokenCount(options.contextWindowOverride, false);
  const maxTokens = contextMax ?? modelMax ?? configuredMax;
  const validUsedTokens = usedTokens !== null
    && (maxTokens === null || usedTokens <= maxTokens)
    ? usedTokens
    : null;

  const compactsAutomatically = typeof contextUsage?.isAutoCompactEnabled === "boolean"
    ? contextUsage.isAutoCompactEnabled
    : null;
  const hasAggregateUsage = resultUsage !== undefined;
  const inputTokens = hasAggregateUsage
    ? aggregate.inputTokens
    : contextApiUsage.inputTokens;
  const cachedInputTokens = hasAggregateUsage
    ? aggregate.cachedInputTokens
    : contextApiUsage.cachedInputTokens;
  const cacheWriteInputTokens = hasAggregateUsage
    ? aggregate.cacheWriteInputTokens
    : contextApiUsage.cacheWriteInputTokens;
  const outputTokens = hasAggregateUsage
    ? aggregate.outputTokens
    : contextApiUsage.outputTokens;
  const reasoningOutputTokens = hasAggregateUsage
    ? aggregate.reasoningOutputTokens
    : contextApiUsage.reasoningOutputTokens;
  const totalProcessedTokens = hasAggregateUsage ? aggregate.totalTokens : null;

  if (
    validUsedTokens === null
    && totalProcessedTokens === null
    && maxTokens === null
    && inputTokens === null
    && cachedInputTokens === null
    && cacheWriteInputTokens === null
    && outputTokens === null
    && reasoningOutputTokens === null
    && compactsAutomatically === null
  ) return null;

  return {
    usedTokens: validUsedTokens,
    totalProcessedTokens,
    totalProcessedScope: totalProcessedTokens === null ? null : "run",
    maxTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    compactsAutomatically,
  };
}

/**
 * Optional control-protocol read. Callers must keep it off the terminal result
 * critical path: a context refresh is useful, but must never keep a completed
 * provider turn visibly running.
 */
export async function readClaudeContextUsage(
  query: Query,
): Promise<SDKControlGetContextUsageResponse | undefined> {
  if (typeof query.getContextUsage !== "function") return undefined;
  try {
    return await query.getContextUsage();
  } catch {
    return undefined;
  }
}

const rateLimitLabels: Readonly<Record<string, { label: string; minutes: number | null }>> = {
  five_hour: { label: "Claude · 5 hour", minutes: 300 },
  seven_day: { label: "Claude · 7 day", minutes: 10_080 },
  seven_day_opus: { label: "Claude Opus · 7 day", minutes: 10_080 },
  seven_day_sonnet: { label: "Claude Sonnet · 7 day", minutes: 10_080 },
  seven_day_overage_included: {
    label: "Claude extra usage · 7 day",
    minutes: 10_080,
  },
  overage: { label: "Claude extra usage", minutes: null },
};

/** Sparse account-limit update emitted by native Claude Code sessions. */
export function parseClaudeRateLimitEvent(value: unknown): ProviderRateLimit | null {
  const message = objectValue(value);
  const info = objectValue(message?.rate_limit_info);
  const type = typeof info?.rateLimitType === "string"
    ? info.rateLimitType
    : null;
  const utilization = clampProviderPercent(info?.utilization);
  if (!type || utilization === null) return null;
  const presentation = rateLimitLabels[type] ?? {
    label: `Claude · ${type.replaceAll("_", " ")}`,
    minutes: null,
  };
  return {
    id: `claude:${type}`,
    label: presentation.label,
    usedPercent: utilization,
    remainingPercent: 100 - utilization,
    windowMinutes: presentation.minutes,
    resetsAt: providerTimestamp(info?.resetsAt),
  };
}

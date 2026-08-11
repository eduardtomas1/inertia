import type {
  AgentTurn,
  AgentTurnUsageSnapshot,
  ProviderId,
  UsageCoverage,
  UsageDashboard,
  UsageDashboardBreakdown,
  UsageDashboardDay,
  UsageDashboardModelBreakdown,
  UsageMeasuredValue,
  UsageRangeDays,
  UsageTokenField,
} from "../shared/contracts";

export interface UsageDashboardRange {
  days: UsageRangeDays;
  fromInclusive: string;
  toExclusive: string;
  endDate: string;
  timeZone: string;
}

export type UsageDashboardTurn = Pick<
  AgentTurn,
  | "providerId"
  | "modelSelection"
  | "continuationIdentity"
  | "model"
  | "providerSessionBefore"
  | "providerSessionAfter"
  | "startedAt"
  | "completedAt"
  | "status"
  | "usageAtStart"
  | "usageAtCompletion"
  | "association"
>;

interface MeasuredAccumulator {
  value: number;
  measuredRequests: number;
  overflow: boolean;
}

interface UsageBucket {
  requestCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  interruptedCount: number;
  runtime: MeasuredAccumulator;
  processedTokens: MeasuredAccumulator;
}

interface DailyBucket extends UsageBucket {
  providers: Map<ProviderId, ProviderBucket>;
}

interface ProviderBucket extends UsageBucket {
  providerId: ProviderId;
}

interface ModelBucket extends ProviderBucket {
  key: string;
  model: string;
  backendProfileId: string;
  backendLabel: string;
  backendConfigurationRevision: number;
}

const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const COST_UNAVAILABLE_REASON =
  "Inertia does not persist versioned model pricing or provider invoice charges.";
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/u;

function emptyMeasuredAccumulator(): MeasuredAccumulator {
  return { value: 0, measuredRequests: 0, overflow: false };
}

function emptyUsageBucket(): UsageBucket {
  return {
    requestCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    interruptedCount: 0,
    runtime: emptyMeasuredAccumulator(),
    processedTokens: emptyMeasuredAccumulator(),
  };
}

function emptyDailyBucket(): DailyBucket {
  return {
    ...emptyUsageBucket(),
    providers: new Map<ProviderId, ProviderBucket>(),
  };
}

function addMeasured(
  accumulator: MeasuredAccumulator,
  value: number | null,
): void {
  if (value === null) return;
  accumulator.measuredRequests += 1;
  if (accumulator.overflow) return;
  const next = accumulator.value + value;
  if (!Number.isSafeInteger(next) || next < 0) {
    accumulator.overflow = true;
    return;
  }
  accumulator.value = next;
}

function coverage(
  measuredRequests: number,
  totalRequests: number,
): UsageCoverage {
  if (measuredRequests === 0) return "unavailable";
  return measuredRequests === totalRequests ? "complete" : "partial";
}

function measuredValue(
  accumulator: MeasuredAccumulator,
  totalRequests: number,
  emptyIsZero = false,
): UsageMeasuredValue {
  if (totalRequests === 0 && emptyIsZero) {
    return {
      value: 0,
      measuredRequests: 0,
      totalRequests: 0,
      coverage: "complete",
    };
  }
  return {
    value: accumulator.measuredRequests === 0 || accumulator.overflow
      ? null
      : accumulator.value,
    measuredRequests: accumulator.measuredRequests,
    totalRequests,
    coverage: accumulator.overflow
      ? "unavailable"
      : coverage(accumulator.measuredRequests, totalRequests),
  };
}

function usageDateFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new Error("The usage dashboard time zone is invalid.");
  }
}

function dateKey(
  milliseconds: number,
  formatter: Intl.DateTimeFormat,
): string {
  const parts = formatter.formatToParts(milliseconds);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function parsedDateKey(value: string): Date {
  const match = DATE_KEY.exec(value);
  if (!match) throw new Error("The usage dashboard end date is invalid.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error("The usage dashboard end date is invalid.");
  }
  return date;
}

function usageDateKeys(endDate: string, days: UsageRangeDays): string[] {
  const end = parsedDateKey(endDate);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (days - index - 1));
    return date.toISOString().slice(0, 10);
  });
}

function validateRange(range: UsageDashboardRange): {
  from: number;
  to: number;
  formatter: Intl.DateTimeFormat;
  dateKeys: string[];
} {
  const from = Date.parse(range.fromInclusive);
  const to = Date.parse(range.toExclusive);
  const expectedDuration = range.days * 24 * 60 * 60 * 1_000;
  if (
    !Number.isFinite(from)
    || !Number.isFinite(to)
    || from >= to
    || Math.abs(to - from - expectedDuration) > 4 * 60 * 60 * 1_000
  ) {
    throw new Error("The usage dashboard date range is invalid.");
  }
  const formatter = usageDateFormatter(range.timeZone);
  const keys = usageDateKeys(range.endDate, range.days);
  if (
    dateKey(from, formatter) !== keys[0]
    || dateKey(from - 1, formatter) === keys[0]
    || dateKey(to - 1, formatter) !== range.endDate
    || dateKey(to, formatter) === range.endDate
  ) {
    throw new Error("The usage dashboard range does not match its time zone.");
  }
  return { from, to, formatter, dateKeys: keys };
}

/** Rejects renderer-supplied range boundaries before they reach persistence. */
export function validateUsageDashboardRange(
  range: UsageDashboardRange,
): void {
  validateRange(range);
}

function hasComparableCumulativeProvenance(turn: UsageDashboardTurn): boolean {
  const selection = turn.modelSelection;
  const identity = turn.continuationIdentity;
  // Turn preparation records a session-before only after the continuation
  // policy proves that this immutable execution identity can resume it. A
  // changed session at settlement makes the two cumulative snapshots
  // incomparable, even when their broad provider scopes happen to match.
  return turn.providerSessionBefore !== null
    && turn.providerSessionAfter === turn.providerSessionBefore
    && identity.harnessId === selection.harnessId
    && identity.backendProfileId === selection.backendProfileId
    && identity.backendConfigurationRevision
      === selection.backendConfigurationRevision
    && (
      identity.modelIdentity === null
      || identity.modelIdentity === selection.modelId
    );
}

function measuredProcessedTokens(turn: UsageDashboardTurn): number | null {
  const completion = turn.usageAtCompletion;
  const completionTotal = completion?.totalProcessedTokens;
  const scope = completion?.totalProcessedScope;
  if (completionTotal === null || completionTotal === undefined || !scope) {
    return null;
  }
  if (scope === "run") return completionTotal;
  const start = turn.usageAtStart;
  if (
    !hasComparableCumulativeProvenance(turn)
    || start?.totalProcessedTokens === null
    || start?.totalProcessedTokens === undefined
    || start.totalProcessedScope !== scope
    || completionTotal < start.totalProcessedTokens
  ) {
    return null;
  }
  return completionTotal - start.totalProcessedTokens;
}

function measuredRuntime(turn: UsageDashboardTurn): number | null {
  if (!turn.startedAt || !turn.completedAt) return null;
  const startedAt = Date.parse(turn.startedAt);
  const completedAt = Date.parse(turn.completedAt);
  const duration = completedAt - startedAt;
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : null;
}

function addTurn(bucket: UsageBucket, turn: UsageDashboardTurn): void {
  bucket.requestCount += 1;
  if (turn.status === "completed") bucket.completedCount += 1;
  else if (turn.status === "failed") bucket.failedCount += 1;
  else if (turn.status === "cancelled") bucket.cancelledCount += 1;
  else bucket.interruptedCount += 1;
  addMeasured(bucket.runtime, measuredRuntime(turn));
  addMeasured(bucket.processedTokens, measuredProcessedTokens(turn));
}

function tokenField(
  accumulator: MeasuredAccumulator,
  totalRequests: number,
): UsageTokenField {
  return measuredValue(accumulator, totalRequests);
}

function breakdownValue(
  key: string,
  bucket: ProviderBucket,
): UsageDashboardBreakdown {
  return {
    key,
    providerId: bucket.providerId,
    providerLabel: PROVIDER_LABELS[bucket.providerId],
    requestCount: bucket.requestCount,
    runtime: measuredValue(bucket.runtime, bucket.requestCount),
    processedTokens: measuredValue(
      bucket.processedTokens,
      bucket.requestCount,
    ),
  };
}

function breakdownSort(
  left: UsageDashboardBreakdown,
  right: UsageDashboardBreakdown,
): number {
  return (right.processedTokens.value ?? -1)
    - (left.processedTokens.value ?? -1)
    || right.requestCount - left.requestCount
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/**
 * Produces a renderer-safe, local-only dashboard from immutable turn records.
 * It never projects conversation identity, prompts, paths, or provider payloads.
 */
export function projectUsageDashboard(
  turns: readonly UsageDashboardTurn[],
  range: UsageDashboardRange,
  generatedAt = new Date().toISOString(),
): UsageDashboard {
  const validated = validateRange(range);
  const dailyBuckets = new Map(
    validated.dateKeys.map((key) => [key, emptyDailyBucket()]),
  );
  const providerBuckets = new Map<ProviderId, ProviderBucket>();
  const modelBuckets = new Map<string, ModelBucket>();
  const totalBucket = emptyUsageBucket();
  const tokenAccumulators = {
    input: emptyMeasuredAccumulator(),
    cachedInput: emptyMeasuredAccumulator(),
    cacheWriteInput: emptyMeasuredAccumulator(),
    output: emptyMeasuredAccumulator(),
    reasoningOutput: emptyMeasuredAccumulator(),
  };

  for (const turn of turns) {
    if (
      !turn.completedAt
      || turn.association !== "authoritative"
      || !["completed", "failed", "cancelled", "interrupted"].includes(
        turn.status,
      )
    ) continue;
    const completedAt = Date.parse(turn.completedAt);
    if (completedAt < validated.from || completedAt >= validated.to) continue;
    const day = dailyBuckets.get(dateKey(completedAt, validated.formatter));
    if (!day) continue;

    addTurn(day, turn);
    addTurn(totalBucket, turn);

    const dailyProvider = day.providers.get(turn.providerId) ?? {
      ...emptyUsageBucket(),
      providerId: turn.providerId,
    };
    addTurn(dailyProvider, turn);
    day.providers.set(turn.providerId, dailyProvider);

    const provider = providerBuckets.get(turn.providerId) ?? {
      ...emptyUsageBucket(),
      providerId: turn.providerId,
    };
    addTurn(provider, turn);
    providerBuckets.set(turn.providerId, provider);

    const modelKey = JSON.stringify([
      turn.providerId,
      turn.continuationIdentity.harnessId,
      turn.modelSelection.backendProfileId,
      turn.modelSelection.backendProfileDisplayName,
      turn.modelSelection.backendConfigurationRevision,
      turn.continuationIdentity.endpointIdentity,
      turn.model,
    ]);
    const model = modelBuckets.get(modelKey) ?? {
      ...emptyUsageBucket(),
      key: `model-${modelBuckets.size}`,
      providerId: turn.providerId,
      model: turn.model || "Unknown model",
      backendProfileId: turn.modelSelection.backendProfileId,
      backendLabel: turn.modelSelection.backendProfileDisplayName
        || PROVIDER_LABELS[turn.providerId],
      backendConfigurationRevision:
        turn.modelSelection.backendConfigurationRevision,
    };
    addTurn(model, turn);
    modelBuckets.set(modelKey, model);

    const completion: AgentTurnUsageSnapshot | null = turn.usageAtCompletion;
    addMeasured(tokenAccumulators.input, completion?.inputTokens ?? null);
    addMeasured(
      tokenAccumulators.cachedInput,
      completion?.cachedInputTokens ?? null,
    );
    addMeasured(
      tokenAccumulators.cacheWriteInput,
      completion?.cacheWriteInputTokens ?? null,
    );
    addMeasured(tokenAccumulators.output, completion?.outputTokens ?? null);
    addMeasured(
      tokenAccumulators.reasoningOutput,
      completion?.reasoningOutputTokens ?? null,
    );
  }

  const daily: UsageDashboardDay[] = [...dailyBuckets].map(([date, bucket]) => ({
    date,
    requestCount: bucket.requestCount,
    completedCount: bucket.completedCount,
    failedCount: bucket.failedCount,
    cancelledCount: bucket.cancelledCount,
    interruptedCount: bucket.interruptedCount,
    runtime: measuredValue(bucket.runtime, bucket.requestCount, true),
    processedTokens: measuredValue(
      bucket.processedTokens,
      bucket.requestCount,
      true,
    ),
    providers: [...bucket.providers].map(([key, provider]) =>
      breakdownValue(key, provider)).sort(breakdownSort),
  }));
  const providers = [...providerBuckets].map(([key, bucket]) =>
    breakdownValue(key, bucket)).sort(breakdownSort);
  const models: UsageDashboardModelBreakdown[] = [...modelBuckets.values()].map(
    (bucket) => ({
      ...breakdownValue(bucket.key, bucket),
      model: bucket.model,
      backendProfileId: bucket.backendProfileId,
      backendLabel: bucket.backendLabel,
      backendConfigurationRevision: bucket.backendConfigurationRevision,
    }),
  ).sort(breakdownSort);

  return {
    generatedAt,
    range: {
      ...range,
      startDate: validated.dateKeys[0]!,
    },
    totals: {
      requestCount: totalBucket.requestCount,
      completedCount: totalBucket.completedCount,
      failedCount: totalBucket.failedCount,
      cancelledCount: totalBucket.cancelledCount,
      interruptedCount: totalBucket.interruptedCount,
      activeDays: daily.filter(({ requestCount }) => requestCount > 0).length,
      runtime: measuredValue(totalBucket.runtime, totalBucket.requestCount),
      processedTokens: measuredValue(
        totalBucket.processedTokens,
        totalBucket.requestCount,
      ),
    },
    daily,
    providers,
    models,
    tokens: {
      input: tokenField(tokenAccumulators.input, totalBucket.requestCount),
      cachedInput: tokenField(
        tokenAccumulators.cachedInput,
        totalBucket.requestCount,
      ),
      cacheWriteInput: tokenField(
        tokenAccumulators.cacheWriteInput,
        totalBucket.requestCount,
      ),
      output: tokenField(tokenAccumulators.output, totalBucket.requestCount),
      reasoningOutput: tokenField(
        tokenAccumulators.reasoningOutput,
        totalBucket.requestCount,
      ),
    },
    cost: {
      status: "unavailable",
      reason: COST_UNAVAILABLE_REASON,
    },
  };
}

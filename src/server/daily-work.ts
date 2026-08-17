import type {
  AgentTurn,
  DailyWorkConversationSummary,
  DailyWorkDashboard,
  DailyWorkProviderSummary,
  ProviderId,
  UsageCoverage,
  UsageMeasuredValue,
} from "../shared/contracts";
import { isAgentTurnTerminalStatus } from "../shared/turn-lifecycle";
import {
  measuredProcessedTokens,
  PROVIDER_LABELS,
  type UsageDashboardTurn,
} from "./usage-dashboard";

export interface DailyWorkRange {
  date: string;
  fromInclusive: string;
  toExclusive: string;
  timeZone: string;
}

export interface DailyWorkConversationSource {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  providerId: ProviderId;
  createdAt: string;
}

export type DailyWorkTurn = UsageDashboardTurn & Pick<
  AgentTurn,
  "id" | "conversationId" | "requestedAt" | "updatedAt"
>;

interface MetricAccumulator {
  value: number;
  measuredRequests: number;
  totalRequests: number;
  overflow: boolean;
}

interface WorkBucket {
  turnCount: number;
  activeTurnCount: number;
  runtime: MetricAccumulator;
  processedTokens: MetricAccumulator;
}

interface ConversationBucket extends WorkBucket {
  source: DailyWorkConversationSource;
  createdToday: boolean;
  lastActivityAt: string;
  providerIds: Set<ProviderId>;
}

interface ProviderBucket extends WorkBucket {
  providerId: ProviderId;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;
const MINIMUM_LOCAL_DAY_MS = 20 * 60 * 60 * 1_000;
const MAXIMUM_LOCAL_DAY_MS = 28 * 60 * 60 * 1_000;

function emptyMetric(): MetricAccumulator {
  return {
    value: 0,
    measuredRequests: 0,
    totalRequests: 0,
    overflow: false,
  };
}

function emptyWorkBucket(): WorkBucket {
  return {
    turnCount: 0,
    activeTurnCount: 0,
    runtime: emptyMetric(),
    processedTokens: emptyMetric(),
  };
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new Error("The daily work time zone is invalid.");
  }
}

function dateKey(milliseconds: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(milliseconds);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function validateDailyWorkRange(range: DailyWorkRange): {
  from: number;
  to: number;
} {
  const from = Date.parse(range.fromInclusive);
  const to = Date.parse(range.toExclusive);
  const duration = to - from;
  if (
    !DATE_KEY.test(range.date)
    || !Number.isFinite(from)
    || !Number.isFinite(to)
    || from >= to
    || duration < MINIMUM_LOCAL_DAY_MS
    || duration > MAXIMUM_LOCAL_DAY_MS
  ) {
    throw new Error("The daily work date range is invalid.");
  }
  const formatter = dateFormatter(range.timeZone);
  if (
    dateKey(from, formatter) !== range.date
    || dateKey(from - 1, formatter) === range.date
    || dateKey(to - 1, formatter) !== range.date
    || dateKey(to, formatter) === range.date
  ) {
    throw new Error("The daily work range does not match its time zone.");
  }
  return { from, to };
}

function addMetric(accumulator: MetricAccumulator, value: number | null): void {
  accumulator.totalRequests += 1;
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

function coverage(accumulator: MetricAccumulator): UsageCoverage {
  if (accumulator.overflow || accumulator.measuredRequests === 0) {
    return "unavailable";
  }
  return accumulator.measuredRequests === accumulator.totalRequests
    ? "complete"
    : "partial";
}

function measuredValue(accumulator: MetricAccumulator): UsageMeasuredValue {
  if (accumulator.totalRequests === 0) {
    return {
      value: 0,
      measuredRequests: 0,
      totalRequests: 0,
      coverage: "complete",
    };
  }
  const metricCoverage = coverage(accumulator);
  return {
    value: metricCoverage === "unavailable" ? null : accumulator.value,
    measuredRequests: accumulator.measuredRequests,
    totalRequests: accumulator.totalRequests,
    coverage: metricCoverage,
  };
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dailyRuntime(
  turn: DailyWorkTurn,
  from: number,
  to: number,
): number | null {
  const startedAt = timestamp(turn.startedAt);
  const completedAt = timestamp(turn.completedAt);
  if (startedAt === null || completedAt === null) return null;
  const duration = Math.min(completedAt, to) - Math.max(startedAt, from);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : null;
}

function isCreatedToday(
  conversation: DailyWorkConversationSource,
  from: number,
  to: number,
): boolean {
  const createdAt = timestamp(conversation.createdAt);
  return createdAt !== null && createdAt >= from && createdAt < to;
}

function isDailyTurn(
  turn: DailyWorkTurn,
  from: number,
  to: number,
  generatedAt: number,
): boolean {
  if (turn.association !== "authoritative") return false;
  if (isAgentTurnTerminalStatus(turn.status)) {
    const completedAt = timestamp(turn.completedAt);
    return completedAt !== null && completedAt >= from && completedAt < to;
  }
  const requestedAt = timestamp(turn.requestedAt);
  return requestedAt !== null
    && requestedAt < to
    && requestedAt <= generatedAt;
}

function addTurn(
  bucket: WorkBucket,
  turn: DailyWorkTurn,
  from: number,
  to: number,
): void {
  bucket.turnCount += 1;
  if (!isAgentTurnTerminalStatus(turn.status)) {
    bucket.activeTurnCount += 1;
    return;
  }
  addMetric(bucket.runtime, dailyRuntime(turn, from, to));
  addMetric(bucket.processedTokens, measuredProcessedTokens(turn));
}

function providerSummary(bucket: ProviderBucket): DailyWorkProviderSummary {
  return {
    providerId: bucket.providerId,
    providerLabel: PROVIDER_LABELS[bucket.providerId],
    turnCount: bucket.turnCount,
    activeTurnCount: bucket.activeTurnCount,
    runtime: measuredValue(bucket.runtime),
    processedTokens: measuredValue(bucket.processedTokens),
  };
}

function conversationSummary(
  bucket: ConversationBucket,
): DailyWorkConversationSummary {
  const providerIds = bucket.providerIds.size > 0
    ? [...bucket.providerIds].sort()
    : [bucket.source.providerId];
  return {
    conversationId: bucket.source.id,
    projectId: bucket.source.projectId,
    projectName: bucket.source.projectName,
    title: bucket.source.title,
    providerIds,
    createdToday: bucket.createdToday,
    running: bucket.activeTurnCount > 0,
    turnCount: bucket.turnCount,
    activeTurnCount: bucket.activeTurnCount,
    lastActivityAt: bucket.lastActivityAt,
    runtime: measuredValue(bucket.runtime),
    processedTokens: measuredValue(bucket.processedTokens),
  };
}

/** Projects a local-day dashboard without exposing prompts, paths, or provider payloads. */
export function projectDailyWork(
  conversations: readonly DailyWorkConversationSource[],
  turns: readonly DailyWorkTurn[],
  range: DailyWorkRange,
  generatedAt = new Date().toISOString(),
): DailyWorkDashboard {
  const { from, to } = validateDailyWorkRange(range);
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error("The daily work generation time is invalid.");
  }
  const conversationBuckets = new Map<string, ConversationBucket>();
  for (const source of conversations) {
    const createdToday = isCreatedToday(source, from, to);
    conversationBuckets.set(source.id, {
      ...emptyWorkBucket(),
      source,
      createdToday,
      lastActivityAt: source.createdAt,
      providerIds: new Set<ProviderId>(),
    });
  }

  const totalBucket = emptyWorkBucket();
  const providerBuckets = new Map<ProviderId, ProviderBucket>();
  for (const turn of turns) {
    if (!isDailyTurn(turn, from, to, generatedAtMs)) continue;
    const conversation = conversationBuckets.get(turn.conversationId);
    if (!conversation) continue;
    addTurn(conversation, turn, from, to);
    addTurn(totalBucket, turn, from, to);
    conversation.providerIds.add(turn.providerId);
    if (Date.parse(turn.updatedAt) > Date.parse(conversation.lastActivityAt)) {
      conversation.lastActivityAt = turn.updatedAt;
    }

    const provider = providerBuckets.get(turn.providerId) ?? {
      ...emptyWorkBucket(),
      providerId: turn.providerId,
    };
    addTurn(provider, turn, from, to);
    providerBuckets.set(turn.providerId, provider);
  }

  const summaries: DailyWorkConversationSummary[] = [];
  for (const bucket of conversationBuckets.values()) {
    if (bucket.createdToday || bucket.turnCount > 0) {
      summaries.push(conversationSummary(bucket));
    }
  }
  summaries.sort((left, right) => Date.parse(right.lastActivityAt)
    - Date.parse(left.lastActivityAt)
    || left.conversationId.localeCompare(right.conversationId));
  const providers = [...providerBuckets.values()]
    .map(providerSummary)
    .sort((left, right) => (right.processedTokens.value ?? -1)
      - (left.processedTokens.value ?? -1)
      || (right.runtime.value ?? -1) - (left.runtime.value ?? -1)
      || right.turnCount - left.turnCount
      || left.providerId.localeCompare(right.providerId));

  return {
    generatedAt,
    date: range.date,
    range: {
      fromInclusive: range.fromInclusive,
      toExclusive: range.toExclusive,
      timeZone: range.timeZone,
    },
    totals: {
      conversationCount: summaries.length,
      turnCount: totalBucket.turnCount,
      activeTurnCount: totalBucket.activeTurnCount,
      runtime: measuredValue(totalBucket.runtime),
      processedTokens: measuredValue(totalBucket.processedTokens),
    },
    providers,
    conversations: summaries,
  };
}

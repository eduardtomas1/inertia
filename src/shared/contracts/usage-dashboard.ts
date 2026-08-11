import type { ProviderId } from "./app";

export const USAGE_RANGE_DAYS = [7, 30, 90] as const;

export type UsageRangeDays = (typeof USAGE_RANGE_DAYS)[number];
export type UsageCoverage = "complete" | "partial" | "unavailable";

export interface UsageMeasuredValue {
  value: number | null;
  measuredRequests: number;
  totalRequests: number;
  coverage: UsageCoverage;
}

export interface UsageRuntimeValue extends UsageMeasuredValue {
  /** Measured wall-clock time between the durable turn start and completion. */
  value: number | null;
}

export interface UsageTokenField extends UsageMeasuredValue {
  /** Sum of provider-reported completion fields; categories can overlap. */
  value: number | null;
}

export interface UsageDashboardDay {
  date: string;
  requestCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  interruptedCount: number;
  runtime: UsageRuntimeValue;
  processedTokens: UsageMeasuredValue;
}

export interface UsageDashboardBreakdown {
  key: string;
  providerId: ProviderId;
  providerLabel: string;
  requestCount: number;
  runtime: UsageRuntimeValue;
  processedTokens: UsageMeasuredValue;
}

export interface UsageDashboardModelBreakdown
  extends UsageDashboardBreakdown {
  model: string;
  backendProfileId: string;
  backendLabel: string;
}

export interface UsageDashboard {
  generatedAt: string;
  range: {
    days: UsageRangeDays;
    fromInclusive: string;
    toExclusive: string;
    startDate: string;
    endDate: string;
    timeZone: string;
  };
  totals: {
    requestCount: number;
    completedCount: number;
    failedCount: number;
    cancelledCount: number;
    interruptedCount: number;
    activeDays: number;
    runtime: UsageRuntimeValue;
    processedTokens: UsageMeasuredValue;
  };
  daily: UsageDashboardDay[];
  providers: UsageDashboardBreakdown[];
  models: UsageDashboardModelBreakdown[];
  tokens: {
    input: UsageTokenField;
    cachedInput: UsageTokenField;
    cacheWriteInput: UsageTokenField;
    output: UsageTokenField;
    reasoningOutput: UsageTokenField;
  };
  cost: {
    status: "unavailable";
    reason: string;
  };
}

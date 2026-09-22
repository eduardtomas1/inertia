import type { EnvironmentUsageSummary } from "./environmentSummary";

export const HEADER_METER_LOW_REMAINING_PERCENT = 20;

export type HeaderMeterLimit = EnvironmentUsageSummary["quota"]["limits"][number];

export interface HeaderUsageMeterModel {
  primary: HeaderMeterLimit;
  secondary: HeaderMeterLimit | null;
  tightest: HeaderMeterLimit;
  limits: HeaderMeterLimit[];
  low: boolean;
  valueLabel: string;
  accessibleLabel: string;
  freshness: EnvironmentUsageSummary["quota"]["freshness"];
}

export function quotaWindowLabel(windowMinutes: number | null): string | null {
  if (!windowMinutes || !Number.isSafeInteger(windowMinutes) || windowMinutes < 1) {
    return null;
  }
  if (windowMinutes === 7 * 24 * 60) return "weekly";
  if (windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return days === 1 ? "daily" : `${days}-day`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour`;
  return `${windowMinutes}-minute`;
}

export function quotaResetLabel(resetsAt: string | null, now: number): string {
  const time = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(time)) return "Reset time unavailable";
  const minutes = Math.ceil((time - now) / 60_000);
  if (minutes <= 0) return "Reset due · refresh to check";
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 1440) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

export function clampRemainingPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function windowOrder(limit: HeaderMeterLimit): number {
  return limit.windowMinutes && limit.windowMinutes > 0
    ? limit.windowMinutes
    : Number.MAX_SAFE_INTEGER;
}

export function headerUsageMeterModel(
  usage: EnvironmentUsageSummary | null,
): HeaderUsageMeterModel | null {
  if (!usage || usage.quota.source !== "selected-route") return null;
  const limits = usage.quota.limits
    .filter((limit) => Number.isFinite(limit.remainingPercent))
    .sort((left, right) => windowOrder(left) - windowOrder(right));
  const primary = limits[0];
  if (!primary) return null;
  const secondary = limits.length > 1 ? limits[limits.length - 1]! : null;
  const tightest = limits.reduce(
    (lowest, limit) => limit.remainingPercent < lowest.remainingPercent ? limit : lowest,
    primary,
  );
  const remaining = clampRemainingPercent(tightest.remainingPercent);
  const window = quotaWindowLabel(tightest.windowMinutes);
  const freshness = usage.quota.freshness;
  const qualifier = freshness === "stale"
    ? ", may be out of date"
    : freshness === "refreshing" ? ", refreshing" : "";
  return {
    primary,
    secondary,
    tightest,
    limits,
    low: tightest.remainingPercent < HEADER_METER_LOW_REMAINING_PERCENT,
    valueLabel: `${remaining}%`,
    accessibleLabel: `Usage: ${remaining}% of ${window ? `${window} ` : ""}${window ? "limit" : tightest.label} left${qualifier}`,
    freshness,
  };
}

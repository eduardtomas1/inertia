import { Clock3, Gauge } from "lucide-react";

import type { ProviderMetadataFieldState, ProviderRateLimit, ThreadUsageSnapshot } from "@shared/contracts";

type UsageIndicatorProps = {
  usage: ThreadUsageSnapshot | null;
  rateLimits: ProviderRateLimit[];
  rateLimitState: ProviderMetadataFieldState;
  supportsUsage: boolean;
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
export function displayPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

export function contextRemaining(usage: ThreadUsageSnapshot | null): number | null {
  if (usage?.usedTokens === null || usage?.usedTokens === undefined || !usage.maxTokens || usage.maxTokens <= 0) return null;
  return displayPercent(100 - (usage.usedTokens / usage.maxTokens) * 100);
}

function resetLabel(value: string | null): string {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date)}`;
}

function updatedLabel(value: string | null): string {
  if (!value) return "update time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "update time unavailable";
  return `updated ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date)}`;
}

function quotaStateLabel(state: ProviderMetadataFieldState): string {
  if (state.refreshing) return "Refreshing provider quota";
  if (state.freshness === "stale") return `Saved quota data · ${updatedLabel(state.updatedAt)}`;
  if (state.freshness === "fresh") return `Provider quota · ${updatedLabel(state.updatedAt)}`;
  return "Provider quota unavailable";
}

function processedScopeLabel(scope: ThreadUsageSnapshot["totalProcessedScope"]): string {
  return scope === "thread" ? "thread" : scope === "session" ? "session" : scope === "run" ? "run" : "provider report";
}

export function UsageIndicator({ usage, rateLimits, rateLimitState, supportsUsage }: UsageIndicatorProps): React.JSX.Element | null {
  const remainingContext = contextRemaining(usage);
  const primaryLimit = rateLimits[0] ?? null;
  const primaryRemaining = primaryLimit ? displayPercent(primaryLimit.remainingPercent) : null;
  if (!supportsUsage && !usage && rateLimits.length === 0 && rateLimitState.freshness === "unavailable") return null;

  return (
    <details className="usage-indicator">
      <summary aria-label="Open usage details">
        <Gauge size={12} />
        {remainingContext !== null && <span>Context {Math.round(remainingContext)}%</span>}
        {primaryLimit && primaryRemaining !== null && <span>Quota {Math.round(primaryRemaining)}%</span>}
        {remainingContext === null && primaryRemaining === null && <span>Usage —</span>}
      </summary>
      <div className="usage-popover">
        <div className="usage-popover-heading">
          <span><Gauge size={15} /></span>
          <div><strong>Usage details</strong><small>{quotaStateLabel(rateLimitState)}</small></div>
        </div>
        <div className="usage-meter-list">
          <div className="usage-meter-row">
            <div><span>Context window</span><strong>{remainingContext === null ? "Not reported" : `${Math.round(remainingContext)}% left`}</strong></div>
            {remainingContext !== null && <div className="usage-meter-track" aria-hidden="true"><span style={{ width: `${remainingContext}%` }} /></div>}
            {usage && (
              <small>
                {usage.usedTokens === null
                  ? usage.maxTokens && usage.maxTokens > 0 ? `${compactNumber(usage.maxTokens)} window · current occupancy not reported` : "Current occupancy not reported"
                  : `${compactNumber(usage.usedTokens)} used${usage.maxTokens && usage.maxTokens > 0 ? ` of ${compactNumber(usage.maxTokens)}` : ""}`}
                {usage.compactsAutomatically === true ? " · auto-compaction on" : usage.compactsAutomatically === false ? " · auto-compaction off" : ""}
                {` · ${updatedLabel(usage.updatedAt)}`}
              </small>
            )}
            {usage?.totalProcessedTokens !== null && usage?.totalProcessedTokens !== undefined && (
              <small>{compactNumber(usage.totalProcessedTokens)} processed in this {processedScopeLabel(usage.totalProcessedScope)}</small>
            )}
          </div>
          {rateLimits.map((limit) => (
            <div className="usage-meter-row" key={limit.id}>
              <div><span>{limit.label}</span><strong>{displayPercent(limit.remainingPercent) === null ? "Not reported" : `${Math.round(displayPercent(limit.remainingPercent)!)}% left`}</strong></div>
              {displayPercent(limit.remainingPercent) !== null && <div className="usage-meter-track" aria-hidden="true"><span style={{ width: `${displayPercent(limit.remainingPercent)}%` }} /></div>}
              <small><Clock3 size={11} />{resetLabel(limit.resetsAt)}</small>
            </div>
          ))}
          {rateLimits.length === 0 && (
            <div className="usage-meter-row">
              <div><span>Provider quota</span><strong>Not reported</strong></div>
              <small>{rateLimitState.freshness === "stale" ? "Saved quota data is unavailable" : "This provider did not return an account limit"}</small>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

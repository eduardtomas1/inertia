import { Clock3, Gauge } from "lucide-react";

import type { ProviderRateLimit, ThreadUsageSnapshot } from "@shared/contracts";

type UsageIndicatorProps = {
  usage: ThreadUsageSnapshot | null;
  rateLimits: ProviderRateLimit[];
  supportsUsage: boolean;
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function contextRemaining(usage: ThreadUsageSnapshot | null): number | null {
  if (!usage?.maxTokens || usage.maxTokens <= 0) return null;
  return Math.max(0, Math.min(100, 100 - (usage.usedTokens / usage.maxTokens) * 100));
}

function resetLabel(value: string | null): string {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date)}`;
}

export function UsageIndicator({ usage, rateLimits, supportsUsage }: UsageIndicatorProps): React.JSX.Element | null {
  const remainingContext = contextRemaining(usage);
  const primaryLimit = rateLimits[0] ?? null;
  if (!supportsUsage && !usage && rateLimits.length === 0) return null;

  return (
    <details className="usage-indicator">
      <summary aria-label="Open usage details">
        <Gauge size={12} />
        {remainingContext !== null && <span>Context {Math.round(remainingContext)}%</span>}
        {primaryLimit && <span>Usage {Math.round(primaryLimit.remainingPercent)}%</span>}
        {remainingContext === null && !primaryLimit && <span>Usage —</span>}
      </summary>
      <div className="usage-popover">
        <div className="usage-popover-heading">
          <span><Gauge size={15} /></span>
          <div><strong>Remaining capacity</strong><small>Live values reported by the provider</small></div>
        </div>
        <div className="usage-meter-list">
          <div className="usage-meter-row">
            <div><span>Context window</span><strong>{remainingContext === null ? "Not reported" : `${Math.round(remainingContext)}% left`}</strong></div>
            <div className="usage-meter-track" aria-hidden="true"><span style={{ width: `${remainingContext ?? 0}%` }} /></div>
            {usage && <small>{compactNumber(usage.usedTokens)} used{usage.maxTokens ? ` of ${compactNumber(usage.maxTokens)}` : ""}{usage.compactsAutomatically ? " · auto-compacts" : ""}</small>}
          </div>
          {rateLimits.map((limit) => (
            <div className="usage-meter-row" key={limit.id}>
              <div><span>{limit.label}</span><strong>{Math.round(limit.remainingPercent)}% left</strong></div>
              <div className="usage-meter-track" aria-hidden="true"><span style={{ width: `${limit.remainingPercent}%` }} /></div>
              <small><Clock3 size={11} />{resetLabel(limit.resetsAt)}</small>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

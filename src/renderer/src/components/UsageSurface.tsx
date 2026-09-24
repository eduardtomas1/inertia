import { useEffect, useState, type CSSProperties } from "react";
import { BarChart3, RefreshCw, Users } from "lucide-react";

import type { EnvironmentUsageSummary } from "../utils/environmentSummary";
import {
  clampRemainingPercent,
  HEADER_METER_LOW_REMAINING_PERCENT,
  quotaResetLabel,
  quotaWindowLabel,
} from "../utils/headerUsageMeter";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { useUsageLimitsContext } from "./usage-limits-state";
import "./WorkspaceSurfaces.css";

export interface UsageSurfaceProps {
  usage: EnvironmentUsageSummary | null;
  onRefreshUsage?: () => void;
  onOpenUsageView?: () => void;
}

function freshnessLabel(
  freshness: EnvironmentUsageSummary["quota"]["freshness"],
  source: EnvironmentUsageSummary["quota"]["source"],
): string {
  if (source === "isolated") return "Unavailable for this backend";
  if (freshness === "current") return "Current";
  if (freshness === "stale") return "Stale";
  if (freshness === "refreshing") return "Refreshing";
  return "Unavailable";
}

function capitalized(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function UsageSurface({
  usage,
  onRefreshUsage,
  onOpenUsageView,
}: UsageSurfaceProps): React.JSX.Element {
  const usageLimits = useUsageLimitsContext();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const context = usage?.context ?? null;
  return (
    <section className="workspace-surface usage-surface" aria-label="Usage">
      <div className="workspace-surface-scroll">
        {usage ? (
          <>
            <header className="workspace-surface-heading">
              <ProviderBrandIcon providerId={usage.providerId} decorative size={14} />
              <h3 title={usage.providerLabel}>{usage.providerLabel}</h3>
              <small data-freshness={usage.quota.freshness}>
                {freshnessLabel(usage.quota.freshness, usage.quota.source)}
              </small>
            </header>
            {usage.quota.limits.length > 0 ? (
              <ul className="usage-surface-limits">
                {usage.quota.limits.map((limit) => {
                  const remaining = clampRemainingPercent(limit.remainingPercent);
                  const window = quotaWindowLabel(limit.windowMinutes);
                  return (
                    <li
                      key={limit.id}
                      data-low={limit.remainingPercent < HEADER_METER_LOW_REMAINING_PERCENT || undefined}
                    >
                      <span className="usage-surface-limit-row">
                        <span>
                          {limit.label}
                          {window && <small>{capitalized(window)}</small>}
                        </span>
                        <b>{remaining}% left</b>
                      </span>
                      <span
                        className="usage-surface-track"
                        role="meter"
                        aria-label={`${limit.label} remaining`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={remaining}
                        aria-valuetext={`${remaining}% left`}
                      >
                        <i style={{ "--usage-remaining": `${remaining}%` } as CSSProperties} />
                      </span>
                      <small>{quotaResetLabel(limit.resetsAt, now)}</small>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="workspace-surface-empty">
                {usage.quota.freshness === "refreshing"
                  ? "Refreshing provider limits…"
                  : usage.quota.source === "isolated"
                    ? "Account limits are not shared with this custom backend route."
                    : "No provider limit windows are available."}
              </p>
            )}
            {onRefreshUsage
              && usage.quota.source === "selected-route"
              && usage.quota.freshness !== "current" && (
              <button
                type="button"
                className="workspace-surface-button"
                onClick={onRefreshUsage}
                disabled={usage.quota.freshness === "refreshing"}
              >
                <RefreshCw size={13} aria-hidden="true" />
                <span>{usage.quota.freshness === "refreshing" ? "Refreshing" : "Refresh usage"}</span>
              </button>
            )}
          </>
        ) : (
          <p className="workspace-surface-empty">
            Usage is unavailable until this task has a selected provider route.
          </p>
        )}

        {context && (
          <section className="workspace-surface-section" aria-label="This chat">
            <h3>This chat</h3>
            <ul className="usage-surface-limits">
              <li>
                <span className="usage-surface-limit-row">
                  <span>Context window</span>
                  <b>
                    <span aria-hidden="true">{context.valueLabel}</span>
                    <span className="visually-hidden">{context.accessibleLabel}</span>
                  </b>
                </span>
                {context.remainingPercent !== null && (
                  <span className="usage-surface-track is-context" aria-hidden="true">
                    <i
                      style={{
                        "--usage-remaining": `${clampRemainingPercent(context.remainingPercent)}%`,
                      } as CSSProperties}
                    />
                  </span>
                )}
              </li>
            </ul>
          </section>
        )}

        <div className="workspace-surface-actions">
          {usageLimits && (
            <button
              type="button"
              className="workspace-surface-button"
              onClick={(event) => usageLimits.open(event.currentTarget)}
            >
              <Users size={13} aria-hidden="true" />
              <span>All accounts</span>
            </button>
          )}
          {onOpenUsageView && (
            <button
              type="button"
              className="workspace-surface-button"
              onClick={onOpenUsageView}
            >
              <BarChart3 size={13} aria-hidden="true" />
              <span>Usage history</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

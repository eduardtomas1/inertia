import { useState, type CSSProperties } from "react";
import { Gauge, RefreshCw, Users } from "lucide-react";

import type { EnvironmentUsageSummary } from "../utils/environmentSummary";
import { API_KEY_USAGE_UNAVAILABLE } from "../utils/usageDisplay";
import { formatUpdatedAge } from "../utils/quotaAge";
import {
  clampRemainingPercent,
  HEADER_METER_LOW_REMAINING_PERCENT,
  isQuotaResetDue,
  quotaResetLabel,
  quotaWindowLabel,
} from "../utils/headerUsageMeter";
import { useQuotaNow } from "../hooks/useQuotaNow";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { useUsageLimitsContext } from "./usage-limits-state";
import "./WorkspaceSurfaces.css";

export interface UsageSurfaceProps {
  usage: EnvironmentUsageSummary | null;
  onRefreshUsage?: () => Promise<void> | void;
  onOpenUsageView?: () => void;
}

interface RefreshAttempt {
  providerId: EnvironmentUsageSummary["providerId"];
  updatedAt: string | null;
  status: "pending" | "failed";
}

function freshnessLabel(
  quota: EnvironmentUsageSummary["quota"],
  freshness: EnvironmentUsageSummary["quota"]["freshness"],
  now: number,
): string {
  const { source } = quota;
  if (source === "api-key") return "Not available for API keys";
  if (source === "isolated") return "Unavailable for this backend";
  if (freshness === "current") return "Current";
  if (freshness === "stale") {
    const age = formatUpdatedAge(quota.updatedAt, now);
    return age ? `Cached · ${age}` : "Stale";
  }
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
  const [now] = useQuotaNow(usage?.quota.limits ?? []);
  const [attempt, setAttempt] = useState<RefreshAttempt | null>(null);
  const context = usage?.context ?? null;
  const providerId = usage?.providerId ?? null;
  const updatedAt = usage?.quota.updatedAt ?? null;
  const ownAttempt = attempt?.providerId === providerId
    && usage?.quota.source === "selected-route"
    ? attempt
    : null;
  const pending = ownAttempt?.status === "pending";
  const failed = ownAttempt?.status === "failed" && ownAttempt.updatedAt === updatedAt;
  const freshness = pending ? "refreshing" : usage?.quota.freshness ?? "unavailable";
  const refreshUsage = (): void => {
    if (!onRefreshUsage || pending) return;
    const target = { providerId, updatedAt };
    setAttempt({ ...target, status: "pending" });
    void new Promise<void>((resolve) => resolve(onRefreshUsage()))
      .then(
        () => setAttempt((current) => (
          current?.providerId === target.providerId ? null : current
        )),
        () => setAttempt((current) => (
          current?.providerId === target.providerId
            ? { ...target, status: "failed" }
            : current
        )),
      );
  };
  return (
    <section className="workspace-surface usage-surface" aria-label="Usage">
      <div className="workspace-surface-scroll">
        {usage ? (
          <>
            <header className="workspace-surface-heading">
              <ProviderBrandIcon providerId={usage.providerId} decorative size={14} />
              <h3 title={usage.providerLabel}>{usage.providerLabel}</h3>
              <small data-freshness={freshness}>
                {freshnessLabel(usage.quota, freshness, now)}
              </small>
            </header>
            {usage.quota.limits.length > 0 ? (
              <ul className="usage-surface-limits">
                {usage.quota.limits.map((limit) => {
                  const remaining = clampRemainingPercent(limit.remainingPercent);
                  const window = quotaWindowLabel(limit.windowMinutes);
                  const resetDue = isQuotaResetDue(limit, now);
                  return (
                    <li
                      key={limit.id}
                      data-low={(!resetDue && limit.remainingPercent < HEADER_METER_LOW_REMAINING_PERCENT) || undefined}
                      data-reset-due={resetDue || undefined}
                    >
                      <span className="usage-surface-limit-row">
                        <span>
                          {limit.label}
                          {window && <small>{capitalized(window)}</small>}
                        </span>
                        <b>{resetDue ? "Reset" : `${remaining}% left`}</b>
                      </span>
                      <span
                        className="usage-surface-track"
                        role="meter"
                        aria-label={`${limit.label} remaining`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={resetDue ? undefined : remaining}
                        aria-valuetext={resetDue ? "Reset due, usage not yet updated" : `${remaining}% left`}
                      >
                        <i style={{ "--usage-remaining": `${resetDue ? 100 : remaining}%` } as CSSProperties} />
                      </span>
                      <small>{quotaResetLabel(limit.resetsAt, now)}</small>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="workspace-surface-empty">
                {freshness === "refreshing"
                  ? "Refreshing provider limits…"
                  : usage.quota.source === "api-key"
                    ? API_KEY_USAGE_UNAVAILABLE
                    : usage.quota.source === "isolated"
                    ? "Account limits are not shared with this custom backend route."
                    : "No provider limits reported"}
              </p>
            )}
            {onRefreshUsage
              && usage.quota.source === "selected-route"
              && (usage.quota.freshness !== "current" || pending) && (
              <div className="usage-surface-refresh">
                <button
                  type="button"
                  className="workspace-surface-button"
                  onClick={refreshUsage}
                  disabled={freshness === "refreshing"}
                  data-refreshing={freshness === "refreshing" || undefined}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>{freshness === "refreshing" ? "Refreshing…" : "Refresh usage"}</span>
                </button>
                {failed && (
                  <small className="usage-surface-refresh-note" role="status">
                    Could not refresh. Showing cached usage.
                  </small>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="workspace-surface-empty">
            No provider route selected
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
              <Users size={14} aria-hidden="true" />
              <span>All accounts</span>
            </button>
          )}
          {onOpenUsageView && (
            <button
              type="button"
              className="workspace-surface-button"
              onClick={onOpenUsageView}
            >
              <Gauge size={14} aria-hidden="true" />
              <span>Usage history</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

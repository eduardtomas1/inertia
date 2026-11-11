import { useState, type CSSProperties } from "react";
import { Gauge, RefreshCw, Users } from "lucide-react";

import type { EnvironmentUsageSummary } from "../utils/environmentSummary";
import { API_KEY_USAGE_UNAVAILABLE } from "../utils/usageDisplay";
import { formatUpdatedAge } from "../utils/quotaAge";
import { clampRemainingPercent } from "../utils/headerUsageMeter";
import { useQuotaNow } from "../hooks/useQuotaNow";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { LimitRows } from "./usage/LimitBar";
import { useUsageLimitsContext, useUsagePopupOpener } from "./usage-limits-state";
import "./WorkspaceSurfaces.css";

export interface UsageSurfaceProps {
  usage: EnvironmentUsageSummary | null;
  onRefreshUsage?: () => Promise<void> | void;
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

export function UsageSurface({
  usage,
  onRefreshUsage,
}: UsageSurfaceProps): React.JSX.Element {
  const usageLimits = useUsageLimitsContext();
  const openUsage = useUsagePopupOpener();
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
              <LimitRows providerId={usage.providerId} limits={usage.quota.limits} now={now} />
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
              onClick={(event) => usageLimits.open(event.currentTarget, "limits")}
            >
              <Users size={14} aria-hidden="true" />
              <span>All accounts</span>
            </button>
          )}
          {openUsage && (
            <button
              type="button"
              className="workspace-surface-button"
              onClick={(event) => openUsage(event.currentTarget, "tokens")}
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

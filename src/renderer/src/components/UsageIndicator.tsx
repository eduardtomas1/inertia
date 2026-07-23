import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Clock3, EyeOff, Gauge } from "lucide-react";

import type {
  ProviderMetadataFieldState,
  ProviderRateLimit,
  ThreadUsageSnapshot,
  UsageDisplayMode,
} from "@shared/contracts";

type UsageIndicatorProps = {
  usage: ThreadUsageSnapshot | null;
  rateLimits: ProviderRateLimit[];
  rateLimitState: ProviderMetadataFieldState;
  mode: UsageDisplayMode;
  providerLabel: string;
  onModeChange: (mode: UsageDisplayMode) => void;
};

const detailsId = "composer-usage-details";

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function displayPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

export function contextRemaining(usage: ThreadUsageSnapshot | null): number | null {
  if (
    usage?.usedTokens === null
    || usage?.usedTokens === undefined
    || !Number.isSafeInteger(usage.usedTokens)
    || usage.usedTokens < 0
    || !usage.maxTokens
    || !Number.isSafeInteger(usage.maxTokens)
    || usage.maxTokens <= 0
    || usage.usedTokens > usage.maxTokens
  ) return null;
  return displayPercent(100 - (usage.usedTokens / usage.maxTokens) * 100);
}

function hasReportedUsage(usage: ThreadUsageSnapshot | null, rateLimits: ProviderRateLimit[]): boolean {
  if (rateLimits.length > 0 || contextRemaining(usage) !== null) return true;
  return Boolean(
    usage
    && (
      (usage.maxTokens !== null && usage.maxTokens > 0)
      || (usage.totalProcessedTokens !== null && usage.totalProcessedTokens >= 0)
    )
  );
}

export function usageAutoCollapseReason(
  usage: ThreadUsageSnapshot | null,
  rateLimits: ProviderRateLimit[],
  spaceConstrained: boolean,
): "space" | "unavailable" | null {
  if (spaceConstrained) return "space";
  return hasReportedUsage(usage, rateLimits) ? null : "unavailable";
}

function resetLabel(value: string | null): string {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date)}`;
}

function updatedLabel(value: string | null): string {
  if (!value) return "Update time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Update time unavailable";
  return `Updated ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date)}`;
}

function quotaStateLabel(state: ProviderMetadataFieldState): string {
  if (state.refreshing && state.freshness === "stale") return "Refreshing · stale";
  if (state.refreshing) return "Refreshing";
  if (state.freshness === "fresh") return "Fresh";
  if (state.freshness === "stale" && state.provenance === "persistent-cache") return "Cached · stale";
  if (state.freshness === "stale") return "Stale";
  return "Unavailable";
}

function quotaStateDetail(state: ProviderMetadataFieldState): string {
  if (state.refreshing && state.freshness === "stale") return state.updatedAt
    ? `Refreshing; shown quota may be out of date · ${updatedLabel(state.updatedAt)}`
    : "Refreshing stale provider quota";
  if (state.refreshing) return state.updatedAt ? `Refreshing · ${updatedLabel(state.updatedAt)}` : "Requesting provider quota";
  if (state.freshness === "fresh") return `Provider quota · ${updatedLabel(state.updatedAt)}`;
  if (state.freshness === "stale" && state.provenance === "persistent-cache") return `Cached quota may be out of date · ${updatedLabel(state.updatedAt)}`;
  if (state.freshness === "stale") return `Provider quota may be out of date · ${updatedLabel(state.updatedAt)}`;
  return "Provider quota was not reported";
}

function processedScopeLabel(scope: ThreadUsageSnapshot["totalProcessedScope"]): string {
  return scope === "thread" ? "thread" : scope === "session" ? "session" : scope === "run" ? "run" : "provider report";
}

function quotaWindowLabel(limit: ProviderRateLimit): string {
  if (!limit.windowMinutes || limit.windowMinutes <= 0) return limit.label;
  if (limit.windowMinutes % (24 * 60) === 0) {
    const days = limit.windowMinutes / (24 * 60);
    return `${limit.label} · ${days} day${days === 1 ? "" : "s"}`;
  }
  if (limit.windowMinutes % 60 === 0) {
    const hours = limit.windowMinutes / 60;
    return `${limit.label} · ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${limit.label} · ${limit.windowMinutes} min`;
}

function UsageRing({ label, value, compact = false }: { label: string; value: number | null; compact?: boolean }): React.JSX.Element {
  const rounded = value === null ? null : Math.round(value);
  return (
    <div
      className={`usage-ring${compact ? " is-compact" : ""}${rounded === null ? " is-unavailable" : ""}`}
      role={rounded === null ? undefined : "progressbar"}
      aria-label={label}
      aria-valuemin={rounded === null ? undefined : 0}
      aria-valuemax={rounded === null ? undefined : 100}
      aria-valuenow={rounded ?? undefined}
      style={rounded === null ? undefined : { background: `conic-gradient(var(--accent) ${rounded}%, var(--surface-muted) 0)` }}
    >
      <span>{rounded === null ? "—" : `${rounded}%`}</span>
    </div>
  );
}

function contextDetail(usage: ThreadUsageSnapshot | null): string {
  if (!usage) return "No context report from this provider";
  const usedTokens = usage.usedTokens !== null
    && Number.isSafeInteger(usage.usedTokens)
    && usage.usedTokens >= 0
    && (usage.maxTokens === null || usage.usedTokens <= usage.maxTokens)
    ? usage.usedTokens
    : null;
  if (usedTokens === null) {
    return usage.maxTokens && Number.isSafeInteger(usage.maxTokens) && usage.maxTokens > 0
      ? `${compactNumber(usage.maxTokens)} window · current occupancy unavailable`
      : "Current context occupancy unavailable";
  }
  return `${compactNumber(usedTokens)} used${usage.maxTokens && usage.maxTokens > 0 ? ` of ${compactNumber(usage.maxTokens)}` : ""}`;
}

export function UsageIndicator({
  usage,
  rateLimits,
  rateLimitState,
  mode,
  providerLabel,
  onModeChange,
}: UsageIndicatorProps): React.JSX.Element | null {
  const [spaceConstrained, setSpaceConstrained] = useState(() => (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 1024px), (max-height: 760px)").matches
  ));
  const [expandedOverride, setExpandedOverride] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1024px), (max-height: 760px)");
    const update = (): void => setSpaceConstrained(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => setExpandedOverride(false), [providerLabel]);
  useEffect(() => {
    if (mode !== "expanded") setExpandedOverride(false);
  }, [mode]);
  if (mode === "hidden") return null;

  const remainingContext = contextRemaining(usage);
  const primaryLimit = rateLimits[0] ?? null;
  const primaryRemaining = primaryLimit ? displayPercent(primaryLimit.remainingPercent) : null;
  const autoCollapseReason = mode === "expanded"
    ? usageAutoCollapseReason(usage, rateLimits, spaceConstrained)
    : null;
  const effectiveMode = mode === "expanded" && autoCollapseReason && !expandedOverride ? "compact" : mode;
  const expand = (): void => {
    setExpandedOverride(true);
    if (mode !== "expanded") onModeChange("expanded");
  };
  const collapse = (): void => {
    setExpandedOverride(false);
    if (mode !== "compact") onModeChange("compact");
  };

  if (effectiveMode === "compact") {
    const allUnavailable = remainingContext === null && primaryRemaining === null;
    return (
      <section
        className="composer-usage usage-panel is-compact"
        aria-label="Usage and context"
        data-mode="compact"
        data-auto-collapsed={autoCollapseReason ? "true" : undefined}
        data-collapse-reason={autoCollapseReason ?? undefined}
      >
        <button
          type="button"
          className="usage-compact-main"
          aria-controls={detailsId}
          aria-expanded="false"
          aria-label="Expand usage and context"
          onClick={expand}
        >
          <UsageRing label="Context remaining" value={remainingContext} compact />
          <span id={detailsId} className="usage-compact-copy">
            <strong>{allUnavailable ? "Usage unavailable" : `Context ${remainingContext === null ? "unavailable" : `${Math.round(remainingContext)}% left`}`}</strong>
            <small>
              {primaryLimit
                ? `${primaryLimit.label} ${primaryRemaining === null ? "unavailable" : `${Math.round(primaryRemaining)}% left`}`
                : "Provider quota unavailable"}
              {rateLimits.length > 1 ? ` · +${rateLimits.length - 1} window${rateLimits.length === 2 ? "" : "s"}` : ""}
            </small>
          </span>
          {rateLimitState.freshness !== "unavailable" && (
            <span className={`usage-freshness is-${rateLimitState.freshness}`}>{quotaStateLabel(rateLimitState)}</span>
          )}
          <ChevronUp size={15} aria-hidden="true" />
        </button>
        <button type="button" className="usage-visibility-button" aria-label="Hide usage and context" onClick={() => onModeChange("hidden")}>
          <EyeOff size={14} />
        </button>
      </section>
    );
  }

  return (
    <section className="composer-usage usage-panel is-expanded" aria-label="Usage and context" data-mode="expanded">
      <header className="usage-panel-heading">
        <span className="usage-heading-icon"><Gauge size={17} /></span>
        <span className="usage-heading-copy">
          <strong>Usage &amp; context</strong>
          <small>{providerLabel} · {quotaStateDetail(rateLimitState)}</small>
        </span>
        <span className={`usage-freshness is-${rateLimitState.freshness}`}>{quotaStateLabel(rateLimitState)}</span>
        <button type="button" className="usage-header-button" aria-label="Hide usage and context" onClick={() => onModeChange("hidden")}>
          <EyeOff size={14} />
        </button>
        <button
          type="button"
          className="usage-header-button"
          aria-controls={detailsId}
          aria-expanded="true"
          aria-label="Collapse usage and context"
          onClick={collapse}
        >
          <ChevronDown size={15} />
        </button>
      </header>

      <div id={detailsId} className="usage-expanded-content">
        <div className="usage-context-card">
          <UsageRing label="Context remaining" value={remainingContext} />
          <span className="usage-context-copy">
            <small>Context remaining</small>
            <strong>{remainingContext === null ? "Unavailable" : `${Math.round(remainingContext)}% left`}</strong>
            <span>{contextDetail(usage)}</span>
            {usage && <span>{updatedLabel(usage.updatedAt)}</span>}
            {usage?.totalProcessedTokens !== null && usage?.totalProcessedTokens !== undefined && (
              <span>{compactNumber(usage.totalProcessedTokens)} processed in this {processedScopeLabel(usage.totalProcessedScope)}</span>
            )}
          </span>
        </div>

        <div className="usage-quota-card">
          <div className="usage-quota-heading">
            <span><strong>Provider quota</strong><small>{rateLimits.length === 0 ? "No windows reported" : `${rateLimits.length} window${rateLimits.length === 1 ? "" : "s"} reported`}</small></span>
          </div>
          <div className="usage-quota-list">
            {rateLimits.map((limit) => {
              const remaining = displayPercent(limit.remainingPercent);
              return (
                <div className="usage-quota-row" key={limit.id}>
                  <div><span>{quotaWindowLabel(limit)}</span><strong>{remaining === null ? "Unavailable" : `${Math.round(remaining)}% left`}</strong></div>
                  <div
                    className={`usage-meter-track${remaining === null ? " is-unavailable" : ""}`}
                    role={remaining === null ? undefined : "progressbar"}
                    aria-label={`${limit.label} remaining`}
                    aria-valuemin={remaining === null ? undefined : 0}
                    aria-valuemax={remaining === null ? undefined : 100}
                    aria-valuenow={remaining === null ? undefined : Math.round(remaining)}
                  >
                    {remaining !== null && <span style={{ width: `${remaining}%` }} />}
                  </div>
                  <small><Clock3 size={11} />{resetLabel(limit.resetsAt)}</small>
                </div>
              );
            })}
            {rateLimits.length === 0 && (
              <div className="usage-quota-unavailable">
                <strong>Unavailable</strong>
                <span>{rateLimitState.refreshing ? "Waiting for the provider to refresh its account limits." : "This provider did not return an account quota."}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

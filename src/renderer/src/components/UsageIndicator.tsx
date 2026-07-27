import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Clock3, EyeOff, X } from "lucide-react";

import type {
  ProviderMetadataFieldState,
  ProviderRateLimit,
  ThreadUsageSnapshot,
  UsageDisplayMode,
} from "@shared/contracts";
import {
  contextUsageDisplayValue,
  type ContextUsageDataQuality,
  type ContextUsageDisplayValue,
  usageDisplayBehavior,
} from "../utils/usageDisplay";
import { outsidePointerShouldRestoreFocus } from "../utils/dismissibleMenu";

type UsageIndicatorProps = {
  usage: ThreadUsageSnapshot | null;
  rateLimits: ProviderRateLimit[];
  rateLimitState: ProviderMetadataFieldState;
  /**
   * Native provider quota is only valid for that provider's selected route.
   * Custom/external routes must opt into isolation even when their harness has
   * native account limits in memory.
   */
  quotaSource: "selected-route" | "isolated";
  mode: UsageDisplayMode;
  providerLabel: string;
  contextQuality?: ContextUsageDataQuality;
  onModeChange: (mode: UsageDisplayMode) => void;
};

const processedScopes = new Set<NonNullable<ThreadUsageSnapshot["totalProcessedScope"]>>([
  "thread",
  "session",
  "run",
]);

export const CONTEXT_NEAR_LIMIT_REMAINING_PERCENT = 20;
export type ContextRingState = "current" | "stale" | "near-limit" | "unavailable";

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function displayPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

export function contextRemaining(usage: ThreadUsageSnapshot | null): number | null {
  return contextUsageDisplayValue(usage, usage ? "current" : "unavailable").remainingPercent;
}

function dateLabel(
  value: string | null,
  prefix: "Resets" | "Updated",
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return `${prefix} ${new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date)}`;
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
  const updated = dateLabel(state.updatedAt, "Updated");
  if (state.refreshing && state.freshness === "stale") {
    return updated ? `Refreshing; shown quota may be out of date · ${updated}` : "Refreshing stale provider quota";
  }
  if (state.refreshing) return updated ? `Refreshing · ${updated}` : "Requesting provider quota";
  if (state.freshness === "fresh") return updated ? `Provider quota · ${updated}` : "Provider quota";
  if (state.freshness === "stale" && state.provenance === "persistent-cache") {
    return updated ? `Cached quota may be out of date · ${updated}` : "Cached quota may be out of date";
  }
  if (state.freshness === "stale") {
    return updated ? `Provider quota may be out of date · ${updated}` : "Provider quota may be out of date";
  }
  return "Provider quota unavailable";
}

function processedUsage(
  usage: ThreadUsageSnapshot | null,
): { scope: NonNullable<ThreadUsageSnapshot["totalProcessedScope"]>; value: number } | null {
  const value = usage?.totalProcessedTokens;
  const scope = usage?.totalProcessedScope;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || !scope
    || !processedScopes.has(scope)
  ) return null;
  return { scope, value };
}

type UsageBreakdownRow = {
  id: string;
  label: string;
  value: number;
};

function usageBreakdownRows(
  usage: ThreadUsageSnapshot | null,
): UsageBreakdownRow[] {
  if (!usage) return [];
  const entries: Array<[string, string, number | null]> = [
    ["input", "Input", usage.inputTokens],
    ["cache-read", "Cache read", usage.cachedInputTokens],
    ["cache-write", "Cache write", usage.cacheWriteInputTokens],
    ["output", "Output", usage.outputTokens],
    ["reasoning", "Reasoning", usage.reasoningOutputTokens],
  ];
  return entries.flatMap(([id, label, value]) => (
    typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= 0
      ? [{ id, label, value }]
      : []
  ));
}

function quotaWindowLabel(limit: ProviderRateLimit): string {
  if (!Number.isSafeInteger(limit.windowMinutes) || !limit.windowMinutes || limit.windowMinutes <= 0) {
    return limit.label;
  }
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

function contextDetail(usage: ThreadUsageSnapshot | null): string | null {
  if (!usage) return null;
  const usedTokens = usage.usedTokens;
  const maxTokens = usage.maxTokens;
  const validUsed = typeof usedTokens === "number"
    && Number.isSafeInteger(usedTokens)
    && usedTokens >= 0
    && (maxTokens === null || usedTokens <= maxTokens);
  const validMax = typeof maxTokens === "number"
    && Number.isSafeInteger(maxTokens)
    && maxTokens > 0;
  if (validUsed) {
    return `${compactNumber(usedTokens)} used${validMax ? ` of ${compactNumber(maxTokens)}` : ""}`;
  }
  return validMax ? `${compactNumber(maxTokens)} window · occupancy unavailable` : null;
}

export function contextRingState(context: ContextUsageDisplayValue): ContextRingState {
  if (context.quality === "unavailable" || context.remainingPercent === null) return "unavailable";
  if (context.remainingPercent <= CONTEXT_NEAR_LIMIT_REMAINING_PERCENT) return "near-limit";
  return context.quality === "stale" ? "stale" : "current";
}

export function contextTriggerSummary(
  context: ContextUsageDisplayValue,
  quotaRefreshing: boolean,
): string {
  if (context.quality === "unavailable" || context.remainingPercent === null) {
    return `Context window unavailable.${quotaRefreshing ? " Provider quota refreshing." : ""}`;
  }
  const qualifiers = [
    context.quality === "stale" ? "stale" : null,
    context.remainingPercent <= CONTEXT_NEAR_LIMIT_REMAINING_PERCENT ? "near limit" : null,
  ].filter((value): value is string => value !== null);
  return `Context window ${context.remainingPercent}% remaining${qualifiers.length > 0 ? `, ${qualifiers.join(" and ")}` : ""}.${quotaRefreshing ? " Provider quota refreshing." : ""}`;
}

function ContextRing({
  context,
  quotaRefreshing,
}: {
  context: ContextUsageDisplayValue;
  quotaRefreshing: boolean;
}): React.JSX.Element {
  const state = contextRingState(context);
  const value = context.remainingPercent;
  return (
    <span
      className={`usage-context-ring is-${state}${context.quality === "stale" ? " has-stale-value" : ""}`}
      data-context-ring-state={state}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" focusable="false">
        <circle className="usage-context-ring-track" cx="12" cy="12" r="9.5" pathLength="100" />
        {value !== null && (
          <circle
            className="usage-context-ring-value"
            cx="12"
            cy="12"
            r="9.5"
            pathLength="100"
            strokeDasharray={`${value} ${100 - value}`}
          />
        )}
      </svg>
      <span className="usage-context-ring-label">{value === null ? "—" : value}</span>
      {quotaRefreshing && <span className="usage-quota-refresh-indicator" />}
    </span>
  );
}

export function UsageIndicator({
  usage,
  rateLimits,
  rateLimitState,
  quotaSource,
  mode,
  providerLabel,
  contextQuality = usage ? "current" : "unavailable",
  onModeChange,
}: UsageIndicatorProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replaceAll(":", "");
  const detailsId = `${reactId}-usage-details`;
  const titleId = `${reactId}-usage-title`;
  const identityId = `${reactId}-usage-identity`;

  const context = contextUsageDisplayValue(usage, contextQuality);
  const behavior = usageDisplayBehavior(mode);
  const processed = processedUsage(usage);
  const breakdown = usageBreakdownRows(usage);
  const detail = contextDetail(usage);
  const contextUpdated = dateLabel(usage?.updatedAt ?? null, "Updated");
  const scopedRateLimits = quotaSource === "selected-route" ? rateLimits : [];
  const scopedRateLimitState: ProviderMetadataFieldState = quotaSource === "selected-route"
    ? rateLimitState
    : {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      };

  const closePopover = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus && typeof window !== "undefined") {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [mode, providerLabel, quotaSource]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !anchorRef.current?.contains(target)) {
        closePopover(outsidePointerShouldRestoreFocus(target));
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePopover(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closePopover, open]);

  if (behavior.surface === "hidden") return null;

  const hasQuota = scopedRateLimits.length > 0;
  const quotaRefreshing = scopedRateLimitState.refreshing;
  const triggerSummary = contextTriggerSummary(context, quotaRefreshing);
  const triggerLabel = `${open ? "Close" : "Open"} usage and context. ${triggerSummary}`;
  const ringState = contextRingState(context);

  return (
    <section
      className="composer-usage usage-disclosure"
      aria-label="Usage and context"
      data-mode={mode}
      data-context-quality={context.quality}
      data-context-state={ringState}
      data-quota-refreshing={quotaRefreshing ? "true" : undefined}
      data-quota-source={quotaSource}
      data-composer-control="usage"
    >
      <div ref={anchorRef} className="usage-popover-anchor">
        <button
          ref={triggerRef}
          type="button"
          className={`usage-popover-trigger${open ? " is-open" : ""}`}
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          aria-controls={detailsId}
          aria-expanded={open}
          title={triggerSummary}
          onClick={() => setOpen((current) => !current)}
        >
          <ContextRing context={context} quotaRefreshing={quotaRefreshing} />
          {behavior.showAdjacentValue && (
            <span className="usage-trigger-value" aria-hidden="true">{context.valueLabel}</span>
          )}
        </button>

        <div
          id={detailsId}
          className="usage-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={identityId}
          hidden={!open}
        >
          <header className="usage-popover-heading">
            <span>
              <strong id={titleId}>Usage &amp; context</strong>
              <small id={identityId} title={providerLabel}>{providerLabel}</small>
            </span>
            <button
              type="button"
              className="usage-popover-close"
              aria-label="Close usage and context"
              onClick={() => closePopover(true)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>

          <div className="usage-popover-content">
            <section className="usage-popover-section" aria-labelledby={`${reactId}-context-heading`}>
              <div className="usage-popover-section-heading">
                <strong id={`${reactId}-context-heading`}>Context</strong>
                <span className={`usage-quality is-${context.quality}`}>{context.quality}</span>
              </div>
              <div className="usage-popover-value">
                <strong>{context.valueLabel}</strong>
                {detail && <span>{detail}</span>}
                {usage?.compactsAutomatically !== null
                  && usage?.compactsAutomatically !== undefined
                  && (
                    <small>
                      Automatic compaction {usage.compactsAutomatically ? "enabled" : "disabled"}
                    </small>
                  )}
                {contextUpdated && <small>{contextUpdated}</small>}
              </div>
            </section>

            {breakdown.length > 0 && (
              <section className="usage-popover-section" aria-labelledby={`${reactId}-breakdown-heading`}>
                <div className="usage-popover-section-heading">
                  <strong id={`${reactId}-breakdown-heading`}>Latest token breakdown</strong>
                </div>
                <dl className="usage-popover-breakdown">
                  {breakdown.map((row) => (
                    <div key={row.id}>
                      <dt>{row.label}</dt>
                      <dd>{compactNumber(row.value)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="usage-popover-quality-detail">
                  Provider-reported values; cache counts are a breakdown of input where applicable.
                </p>
              </section>
            )}

            {processed && (
              <section className="usage-popover-section" aria-labelledby={`${reactId}-processed-heading`}>
                <div className="usage-popover-section-heading">
                  <strong id={`${reactId}-processed-heading`}>Processed in this {processed.scope}</strong>
                </div>
                <div className="usage-popover-value">
                  <strong>{compactNumber(processed.value)}</strong>
                  <span>Provider-reported {processed.scope} total</span>
                </div>
              </section>
            )}

            <section className="usage-popover-section" aria-labelledby={`${reactId}-quota-heading`}>
              <div className="usage-popover-section-heading">
                <strong id={`${reactId}-quota-heading`}>Provider quota</strong>
                <span className={`usage-quality is-${scopedRateLimitState.freshness}`}>
                  {quotaStateLabel(scopedRateLimitState)}
                </span>
              </div>
              {hasQuota ? (
                <div className="usage-popover-quota-list">
                  {scopedRateLimits.map((limit) => {
                    const remaining = displayPercent(limit.remainingPercent);
                    const reset = dateLabel(limit.resetsAt, "Resets");
                    return (
                      <div className="usage-popover-quota" key={limit.id}>
                        <span><strong>{quotaWindowLabel(limit)}</strong><b>{remaining === null ? "Unavailable" : `${Math.round(remaining)}% left`}</b></span>
                        {remaining !== null && (
                          <span
                            className="usage-popover-meter"
                            role="progressbar"
                            aria-label={`${limit.label} remaining`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(remaining)}
                          >
                            <span style={{ width: `${remaining}%` }} />
                          </span>
                        )}
                        {reset && <small><Clock3 size={11} aria-hidden="true" />{reset}</small>}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="usage-popover-unavailable">
                  {quotaSource === "isolated"
                    ? "Quota is unavailable for this selected custom route."
                    : quotaStateDetail(scopedRateLimitState)}
                </p>
              )}
              {hasQuota && (
                <p className="usage-popover-quality-detail">{quotaStateDetail(scopedRateLimitState)}</p>
              )}
            </section>
          </div>

          <footer className="usage-popover-footer">
            <button
              type="button"
              className="usage-hide-button"
              onClick={() => onModeChange("hidden")}
            >
              <EyeOff size={13} aria-hidden="true" />
              Hide usage
            </button>
          </footer>
        </div>
      </div>
    </section>
  );
}

import { CircleAlert, Info } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ServerEvent,
  UsageDashboard,
  UsageDashboardBreakdown,
  UsageMeasuredValue,
  UsageRangeDays,
} from "@shared/contracts";

import type { ConnectionStatus } from "../../hooks/useInertiaConnection";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { resultEvent } from "../../lib/runtimeCommands";
import {
  formatCompact,
  formatCount,
  formatDuration,
  formatShare,
  formatUsd,
} from "../../lib/usageFormat";
import { ProviderMark } from "../ProviderMark";
import { TooltipButton } from "../TooltipButton";
import { LoadingMark } from "../ui";
import { UsageOverviewBreakdown } from "./UsageOverviewBreakdown";
import { UsageOverviewChart } from "./UsageOverviewChart";
import {
  costGapLabel,
  costTypeSegments,
  coverageNote,
  partialEstimateNote,
  pricingNote,
  requestsLabel,
  shareOf,
  sortByMetric,
  tokenTotalsUnavailable,
  tokenTypeSegments,
  usageDashboardCommand,
  visibleUsage,
  type UsageOverviewData,
  type UsageOverviewMetric,
  type UsageTypeSegment,
} from "./UsageOverviewModel";
import "./UsageOverview.css";

export { usageDashboardCommand } from "./UsageOverviewModel";
export type { UsageOverviewMetric } from "./UsageOverviewModel";

export interface UsageOverviewProps {
  metric: UsageOverviewMetric;
  days: UsageRangeDays;
  hiddenProviderIds: ReadonlySet<string>;
  refreshToken: number;
  status: ConnectionStatus;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onBusyChange?(busy: boolean): void;
}

const OFFLINE_MESSAGE = "Usage is unavailable while the local service is offline.";
const COST_FALLBACK_REASON = "The model price list could not be loaded.";

function useUsageDashboard(
  days: UsageRangeDays,
  refreshToken: number,
  status: ConnectionStatus,
  request: UsageOverviewProps["request"],
): {
  dashboard: UsageDashboard | null;
  loading: boolean;
  error: string | null;
  retry(): void;
} {
  const [dashboard, setDashboard] = useState<UsageDashboard | null>(null);
  const [loading, setLoading] = useState(status !== "offline");
  const [error, setError] = useState<string | null>(
    status === "offline" ? OFFLINE_MESSAGE : null,
  );
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (status !== "online") {
      setLoading(status === "connecting");
      setError(status === "offline" ? OFFLINE_MESSAGE : null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    void request(usageDashboardCommand(days)).then((event) => {
      if (!current) return;
      const result = resultEvent(event).result;
      if (result.kind !== "usage.dashboard") {
        throw new Error("The local service returned an unexpected usage response.");
      }
      setDashboard(result.dashboard);
    }).catch((cause: unknown) => {
      if (!current) return;
      setDashboard((previous) => previous?.range.days === days ? previous : null);
      setError(cause instanceof Error ? cause.message : "Usage could not be loaded.");
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [days, refreshToken, retryVersion, request, status]);

  return {
    dashboard,
    loading,
    error,
    retry: () => setRetryVersion((version) => version + 1),
  };
}

function Figure({
  value,
  format,
  empty = "Unavailable",
}: {
  value: UsageMeasuredValue;
  format(value: number): string;
  empty?: string;
}): React.JSX.Element {
  return value.value === null
    ? <span className="usage-overview-unavailable">{empty}</span>
    : <>{format(value.value)}</>;
}

function Total({
  label,
  value,
  detail,
  hero = false,
}: {
  label: string;
  value: React.ReactNode;
  detail?: string | null;
  hero?: boolean;
}): React.JSX.Element {
  return (
    <article className={hero ? "usage-overview-total is-hero" : "usage-overview-total"}>
      <span>{label}</span>
      <strong className="usage-overview-figure">{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

function details(...parts: (string | null | false)[]): string | null {
  const text = parts.filter(Boolean).join(" · ");
  return text === "" ? null : text;
}

function providerDetail(
  provider: UsageDashboardBreakdown,
  data: UsageOverviewData,
  metric: UsageOverviewMetric,
  showCost: boolean,
): string {
  const tokens = provider.processedTokens;
  const cost = provider.cost;
  const gap = costGapLabel(
    data.models.filter(({ providerId }) => providerId === provider.providerId),
  );
  if (metric === "cost") {
    const tokenCopy = tokens.value === null
      ? "tokens unavailable"
      : `${formatCompact(tokens.value)} tokens`;
    if (cost.value === null) return `${gap} · ${tokenCopy}`;
    const share = shareOf(cost, data.cost);
    if (share === null) return `Share unavailable · ${tokenCopy}`;
    return `${cost.coverage === "partial" ? "Partial · " : ""}${formatShare(share)} of cost · ${tokenCopy}`;
  }
  const costCopy = !showCost
    ? null
    : cost.value === null ? gap.toLowerCase() : formatUsd(cost.value);
  if (tokens.value === null) return details("Token total unavailable", costCopy)!;
  const share = shareOf(tokens, data.processedTokens);
  if (share === null) {
    return `${formatCompact(tokens.value)} measured tokens · share unavailable`;
  }
  return details(
    `${tokens.coverage === "partial" ? "Partial · " : ""}${formatShare(share)} of tokens`,
    costCopy,
  )!;
}

function ShareBar({
  title,
  aside,
  segments,
  format,
}: {
  title: string;
  aside: string | null;
  segments: readonly UsageTypeSegment[];
  format(value: number): string;
}): React.JSX.Element | null {
  const visible = segments.filter(({ value }) => value > 0);
  const total = visible.reduce((sum, { value }) => sum + value, 0);
  if (total <= 0) return null;
  return (
    <section className="usage-overview-share" aria-label={title}>
      <div className="usage-overview-share-heading">
        <h2>{title}</h2>
        {aside && <small>{aside}</small>}
      </div>
      <div className="usage-overview-share-bar usage-overview-figure" aria-hidden="true">
        {visible.map((segment) => (
          <i data-kind={segment.kind} style={{ flexGrow: segment.value }} key={segment.kind} />
        ))}
      </div>
      <ul className="usage-overview-share-legend usage-overview-figure">
        {visible.map((segment) => (
          <li key={segment.kind}>
            <i data-kind={segment.kind} aria-hidden="true" />
            <span>{segment.label}</span>
            <b>{format(segment.value)}</b>
            <small>{formatShare(segment.value / total)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UsageOverviewContent({
  dashboard,
  metric,
  hiddenProviderIds,
}: {
  dashboard: UsageDashboard;
  metric: UsageOverviewMetric;
  hiddenProviderIds: ReadonlySet<string>;
}): React.JSX.Element {
  const data = useMemo(
    () => visibleUsage(dashboard, hiddenProviderIds),
    [dashboard, hiddenProviderIds],
  );
  const showCost = dashboard.cost.status === "estimated";
  const activeMetric: UsageOverviewMetric = showCost ? metric : "tokens";
  const providers = sortByMetric(data.providers, activeMetric);
  const scope = data.filtered ? "All providers" : null;

  if (dashboard.totals.requestCount === 0) {
    return (
      <section className="usage-overview-empty">
        <h2>No terminal requests in this range</h2>
        <p>Usage will appear after Inertia records a completed, failed, cancelled, or interrupted terminal agent turn.</p>
      </section>
    );
  }
  if (data.requestCount === 0) {
    return (
      <section className="usage-overview-empty">
        <h2>No usage for the selected providers</h2>
        <p>
          {data.hiddenProviderCount === 1
            ? "The one provider with usage in this range is hidden by the provider filter."
            : `All ${formatCount(data.hiddenProviderCount)} providers with usage in this range are hidden by the provider filter.`}
        </p>
      </section>
    );
  }

  const partialNote = partialEstimateNote(data.cost);
  const processedAverage = data.activeDays === 0
    ? 0
    : (data.processedTokens.value ?? 0) / data.activeDays;
  const statusCopy = data.statusCounts === null ? null : details(
    data.statusCounts.completed > 0 && `${formatCount(data.statusCounts.completed)} completed`,
    data.statusCounts.failed > 0 && `${formatCount(data.statusCounts.failed)} failed`,
    data.statusCounts.cancelled > 0 && `${formatCount(data.statusCounts.cancelled)} cancelled`,
    data.statusCounts.interrupted > 0 && `${formatCount(data.statusCounts.interrupted)} interrupted`,
  );
  const requestsDetail = details(
    data.runtime.value === null
      ? "Runtime unavailable"
      : `${formatDuration(data.runtime.value)} active runtime`,
    statusCopy,
  );
  const { tokens } = dashboard;

  return (
    <>
      {metric === "cost" && !showCost && (
        <div className="usage-overview-notice" role="note">
          <CircleAlert size={16} aria-hidden="true" />
          <span>
            <strong>Cost can't be estimated right now</strong>
            <small>{dashboard.cost.reason ?? COST_FALLBACK_REASON} Showing measured tokens instead.</small>
          </span>
        </div>
      )}

      <section className="usage-overview-summary" aria-label="Usage summary and daily trend">
        <div className="usage-overview-lead">
          <div className="usage-overview-headline">
            <strong className="usage-overview-figure">
              {activeMetric === "cost"
                ? <Figure value={data.cost} format={formatUsd} empty={costGapLabel(data.models)} />
                : <Figure value={data.processedTokens} format={formatCompact} />}
            </strong>
            {activeMetric === "cost" ? (
              <p>
                <span>{requestsLabel(data.requestCount)}</span>
                {data.cost.value === null ? (
                  <span>no request in this range could be priced</span>
                ) : (
                  <span>API estimate</span>
                )}
                {partialNote !== null && (
                  <>
                    <span className="is-partial">
                      priced {formatCount(data.cost.measuredRequests)} of {formatCount(data.cost.totalRequests)}
                    </span>
                    <TooltipButton
                      className="usage-overview-info"
                      aria-label="About this estimate"
                      tooltip={partialNote}
                    >
                      <Info size={14} aria-hidden="true" />
                    </TooltipButton>
                  </>
                )}
              </p>
            ) : (
              <p>
                {data.processedTokens.coverage === "complete" && (
                  <><span>Processed tokens</span><span>{requestsLabel(data.requestCount)}</span></>
                )}
                {data.processedTokens.coverage === "partial" && (
                  <>
                    <span>Processed tokens</span>
                    <span className="is-partial">
                      measured for {formatCount(data.processedTokens.measuredRequests)} of {formatCount(data.requestCount)} requests
                    </span>
                  </>
                )}
                {data.processedTokens.coverage === "unavailable" && (
                  <span>Processed tokens unavailable across {requestsLabel(data.requestCount)}</span>
                )}
              </p>
            )}
          </div>

          <div
            className="usage-overview-providers"
            role="group"
            aria-label={activeMetric === "cost" ? "Estimated cost by provider" : "Measured tokens by provider"}
          >
            {providers.map((provider) => (
              <article data-provider={provider.providerId} key={provider.key}>
                <div>
                  <span>
                    <i className="usage-overview-dot" aria-hidden="true" />
                    <ProviderMark providerId={provider.providerId} />
                    <span>{provider.providerLabel}</span>
                    <small>{requestsLabel(provider.requestCount)}</small>
                  </span>
                  <strong className="usage-overview-figure">
                    {activeMetric === "cost"
                      ? <Figure value={provider.cost} format={formatUsd} empty="—" />
                      : <Figure value={provider.processedTokens} format={formatCompact} empty="—" />}
                  </strong>
                </div>
                <small>{providerDetail(provider, data, activeMetric, showCost)}</small>
              </article>
            ))}
          </div>
        </div>

        <div className="usage-overview-trend">
          <h2>{activeMetric === "cost" ? "Daily cost" : "Daily processed tokens"}</h2>
          <div className="usage-overview-figure">
            <UsageOverviewChart metric={activeMetric} daily={data.daily} providers={providers} />
          </div>
        </div>
      </section>

      <section className="usage-overview-totals" aria-label="Usage totals">
        <h2>Totals</h2>
        {tokenTotalsUnavailable(dashboard, data) ? (
          <div className="usage-overview-totals-grid is-requests-only">
            <Total hero label="Requests" value={formatCount(data.requestCount)} detail={requestsDetail} />
            <p className="usage-overview-totals-note">Token totals aren't reported by these providers yet.</p>
          </div>
        ) : (
          <div className="usage-overview-totals-grid">
            <Total
              label="Processed tokens"
              value={<Figure value={data.processedTokens} format={formatCompact} />}
              detail={coverageNote(data.processedTokens)
                ?? (data.processedTokens.value === null ? null : `${formatCompact(processedAverage)} per active day`)}
            />
            <Total
              label="Reported input"
              value={<Figure value={tokens.input} format={formatCompact} />}
              detail={details(scope, coverageNote(tokens.input))}
            />
            <Total
              label="Cached input"
              value={<Figure value={tokens.cachedInput} format={formatCompact} />}
              detail={details(
                scope,
                coverageNote(tokens.cachedInput),
                tokens.cacheWriteInput.value !== null
                  && `${formatCompact(tokens.cacheWriteInput.value)} reported cache writes`,
              )}
            />
            <Total
              label="Output"
              value={<Figure value={tokens.output} format={formatCompact} />}
              detail={details(
                scope,
                coverageNote(tokens.output),
                tokens.reasoningOutput.value !== null
                  && `includes ${formatCompact(tokens.reasoningOutput.value)} reasoning`,
              )}
            />
            {showCost && (
              <Total
                label="Cache savings"
                value={formatUsd(dashboard.cost.cacheSavings)}
                detail={details(scope, "API estimate")}
              />
            )}
            <Total label="Requests" value={formatCount(data.requestCount)} detail={requestsDetail} />
          </div>
        )}
      </section>

      {activeMetric === "cost" ? (
        <ShareBar
          title="Cost by type"
          aside={details(scope, "API estimate")}
          segments={costTypeSegments(dashboard)}
          format={formatUsd}
        />
      ) : (
        <ShareBar
          title="Tokens by type"
          aside={scope}
          segments={tokenTypeSegments(dashboard)}
          format={formatCompact}
        />
      )}

      <UsageOverviewBreakdown data={data} metric={activeMetric} showCost={showCost} />

      <footer className="usage-overview-notes">
        <p>
          <strong>Measured locally.</strong> Authoritative terminal turns only. Processed totals and token categories use harness-vetted turn values or proven resumed-session deltas; message-only, context-only, and missing fields remain unavailable. No prompts, files, credentials, or new telemetry. Reported input includes cached and cache-write tokens.
        </p>
        {showCost ? (
          <p>
            <strong>API estimate, not a bill.</strong> Tokens are priced at public API list prices, so the figure is what the same usage would cost through the API, not what a subscription charges. {partialNote === null ? "" : `${partialNote} `}{pricingNote(dashboard)}
          </p>
        ) : (
          <p>
            <strong>Cost unavailable.</strong> {dashboard.cost.reason ?? COST_FALLBACK_REASON} {pricingNote(dashboard)}
          </p>
        )}
      </footer>
    </>
  );
}

function UsageOverviewSkeleton(): React.JSX.Element {
  return (
    <div className="usage-overview-skeleton">
      <LoadingMark label="Loading usage" />
      <span className="visually-hidden">Aggregating local turn records…</span>
      <div className="usage-overview-summary" aria-hidden="true">
        <div className="usage-overview-lead">
          <span className="usage-overview-bone is-headline" />
          <span className="usage-overview-bone is-subline" />
          {[0, 1, 2].map((index) => (
            <span className="usage-overview-skeleton-provider" key={index}>
              <i /><b /><em />
            </span>
          ))}
        </div>
        <div className="usage-overview-skeleton-chart">
          <span className="usage-overview-bone is-title" />
          <span className="usage-overview-bone is-chart" />
        </div>
      </div>
      <div className="usage-overview-totals-grid" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <span className="usage-overview-skeleton-total" key={index}><i /><b /></span>
        ))}
      </div>
      <span className="usage-overview-bone is-table" aria-hidden="true" />
    </div>
  );
}

export function UsageOverview({
  metric,
  days,
  hiddenProviderIds,
  refreshToken,
  status,
  request,
  onBusyChange,
}: UsageOverviewProps): React.JSX.Element {
  const { dashboard, loading, error, retry } = useUsageDashboard(
    days,
    refreshToken,
    status,
    request,
  );
  const busyListener = useRef(onBusyChange);

  useEffect(() => {
    busyListener.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    onBusyChange?.(loading);
  }, [loading, onBusyChange]);
  useEffect(() => () => {
    busyListener.current?.(false);
  }, []);

  const offline = status === "offline";
  const content = offline ? null : dashboard;

  return (
    <section
      className="usage-overview"
      data-metric={metric}
      data-refreshing={loading && content !== null ? "true" : undefined}
      aria-label={metric === "cost" ? "Cost" : "Tokens"}
      aria-busy={loading}
    >
      {error !== null && (
        <div className="usage-overview-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span><strong>Usage could not be loaded</strong><small>{error}</small></span>
          <button type="button" className="secondary-button" onClick={retry} disabled={status !== "online"}>Try again</button>
        </div>
      )}
      {content === null && loading && <UsageOverviewSkeleton />}
      {content !== null && (
        <UsageOverviewContent
          dashboard={content}
          metric={metric}
          hiddenProviderIds={hiddenProviderIds}
        />
      )}
    </section>
  );
}

import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ServerEvent,
  UsageCoverage,
  UsageDashboard,
  UsageDashboardBreakdown,
  UsageMeasuredValue,
  UsageRangeDays,
} from "@shared/contracts";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import { ProviderMark } from "./ProviderMark";
import { LoadingMark } from "./ui";
import "./UsageView.css";

type UsageDashboardCommand = Extract<
  CommandWithoutId,
  { type: "usage.dashboard.get" }
>;
type TrendMetric = "requests" | "tokens";

export interface UsageViewProps {
  status: ConnectionStatus;
  request(command: CommandWithoutId): Promise<ServerEvent>;
}

function localDateKey(date: Date): string {
  const part = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

export function usageDashboardCommand(
  days: UsageRangeDays,
  now = new Date(),
): UsageDashboardCommand {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days + 1,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return {
    type: "usage.dashboard.get",
    payload: {
      days,
      fromInclusive: start.toISOString(),
      toExclusive: end.toISOString(),
      endDate: localDateKey(now),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  };
}

const countFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 0,
});
const averageFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
});
const compactFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const percentFormatter = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 1,
});
const shortDateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const fullDateFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

function displayDate(value: string, includeYear = false): string {
  return (includeYear ? fullDateFormatter : shortDateFormatter)
    .format(new Date(`${value}T12:00:00Z`));
}

function coverageCopy(metric: UsageMeasuredValue): string {
  if (metric.totalRequests === 0) return "No requests in range";
  if (metric.coverage === "complete") {
    return `Measured for all ${formatCount(metric.totalRequests)} requests`;
  }
  if (metric.coverage === "partial") {
    return `Measured for ${formatCount(metric.measuredRequests)} of ${formatCount(metric.totalRequests)} requests`;
  }
  return "Not reported by these runs";
}

function CoverageState({ coverage }: { coverage: UsageCoverage }): React.JSX.Element {
  return (
    <span className={`usage-coverage is-${coverage}`}>
      {coverage === "complete" ? "Measured" : coverage === "partial" ? "Partial" : "Unavailable"}
    </span>
  );
}

function measuredShare(metric: UsageMeasuredValue): number {
  return metric.totalRequests === 0
    ? 0
    : metric.measuredRequests / metric.totalRequests;
}

function MetricValue({
  metric,
  format,
}: {
  metric: UsageMeasuredValue;
  format(value: number): string;
}): React.JSX.Element {
  return metric.value === null
    ? <span className="usage-metric-unavailable">Unavailable</span>
    : <>{format(metric.value)}</>;
}

function trendValue(
  day: UsageDashboard["daily"][number],
  metric: TrendMetric,
): number | null {
  return metric === "requests" ? day.requestCount : day.processedTokens.value;
}

function DailyTrend({
  dashboard,
  metric,
}: {
  dashboard: UsageDashboard;
  metric: TrendMetric;
}): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const width = 900;
  const height = 300;
  const padding = { top: 28, right: 22, bottom: 38, left: 50 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = dashboard.daily.map((day) => trendValue(day, metric));
  const known = values.filter((value): value is number => value !== null);
  const peakValue = Math.max(0, ...known);
  const maximum = Math.max(1, peakValue);
  const peakIndex = Math.max(0, values.findIndex((value) => value === peakValue));
  const average = known.length === 0
    ? 0
    : known.reduce((sum, value) => sum + value, 0) / known.length;
  const x = (index: number): number => padding.left
    + (dashboard.daily.length === 1
      ? 0
      : index / (dashboard.daily.length - 1) * plotWidth);
  const y = (value: number): number => padding.top
    + plotHeight - value / maximum * plotHeight;
  const baseline = padding.top + plotHeight;
  const barWidth = Math.max(
    2.5,
    Math.min(12, plotWidth / dashboard.daily.length * 0.48),
  );
  let path = "";
  let previousKnown = false;
  values.forEach((value, index) => {
    if (value === null) {
      previousKnown = false;
      return;
    }
    path += `${previousKnown ? " L" : " M"} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
    previousKnown = true;
  });
  const labelIndexes = [...new Set([
    0,
    Math.floor((dashboard.daily.length - 1) / 2),
    dashboard.daily.length - 1,
  ])];
  const metricLabel = metric === "requests" ? "requests" : "measured tokens";
  const description = metric === "requests"
    ? "Bars show the number of terminal requests completed on each day."
    : "Points show measured processed-token totals. Missing points mean no defensible total was available for that day.";
  const formattedPeak = metric === "requests"
    ? formatCount(peakValue)
    : formatCompact(peakValue);
  const formattedAverage = metric === "requests"
    ? averageFormatter.format(average)
    : formatCompact(average);

  return (
    <figure className="usage-trend-figure">
      <figcaption className="visually-hidden" id={titleId}>Daily {metricLabel}</figcaption>
      <p className="visually-hidden" id={descriptionId}>{description}</p>
      <div className="usage-chart-readings" aria-hidden="true">
        <span>
          <small>Peak</small>
          <strong>{formattedPeak}</strong>
          <em>{displayDate(dashboard.daily[peakIndex]!.date)}</em>
        </span>
        <span>
          <small>{metric === "requests" ? "Daily average" : "Known-day average"}</small>
          <strong>{formattedAverage}</strong>
          <em>{metric === "requests" ? `${dashboard.range.days}-day range` : `${known.length} known ${known.length === 1 ? "day" : "days"}`}</em>
        </span>
      </div>
      <svg
        className="usage-trend-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const gridY = padding.top + plotHeight * ratio;
          return (
            <line
              className={`usage-chart-grid${ratio === 1 ? " is-baseline" : ""}`}
              x1={padding.left}
              x2={width - padding.right}
              y1={gridY}
              y2={gridY}
              key={ratio}
            />
          );
        })}
        <text className="usage-chart-label" x={padding.left - 10} y={padding.top + 4} textAnchor="end">
          {formatCompact(maximum)}
        </text>
        <text className="usage-chart-label" x={padding.left - 10} y={padding.top + plotHeight + 4} textAnchor="end">0</text>
        {metric === "requests" && values.map((value, index) => value === null ? null : (
          <rect
            className={`usage-chart-bar${value === peakValue ? " is-peak" : ""}${value === 0 ? " is-zero" : ""}`}
            x={x(index) - barWidth / 2}
            y={value === 0 ? baseline - 1 : y(value)}
            width={barWidth}
            height={Math.max(1, baseline - y(value))}
            key={dashboard.daily[index]!.date}
          >
            <title>
              {displayDate(dashboard.daily[index]!.date, true)}: {formatCount(value)} {value === 1 ? "request" : "requests"}
            </title>
          </rect>
        ))}
        {metric === "tokens" && path && <path className="usage-chart-line" d={path} />}
        {metric === "tokens" && values.map((value, index) => value === null ? null : (
          <g key={dashboard.daily[index]!.date}>
            <line
              className="usage-chart-stem"
              x1={x(index)}
              x2={x(index)}
              y1={y(value)}
              y2={baseline}
            />
            <circle
              className={`usage-chart-point${dashboard.daily[index]!.processedTokens.coverage === "partial" ? " is-partial" : ""}`}
              cx={x(index)}
              cy={y(value)}
              r="4"
            >
              <title>
                {displayDate(dashboard.daily[index]!.date, true)}: {formatCompact(value)} measured tokens
              </title>
            </circle>
          </g>
        ))}
        {labelIndexes.map((index) => (
          <text
            className="usage-chart-label"
            x={x(index)}
            y={height - 8}
            textAnchor={index === 0 ? "start" : index === dashboard.daily.length - 1 ? "end" : "middle"}
            key={dashboard.daily[index]!.date}
          >
            {displayDate(dashboard.daily[index]!.date)}
          </text>
        ))}
      </svg>
      <table className="visually-hidden">
        <caption>Daily {metricLabel}</caption>
        <thead><tr><th>Date</th><th>Value</th><th>Coverage</th></tr></thead>
        <tbody>
          {dashboard.daily.map((day) => {
            const value = trendValue(day, metric);
            return (
              <tr key={day.date}>
                <th>{day.date}</th>
                <td>{value === null ? "Unavailable" : value}</td>
                <td>{metric === "requests" ? "Complete" : day.processedTokens.coverage}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}

function requestShare(
  item: UsageDashboardBreakdown,
  totalRequests: number,
): number {
  return totalRequests === 0 ? 0 : item.requestCount / totalRequests;
}

function CoverageMeter({
  metric,
}: {
  metric: UsageMeasuredValue;
}): React.JSX.Element {
  return (
    <span className={`usage-coverage-meter is-${metric.coverage}`} aria-hidden="true">
      <span style={{ width: `${measuredShare(metric) * 100}%` }} />
    </span>
  );
}

function UsageDashboardContent({
  dashboard,
}: {
  dashboard: UsageDashboard;
}): React.JSX.Element {
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("requests");
  const rangeCopy = `${displayDate(dashboard.range.startDate, true)} – ${displayDate(dashboard.range.endDate, true)}`;
  const tokenFields = [
    ["Input", dashboard.tokens.input],
    ["Cached input", dashboard.tokens.cachedInput],
    ["Cache writes", dashboard.tokens.cacheWriteInput],
    ["Output", dashboard.tokens.output],
    ["Reasoning output", dashboard.tokens.reasoningOutput],
  ] as const;
  const providerShareCopy = dashboard.providers
    .map((provider) => `${provider.providerLabel} ${percentFormatter.format(requestShare(provider, dashboard.totals.requestCount))}`)
    .join(", ");

  return (
    <>
      <div className="usage-range-summary">
        <CalendarDays size={14} aria-hidden="true" />
        <span>{rangeCopy}</span>
        <span aria-hidden="true">·</span>
        <span>{dashboard.totals.activeDays} active {dashboard.totals.activeDays === 1 ? "day" : "days"}</span>
      </div>

      {dashboard.totals.requestCount > 0 && dashboard.totals.processedTokens.coverage !== "complete" && (
        <div className="usage-accuracy-note" role="note">
          <AlertCircle size={16} aria-hidden="true" />
          <span>
            <strong>Token totals are {dashboard.totals.processedTokens.coverage === "partial" ? "partial" : "unavailable"}.</strong>
            Only direct run totals and proven resumed-session deltas with matching scope and execution identity are counted; missing provider fields remain missing.
          </span>
        </div>
      )}

      <section className="usage-headline-grid" aria-label="Usage totals">
        <article className="usage-headline-stat">
          <span className="usage-stat-index" aria-hidden="true">01</span>
          <span className="usage-card-label">Requests</span>
          <strong>{formatCount(dashboard.totals.requestCount)}</strong>
          <small>
            {formatCount(dashboard.totals.completedCount)} completed
            {dashboard.totals.failedCount > 0 ? ` · ${formatCount(dashboard.totals.failedCount)} failed` : ""}
            {dashboard.totals.cancelledCount > 0 ? ` · ${formatCount(dashboard.totals.cancelledCount)} cancelled` : ""}
            {dashboard.totals.interruptedCount > 0 ? ` · ${formatCount(dashboard.totals.interruptedCount)} interrupted` : ""}
          </small>
        </article>
        <article className="usage-headline-stat">
          <span className="usage-stat-index" aria-hidden="true">02</span>
          <span className="usage-card-label">Active runtime</span>
          <strong><MetricValue metric={dashboard.totals.runtime} format={formatDuration} /></strong>
          <small>{coverageCopy(dashboard.totals.runtime)}</small>
        </article>
        <article className="usage-headline-stat">
          <span className="usage-stat-index" aria-hidden="true">03</span>
          <span className="usage-card-label">Processed tokens</span>
          <strong><MetricValue metric={dashboard.totals.processedTokens} format={formatCompact} /></strong>
          <small>{coverageCopy(dashboard.totals.processedTokens)}</small>
          <CoverageState coverage={dashboard.totals.processedTokens.coverage} />
        </article>
        <article className="usage-headline-stat is-unavailable">
          <span className="usage-stat-index" aria-hidden="true">04</span>
          <span className="usage-card-label">Estimated cost</span>
          <strong>Unavailable</strong>
          <small>{dashboard.cost.reason}</small>
        </article>
      </section>

      {dashboard.totals.requestCount === 0 ? (
        <section className="usage-empty-state" aria-labelledby="usage-empty-title">
          <span className="usage-empty-kicker">No observations</span>
          <h3 id="usage-empty-title">No terminal requests in this range</h3>
          <p>Usage will appear here after Inertia records a completed, failed, cancelled, or interrupted agent turn.</p>
        </section>
      ) : (
        <>
          <section className="usage-analysis-section usage-trend-panel" aria-labelledby="usage-trend-heading">
            <div className="usage-panel-heading">
              <span>
                <small>01 / Daily trend</small>
                <h3 id="usage-trend-heading">Activity over time</h3>
              </span>
              <div className="usage-segmented" role="group" aria-label="Trend metric">
                <button type="button" aria-pressed={trendMetric === "requests"} onClick={() => setTrendMetric("requests")}>Requests</button>
                <button type="button" aria-pressed={trendMetric === "tokens"} onClick={() => setTrendMetric("tokens")}>Tokens</button>
              </div>
            </div>
            <DailyTrend dashboard={dashboard} metric={trendMetric} />
            {trendMetric === "tokens" && dashboard.totals.processedTokens.coverage !== "complete" && (
              <p className="usage-chart-note">Gaps are unavailable totals; partial points show only measured requests.</p>
            )}
          </section>

          <section className="usage-analysis-section usage-provider-section" aria-labelledby="usage-provider-heading">
            <div className="usage-panel-heading">
              <span><small>02 / Provider share</small><h3 id="usage-provider-heading">Where requests ran</h3></span>
              <small>{dashboard.providers.length} {dashboard.providers.length === 1 ? "provider" : "providers"}</small>
            </div>
            <div
              className="usage-provider-share-rail"
              role="img"
              aria-label={`Request share by provider. ${providerShareCopy}`}
            >
              {dashboard.providers.map((provider) => (
                <span
                  data-provider={provider.providerId}
                  style={{ flexGrow: provider.requestCount }}
                  title={`${provider.providerLabel}: ${percentFormatter.format(requestShare(provider, dashboard.totals.requestCount))}`}
                  key={provider.key}
                />
              ))}
            </div>
            <div className="usage-provider-list">
              {dashboard.providers.map((provider) => (
                <article className="usage-provider-row" data-provider={provider.providerId} key={provider.key}>
                  <ProviderMark providerId={provider.providerId} />
                  <span className="usage-provider-name">
                    <strong>{provider.providerLabel}</strong>
                    <small>{formatCount(provider.requestCount)} {provider.requestCount === 1 ? "request" : "requests"}</small>
                  </span>
                  <span className="usage-provider-share">
                    <strong>{percentFormatter.format(requestShare(provider, dashboard.totals.requestCount))}</strong>
                    <small>of requests</small>
                  </span>
                  <span className="usage-breakdown-metric">
                    <strong>{provider.processedTokens.value === null ? "—" : formatCompact(provider.processedTokens.value)}</strong>
                    <small>{provider.processedTokens.value === null ? "tokens unavailable" : "measured tokens"}</small>
                  </span>
                  <span className="usage-breakdown-metric">
                    <strong>{provider.runtime.value === null ? "—" : formatDuration(provider.runtime.value)}</strong>
                    <small>{provider.runtime.value === null ? "runtime unavailable" : "active runtime"}</small>
                  </span>
                </article>
              ))}
            </div>
          </section>

          <section className="usage-analysis-section usage-token-section" aria-labelledby="usage-token-heading">
            <div className="usage-panel-heading">
              <span><small>03 / Token fields</small><h3 id="usage-token-heading">What providers reported</h3></span>
              <small>Categories can overlap</small>
            </div>
            <div className="usage-token-list" aria-label="Observed token fields">
              {tokenFields.map(([label, metric]) => (
                <article key={label}>
                  <span className="usage-token-label">
                    <strong>{label}</strong>
                    <CoverageState coverage={metric.coverage} />
                  </span>
                  <span className="usage-token-value"><MetricValue metric={metric} format={formatCompact} /></span>
                  <span className="usage-token-coverage">
                    <CoverageMeter metric={metric} />
                    <small>{coverageCopy(metric)}</small>
                  </span>
                </article>
              ))}
            </div>
          </section>

          <section className="usage-analysis-section usage-model-panel" aria-labelledby="usage-model-heading">
            <div className="usage-panel-heading">
              <span><small>04 / Model detail</small><h3 id="usage-model-heading">Models and backends</h3></span>
              <small>Recorded provider and backend labels</small>
            </div>
            <div
              className="usage-table-wrap"
              role="region"
              tabIndex={0}
              aria-label="Model usage table"
            >
              <table className="usage-model-table">
                <thead>
                  <tr><th>Model</th><th>Provider / backend</th><th>Request share</th><th>Requests</th><th>Measured tokens</th><th>Runtime</th></tr>
                </thead>
                <tbody>
                  {dashboard.models.map((model) => (
                    <tr key={model.key}>
                      <th scope="row"><span>{model.model}</span></th>
                      <td>
                        <span className="usage-model-provider">
                          <ProviderMark providerId={model.providerId} />
                          <span>
                            {model.providerLabel}{model.backendLabel === model.providerLabel ? "" : ` · ${model.backendLabel}`}
                            <small>Configuration revision {model.backendConfigurationRevision}</small>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="usage-model-share">
                          <span aria-hidden="true"><i style={{ width: `${requestShare(model, dashboard.totals.requestCount) * 100}%` }} /></span>
                          <small>{percentFormatter.format(requestShare(model, dashboard.totals.requestCount))}</small>
                        </span>
                      </td>
                      <td>{formatCount(model.requestCount)}</td>
                      <td>
                        {model.processedTokens.value === null ? "Unavailable" : formatCompact(model.processedTokens.value)}
                        {model.processedTokens.coverage === "partial" && <small>Partial</small>}
                      </td>
                      <td>{model.runtime.value === null ? "Unavailable" : formatDuration(model.runtime.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <div className="usage-notes">
        <section className="usage-method-note" aria-labelledby="usage-method-heading">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            <strong id="usage-method-heading">Measured locally, with explicit coverage</strong>
            <small>
              Only authoritative terminal turns are included and grouped by completion date; legacy inferred records are excluded. Runtime comes from turn boundaries. Processed tokens use direct run totals or proven resumed-session deltas with matching scope and execution identity. Token-field totals sum only provider-reported completion fields and can overlap. No prompts, files, credentials, or new telemetry are collected.
            </small>
          </span>
        </section>
        <section className="usage-cost-note" aria-labelledby="usage-cost-heading">
          <span className="usage-cost-rule" aria-hidden="true" />
          <span>
            <strong id="usage-cost-heading">Cost remains unavailable</strong>
            <small>{dashboard.cost.reason} Inertia does not claim provider-invoice parity without that provenance.</small>
          </span>
        </section>
      </div>
    </>
  );
}

export function UsageView({ status, request }: UsageViewProps): React.JSX.Element {
  const [days, setDays] = useState<UsageRangeDays>(30);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [dashboard, setDashboard] = useState<UsageDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const rangeOptions = useMemo(() => [7, 30, 90] as const, []);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (status !== "online") {
      setDashboard(null);
      setLoading(status === "connecting");
      setError(status === "offline" ? "Usage is unavailable while the local service is offline." : null);
      return;
    }
    setDashboard(null);
    setLoading(true);
    setError(null);
    void request(usageDashboardCommand(days)).then((event) => {
      if (loadGeneration.current !== generation) return;
      const result = resultEvent(event).result;
      if (result.kind !== "usage.dashboard") {
        throw new Error("The local service returned an unexpected usage response.");
      }
      setDashboard(result.dashboard);
    }).catch((cause: unknown) => {
      if (loadGeneration.current !== generation) return;
      setError(cause instanceof Error ? cause.message : "Usage could not be loaded.");
    }).finally(() => {
      if (loadGeneration.current === generation) setLoading(false);
    });
  }, [days, refreshVersion, request, status]);

  return (
    <main className="usage-view" aria-labelledby="usage-view-heading" aria-busy={loading}>
      <header className="usage-view-heading">
        <span>
          <small>Local analytics</small>
          <h2 id="usage-view-heading">Usage overview</h2>
          <p>Measured terminal agent activity across this Inertia installation.</p>
        </span>
        <div className="usage-view-controls">
          <div className="usage-segmented" role="group" aria-label="Usage date range">
            {rangeOptions.map((option) => (
              <button
                type="button"
                aria-pressed={days === option}
                disabled={loading && days === option}
                onClick={() => setDays(option)}
                key={option}
              >
                {option} days
              </button>
            ))}
          </div>
          <button
            type="button"
            className="usage-refresh-button"
            aria-label="Refresh usage"
            disabled={loading || status !== "online"}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      {loading && (
        <div className="usage-loading">
          <LoadingMark label="Loading usage" />
          <span>Aggregating local turn records…</span>
        </div>
      )}
      {!loading && error && (
        <div className="usage-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span><strong>Usage could not be loaded</strong><small>{error}</small></span>
          <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} disabled={status !== "online"}>Try again</button>
        </div>
      )}
      {!loading && !error && dashboard && <UsageDashboardContent dashboard={dashboard} />}
    </main>
  );
}

import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Coins,
  DatabaseZap,
  RefreshCw,
  Sigma,
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

const countFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 2,
});
const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
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

function CoverageBadge({ coverage }: { coverage: UsageCoverage }): React.JSX.Element {
  return (
    <span className={`usage-coverage is-${coverage}`}>
      {coverage === "complete" ? "Measured" : coverage === "partial" ? "Partial" : "Unavailable"}
    </span>
  );
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
  const width = 760;
  const height = 230;
  const padding = { top: 18, right: 18, bottom: 34, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = dashboard.daily.map((day) => trendValue(day, metric));
  const known = values.filter((value): value is number => value !== null);
  const maximum = Math.max(1, ...known);
  const x = (index: number): number => padding.left
    + (dashboard.daily.length === 1
      ? 0
      : index / (dashboard.daily.length - 1) * plotWidth);
  const y = (value: number): number => padding.top
    + plotHeight - value / maximum * plotHeight;
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
    ? "Shows the number of terminal requests completed on each day."
    : "Missing points mean no defensible processed-token total was available for that day.";

  return (
    <figure className="usage-trend-figure">
      <figcaption className="visually-hidden" id={titleId}>Daily {metricLabel}</figcaption>
      <p className="visually-hidden" id={descriptionId}>{description}</p>
      <svg
        className="usage-trend-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        {[0, 0.5, 1].map((ratio) => {
          const gridY = padding.top + plotHeight * ratio;
          return (
            <line
              className="usage-chart-grid"
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
        {path && <path className="usage-chart-line" d={path} />}
        {dashboard.daily.length <= 30 && values.map((value, index) => value === null ? null : (
          <circle
            className={`usage-chart-point${dashboard.daily[index]!.processedTokens.coverage === "partial" && metric === "tokens" ? " is-partial" : ""}`}
            cx={x(index)}
            cy={y(value)}
            r="3.2"
            key={dashboard.daily[index]!.date}
          >
            <title>
              {displayDate(dashboard.daily[index]!.date, true)}: {metric === "requests" ? formatCount(value) : formatCompact(value)} {metric === "requests" && value === 1 ? "request" : metricLabel}
            </title>
          </circle>
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

function BreakdownMetric({
  item,
}: {
  item: UsageDashboardBreakdown;
}): React.JSX.Element {
  return (
    <span className="usage-breakdown-metric">
      <strong>{item.processedTokens.value === null ? "—" : formatCompact(item.processedTokens.value)}</strong>
      <small>{item.processedTokens.value === null ? "tokens unavailable" : "measured tokens"}</small>
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
            Only direct run totals and proven same-scope deltas are counted; missing provider fields remain missing.
          </span>
        </div>
      )}

      <section className="usage-headline-grid" aria-label="Usage totals">
        <article className="usage-headline-card">
          <span className="usage-card-icon"><Sigma size={15} aria-hidden="true" /></span>
          <span className="usage-card-label">Requests</span>
          <strong>{formatCount(dashboard.totals.requestCount)}</strong>
          <small>
            {formatCount(dashboard.totals.completedCount)} completed
            {dashboard.totals.failedCount > 0 ? ` · ${formatCount(dashboard.totals.failedCount)} failed` : ""}
            {dashboard.totals.cancelledCount > 0 ? ` · ${formatCount(dashboard.totals.cancelledCount)} cancelled` : ""}
            {dashboard.totals.interruptedCount > 0 ? ` · ${formatCount(dashboard.totals.interruptedCount)} interrupted` : ""}
          </small>
        </article>
        <article className="usage-headline-card">
          <span className="usage-card-icon"><Clock3 size={15} aria-hidden="true" /></span>
          <span className="usage-card-label">Active runtime</span>
          <strong><MetricValue metric={dashboard.totals.runtime} format={formatDuration} /></strong>
          <small>{coverageCopy(dashboard.totals.runtime)}</small>
        </article>
        <article className="usage-headline-card">
          <span className="usage-card-icon"><DatabaseZap size={15} aria-hidden="true" /></span>
          <span className="usage-card-label">Processed tokens</span>
          <strong><MetricValue metric={dashboard.totals.processedTokens} format={formatCompact} /></strong>
          <small>{coverageCopy(dashboard.totals.processedTokens)}</small>
          <CoverageBadge coverage={dashboard.totals.processedTokens.coverage} />
        </article>
        <article className="usage-headline-card is-unavailable">
          <span className="usage-card-icon"><Coins size={15} aria-hidden="true" /></span>
          <span className="usage-card-label">Estimated cost</span>
          <strong>Unavailable</strong>
          <small>{dashboard.cost.reason}</small>
        </article>
      </section>

      {dashboard.totals.requestCount === 0 ? (
        <section className="usage-empty-state" aria-labelledby="usage-empty-title">
          <DatabaseZap size={24} aria-hidden="true" />
          <h3 id="usage-empty-title">No terminal requests in this range</h3>
          <p>Usage will appear here after Inertia records a completed, failed, cancelled, or interrupted agent turn.</p>
        </section>
      ) : (
        <>
          <section className="usage-panel usage-trend-panel" aria-labelledby="usage-trend-heading">
            <div className="usage-panel-heading">
              <span>
                <small>Daily trend</small>
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

          <section className="usage-panel" aria-labelledby="usage-provider-heading">
            <div className="usage-panel-heading">
              <span><small>Provider breakdown</small><h3 id="usage-provider-heading">Where requests ran</h3></span>
              <small>{dashboard.providers.length} {dashboard.providers.length === 1 ? "provider" : "providers"}</small>
            </div>
            <div className="usage-provider-list">
              {dashboard.providers.map((provider) => (
                <article className="usage-provider-row" data-provider={provider.providerId} key={provider.key}>
                  <span className="usage-provider-mark" aria-hidden="true" />
                  <span className="usage-provider-name">
                    <strong>{provider.providerLabel}</strong>
                    <small>{formatCount(provider.requestCount)} {provider.requestCount === 1 ? "request" : "requests"} · {provider.runtime.value === null ? "runtime unavailable" : formatDuration(provider.runtime.value)}</small>
                  </span>
                  <BreakdownMetric item={provider} />
                </article>
              ))}
            </div>
          </section>

          <section className="usage-token-grid" aria-label="Observed token fields">
            {tokenFields.map(([label, metric]) => (
              <article key={label}>
                <span>{label}</span>
                <strong><MetricValue metric={metric} format={formatCompact} /></strong>
                <small>{coverageCopy(metric)}</small>
              </article>
            ))}
          </section>

          <section className="usage-panel usage-model-panel" aria-labelledby="usage-model-heading">
            <div className="usage-panel-heading">
              <span><small>Model breakdown</small><h3 id="usage-model-heading">Models and backends</h3></span>
              <small>Recorded provider and backend labels</small>
            </div>
            <div className="usage-table-wrap" tabIndex={0} aria-label="Model usage table">
              <table className="usage-model-table">
                <thead>
                  <tr><th>Model</th><th>Provider / backend</th><th>Requests</th><th>Measured tokens</th><th>Runtime</th></tr>
                </thead>
                <tbody>
                  {dashboard.models.map((model) => (
                    <tr key={model.key}>
                      <th scope="row"><span>{model.model}</span></th>
                      <td>{model.providerLabel}{model.backendLabel === model.providerLabel ? "" : ` · ${model.backendLabel}`}</td>
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

      <section className="usage-method-note" aria-labelledby="usage-method-heading">
        <CheckCircle2 size={16} aria-hidden="true" />
        <span>
          <strong id="usage-method-heading">Measured locally, with explicit coverage</strong>
          <small>
            Only authoritative terminal turns are included and grouped by completion date; legacy inferred records are excluded. Runtime comes from turn boundaries. Processed tokens use direct run totals or same-scope deltas. Token-field cards sum only provider-reported completion fields and can overlap. No prompts, files, credentials, or new telemetry are collected.
          </small>
        </span>
      </section>
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

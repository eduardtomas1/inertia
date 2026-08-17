import { AlertCircle, RefreshCw } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ServerEvent,
  UsageDashboard,
  UsageDashboardBreakdown,
  UsageMeasuredValue,
  UsageRangeDays,
} from "@shared/contracts";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import { formatCompact, formatCount, formatDuration } from "../lib/usageFormat";
import { ProviderMark } from "./ProviderMark";
import {
  DailyProviderChart,
  dailyProviderMetric,
} from "./UsageProviderChart";
import { LoadingMark } from "./ui";
import "./UsageView.css";

type UsageDashboardCommand = Extract<
  CommandWithoutId,
  { type: "usage.dashboard.get" }
>;
type BreakdownMode = "model" | "day";

export interface UsageViewProps {
  status: ConnectionStatus;
  request(command: CommandWithoutId): Promise<ServerEvent>;
}

const RANGE_OPTIONS = [7, 30, 90] as const;
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
  return "No defensible total available";
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

function measuredTokenShare(
  item: UsageDashboardBreakdown,
  total: number | null,
): number | null {
  if (item.processedTokens.value === null || total === null || total === 0) {
    return null;
  }
  return item.processedTokens.value / total;
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
}): React.JSX.Element {
  return (
    <article className="usage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small title={detail}>{detail}</small>
    </article>
  );
}

function ModelBreakdown({ dashboard }: { dashboard: UsageDashboard }): React.JSX.Element {
  const measuredTotal = dashboard.totals.processedTokens.value;
  return (
    <table className="usage-breakdown-table">
      <thead><tr><th>Model</th><th>Measured tokens</th><th>Share</th><th>Requests</th></tr></thead>
      <tbody>
        {dashboard.models.map((model) => {
          const share = measuredTokenShare(model, measuredTotal);
          return (
            <tr key={model.key}>
              <th scope="row">
                <span className="usage-model-identity">
                  <ProviderMark providerId={model.providerId} size={13} />
                  <span>
                    <strong>{model.model}</strong>
                    <small>
                      {model.providerLabel}{model.backendLabel === model.providerLabel ? "" : ` · ${model.backendLabel}`} · revision {model.backendConfigurationRevision}
                    </small>
                  </span>
                </span>
              </th>
              <td>{model.processedTokens.value === null ? "Unavailable" : formatCompact(model.processedTokens.value)}{model.processedTokens.coverage === "partial" && <small>Partial</small>}</td>
              <td>{share === null ? "—" : percentFormatter.format(share)}</td>
              <td>{formatCount(model.requestCount)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DayBreakdown({ dashboard }: { dashboard: UsageDashboard }): React.JSX.Element {
  const days = dashboard.daily
    .filter(({ requestCount }) => requestCount > 0)
    .reverse();
  return (
    <table className="usage-breakdown-table is-day-table">
      <thead>
        <tr>
          <th>Day</th>
          {dashboard.providers.map((provider) => <th key={provider.key}>{provider.providerLabel}</th>)}
          <th>Total tokens</th>
          <th>Requests</th>
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day.date}>
            <th scope="row">{displayDate(day.date, true)}</th>
            {dashboard.providers.map((provider) => {
              const metric = dailyProviderMetric(day, provider.providerId);
              return (
                <td key={provider.key}>
                  {metric.value === null ? "Unavailable" : formatCompact(metric.value)}
                  {metric.coverage === "partial" && <small>Partial</small>}
                </td>
              );
            })}
            <td>
              {day.processedTokens.value === null ? "Unavailable" : formatCompact(day.processedTokens.value)}
              {day.processedTokens.coverage === "partial" && <small>Partial</small>}
            </td>
            <td>{formatCount(day.requestCount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsageDashboardContent({
  dashboard,
}: {
  dashboard: UsageDashboard;
}): React.JSX.Element {
  const [breakdown, setBreakdown] = useState<BreakdownMode>("model");
  const measuredTotal = dashboard.totals.processedTokens.value;
  const processedAverage = dashboard.totals.activeDays === 0
    ? 0
    : (measuredTotal ?? 0) / dashboard.totals.activeDays;
  const statusCopy = [
    dashboard.totals.completedCount > 0 ? `${formatCount(dashboard.totals.completedCount)} completed` : "",
    dashboard.totals.failedCount > 0 ? `${formatCount(dashboard.totals.failedCount)} failed` : "",
    dashboard.totals.cancelledCount > 0 ? `${formatCount(dashboard.totals.cancelledCount)} cancelled` : "",
    dashboard.totals.interruptedCount > 0 ? `${formatCount(dashboard.totals.interruptedCount)} interrupted` : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      {dashboard.totals.requestCount === 0 ? (
        <section className="usage-empty-state" aria-labelledby="usage-empty-title">
          <span>No observations</span>
          <h2 id="usage-empty-title">No terminal requests in this range</h2>
          <p>Usage will appear after Inertia records a completed, failed, cancelled, or interrupted terminal agent turn.</p>
        </section>
      ) : (
        <>
          <section className="usage-overview-grid" aria-label="Usage summary and daily trend">
            <div className="usage-summary-column">
              <div className="usage-primary-total">
                <span>Processed tokens</span>
                <strong>
                  <MetricValue metric={dashboard.totals.processedTokens} format={formatCompact} />
                  {dashboard.totals.processedTokens.coverage === "partial" && <sup>*</sup>}
                </strong>
                <small>
                  {dashboard.totals.processedTokens.coverage === "complete"
                    ? `Across ${formatCount(dashboard.totals.requestCount)} requests`
                    : dashboard.totals.processedTokens.coverage === "partial"
                      ? `* partial · measured across ${formatCount(dashboard.totals.processedTokens.measuredRequests)} of ${formatCount(dashboard.totals.requestCount)} requests`
                      : `Unavailable across ${formatCount(dashboard.totals.requestCount)} requests`}
                </small>
              </div>

              <div className="usage-provider-summary" aria-label="Measured tokens by provider">
                {dashboard.providers.map((provider) => {
                  const share = measuredTokenShare(provider, measuredTotal);
                  return (
                    <article data-provider={provider.providerId} key={provider.key}>
                      <div>
                        <span><ProviderMark providerId={provider.providerId} />{provider.providerLabel}</span>
                        <strong>{provider.processedTokens.value === null ? "—" : formatCompact(provider.processedTokens.value)}</strong>
                      </div>
                      <span className={`usage-provider-meter${share === null ? " is-unavailable" : ""}`} aria-hidden="true">
                        <i style={{ width: `${(share ?? 0) * 100}%` }} />
                      </span>
                      <small>
                        {provider.processedTokens.value === null
                          ? `Token total unavailable · ${formatCount(provider.requestCount)} ${provider.requestCount === 1 ? "request" : "requests"}`
                          : share === null
                            ? `${formatCompact(provider.processedTokens.value)} measured tokens · share unavailable`
                          : `${provider.processedTokens.coverage === "partial" ? "Partial · " : ""}${percentFormatter.format(share)} of measured tokens · ${formatCount(provider.requestCount)} ${provider.requestCount === 1 ? "request" : "requests"}`}
                      </small>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className="usage-daily-panel">
              <div className="usage-daily-heading">
                <h2>Daily processed tokens</h2>
                <div>
                  <div className="usage-mini-segment" role="group" aria-label="Chart metric">
                    <button
                      type="button"
                      aria-pressed="false"
                      aria-disabled="true"
                      aria-describedby="usage-cost-unavailable"
                      title={dashboard.cost.reason}
                    >
                      Cost
                    </button>
                    <button type="button" aria-pressed="true">Tokens</button>
                  </div>
                  <div className="usage-provider-legend" aria-label="Chart providers">
                    {dashboard.providers.map((provider) => (
                      <span key={provider.key}><ProviderMark providerId={provider.providerId} />{provider.providerLabel}</span>
                    ))}
                  </div>
                </div>
              </div>
              <DailyProviderChart
                dashboard={dashboard}
                formatDate={displayDate}
                formatTokens={formatCompact}
              />
            </div>
          </section>

          <section className="usage-metric-strip" aria-label="Usage totals">
            <Metric
              label="Processed tokens"
              value={<MetricValue metric={dashboard.totals.processedTokens} format={formatCompact} />}
              detail={dashboard.totals.processedTokens.coverage !== "complete"
                ? coverageCopy(dashboard.totals.processedTokens)
                : `${formatCompact(processedAverage)} per active day`}
            />
            <Metric
              label="Reported input"
              value={<MetricValue metric={dashboard.tokens.input} format={formatCompact} />}
              detail={coverageCopy(dashboard.tokens.input)}
            />
            <Metric
              label="Cached input"
              value={<MetricValue metric={dashboard.tokens.cachedInput} format={formatCompact} />}
              detail={dashboard.tokens.cacheWriteInput.value === null
                ? coverageCopy(dashboard.tokens.cachedInput)
                : `${coverageCopy(dashboard.tokens.cachedInput)} · ${formatCompact(dashboard.tokens.cacheWriteInput.value)} reported cache writes`}
            />
            <Metric
              label="Output"
              value={<MetricValue metric={dashboard.tokens.output} format={formatCompact} />}
              detail={dashboard.tokens.reasoningOutput.value === null
                ? coverageCopy(dashboard.tokens.output)
                : `${coverageCopy(dashboard.tokens.output)} · includes ${formatCompact(dashboard.tokens.reasoningOutput.value)} reasoning`}
            />
            <Metric
              label="Requests"
              value={formatCount(dashboard.totals.requestCount)}
              detail={`${dashboard.totals.runtime.value === null
                ? "Runtime unavailable"
                : `${formatDuration(dashboard.totals.runtime.value)} active runtime`}${statusCopy ? ` · ${statusCopy}` : ""}`}
            />
          </section>

          <section className="usage-breakdown" aria-labelledby="usage-breakdown-heading">
            <div className="usage-breakdown-heading">
              <h2 id="usage-breakdown-heading">Breakdown</h2>
              <div className="usage-mini-segment" role="group" aria-label="Breakdown mode">
                <button type="button" aria-pressed={breakdown === "model"} onClick={() => setBreakdown("model")}>Model</button>
                <button type="button" aria-pressed={breakdown === "day"} onClick={() => setBreakdown("day")}>Day</button>
              </div>
            </div>
            <div
              className={`usage-table-wrap${breakdown === "day" ? " is-day-mode" : ""}`}
              role="region"
              tabIndex={0}
              aria-label={`${breakdown === "model" ? "Model" : "Day"} usage table`}
            >
              {breakdown === "model"
                ? <ModelBreakdown dashboard={dashboard} />
                : <DayBreakdown dashboard={dashboard} />}
            </div>
          </section>

          <footer className="usage-notes">
            <p>
              <strong>Measured locally.</strong> Authoritative terminal turns only. Processed totals and token categories use harness-vetted turn values or proven resumed-session deltas; message-only, context-only, and missing fields remain unavailable. No prompts, files, credentials, or new telemetry. Token categories can overlap.
            </p>
            <p id="usage-cost-unavailable">
              <strong>Cost unavailable.</strong> {dashboard.cost.reason} Inertia does not claim invoice parity without pricing provenance.
            </p>
          </footer>
        </>
      )}
    </>
  );
}

function UsageSkeleton(): React.JSX.Element {
  return (
    <div className="usage-skeleton">
      <LoadingMark label="Loading usage" />
      <span className="visually-hidden">Aggregating local turn records…</span>
      <section className="usage-overview-grid" aria-hidden="true">
        <div className="usage-summary-column">
          <span className="usage-skeleton-line is-label" />
          <span className="usage-skeleton-line is-total" />
          <span className="usage-skeleton-line is-detail" />
          {[0, 1, 2].map((index) => (
            <span className="usage-skeleton-provider" key={index}>
              <i /><b /><em />
            </span>
          ))}
        </div>
        <div className="usage-skeleton-chart">
          <span className="usage-skeleton-line is-label" />
          <i /><i /><i /><i />
        </div>
      </section>
      <section className="usage-metric-strip" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => <span key={index} />)}
      </section>
    </div>
  );
}

export function UsageView({ status, request }: UsageViewProps): React.JSX.Element {
  const [days, setDays] = useState<UsageRangeDays>(30);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [dashboard, setDashboard] = useState<UsageDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

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
      <div className="usage-canvas">
        <h1 className="visually-hidden" id="usage-view-heading">Usage</h1>
        <header className="usage-toolbar">
          <span>{dashboard
            ? `${displayDate(dashboard.range.startDate)} to ${displayDate(dashboard.range.endDate)}`
            : `Last ${days} days`}</span>
          <div>
            <div className="usage-range-segment" role="group" aria-label="Usage date range">
              {RANGE_OPTIONS.map((option) => (
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
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </div>
        </header>

        {loading && <UsageSkeleton />}
        {!loading && error && (
          <div className="usage-error" role="alert">
            <AlertCircle size={17} aria-hidden="true" />
            <span><strong>Usage could not be loaded</strong><small>{error}</small></span>
            <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} disabled={status !== "online"}>Try again</button>
          </div>
        )}
        {!loading && !error && dashboard && <UsageDashboardContent dashboard={dashboard} />}
      </div>
    </main>
  );
}

import { useId, useRef, useState } from "react";
import type {
  ProviderId,
  UsageDashboard,
  UsageMeasuredValue,
} from "@shared/contracts";

import { ProviderMark } from "./ProviderMark";

export function dailyProviderMetric(
  day: UsageDashboard["daily"][number],
  providerId: ProviderId,
): UsageMeasuredValue {
  const provider = day.providers.find((entry) => entry.providerId === providerId);
  return provider?.processedTokens ?? {
    value: 0,
    measuredRequests: 0,
    totalRequests: 0,
    coverage: "complete",
  };
}

interface ChartPoint {
  x: number;
  y: number;
}

function splitSegments(points: readonly (ChartPoint | null)[]): ChartPoint[][] {
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Cubic path with horizontal controls: smooth, point-preserving and bounded. */
function smoothPath(points: readonly ChartPoint[]): string {
  const first = points[0];
  if (first === undefined) return "";
  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const midpoint = (previous.x + point.x) / 2;
    path += ` C ${midpoint.toFixed(2)} ${previous.y.toFixed(2)}, ${midpoint.toFixed(2)} ${point.y.toFixed(2)}, ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }
  return path;
}

function chartScale(peak: number): { maximum: number; ticks: number[] } {
  if (peak <= 0) return { maximum: 1, ticks: [1, 0] };
  const rawStep = peak / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1)
    * magnitude;
  const maximum = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = maximum; value >= 0; value -= step) ticks.push(value);
  return { maximum, ticks };
}

export function DailyProviderChart({
  dashboard,
  formatDate,
  formatTokens,
}: {
  dashboard: UsageDashboard;
  formatDate(value: string, includeYear?: boolean): string;
  formatTokens(value: number): string;
}): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 900;
  const height = 224;
  const baseline = height - 25;
  const top = 10;
  const plotHeight = baseline - top;
  const step = dashboard.daily.length <= 1
    ? 0
    : width / (dashboard.daily.length - 1);
  const peak = Math.max(0, ...dashboard.daily.flatMap((day) =>
    dashboard.providers.map((provider) =>
      dailyProviderMetric(day, provider.providerId).value ?? 0)));
  const { maximum, ticks } = chartScale(peak);
  const toY = (value: number): number => baseline - value / maximum * plotHeight;
  const series = dashboard.providers.map((provider) => {
    const metrics = dashboard.daily.map((day) =>
      dailyProviderMetric(day, provider.providerId));
    const points = metrics.map((metric, index): ChartPoint | null =>
      metric.value === null ? null : { x: index * step, y: toY(metric.value) });
    const partialPoints = metrics.flatMap((metric, index) =>
      metric.value !== null && metric.coverage === "partial"
        ? [{ x: index * step, y: toY(metric.value) }]
        : []);
    return { provider, segments: splitSegments(points), partialPoints };
  });
  const selectedDay = activeIndex === null ? null : dashboard.daily[activeIndex] ?? null;
  const announcedDay = dashboard.daily[activeIndex ?? dashboard.daily.length - 1]!;
  const moveToPointer = (clientX: number): void => {
    const bounds = plotRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
    setActiveIndex(Math.round(ratio * (dashboard.daily.length - 1)));
  };
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") setActiveIndex(0);
    else if (event.key === "End") setActiveIndex(dashboard.daily.length - 1);
    else setActiveIndex((current) => {
      const fallback = dashboard.daily.length - 1;
      const next = (current ?? fallback) + (event.key === "ArrowLeft" ? -1 : 1);
      return Math.min(dashboard.daily.length - 1, Math.max(0, next));
    });
  };
  const labelIndexes = [...new Set([
    0,
    Math.floor((dashboard.daily.length - 1) / 2),
    dashboard.daily.length - 1,
  ])];

  return (
    <figure className="usage-chart-figure">
      <figcaption className="visually-hidden" id={titleId}>Daily measured tokens by provider</figcaption>
      <p className="visually-hidden" id={descriptionId}>
        Layered provider series use measured processed-token totals. A gap means the provider did not report a defensible total for that day; ringed points are partial.
      </p>
      <div className="usage-chart-layout">
        <div className="usage-chart-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span style={{ top: `${(toY(tick) / height) * 100}%` }} key={tick}>
              {tick === 0 ? "0" : formatTokens(tick)}
            </span>
          ))}
        </div>
        <div
          className="usage-chart-plot"
          ref={plotRef}
          onPointerMove={(event) => moveToPointer(event.clientX)}
          onPointerLeave={() => setActiveIndex(null)}
        >
          <svg
            className="usage-provider-chart"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-labelledby={`${titleId} ${descriptionId}`}
          >
            {ticks.map((tick) => {
              const y = toY(tick);
              return <line className="usage-chart-grid" x1="0" x2={width} y1={y} y2={y} key={tick} />;
            })}
            {series.map(({ provider, segments }) => segments.map((segment, index) => {
              const line = smoothPath(segment);
              const first = segment[0]!;
              const last = segment.at(-1)!;
              const area = segment.length < 2
                ? ""
                : `${line} L ${last.x.toFixed(2)} ${baseline} L ${first.x.toFixed(2)} ${baseline} Z`;
              return area === "" ? null : (
                <path
                  className="usage-chart-area"
                  data-provider={provider.providerId}
                  d={area}
                  key={`${provider.key}:area:${index}`}
                />
              );
            }))}
            {series.map(({ provider, segments }) => segments.map((segment, index) => (
              segment.length === 1 ? (
                <circle
                  className="usage-chart-isolated-point"
                  data-provider={provider.providerId}
                  cx={segment[0]!.x}
                  cy={segment[0]!.y}
                  r="3"
                  key={`${provider.key}:point:${index}`}
                />
              ) : (
                <path
                  className="usage-chart-series"
                  data-provider={provider.providerId}
                  d={smoothPath(segment)}
                  key={`${provider.key}:line:${index}`}
                />
              )
            )))}
            {series.map(({ provider, partialPoints }) => partialPoints.map((point, index) => (
              <circle
                className="usage-chart-partial-point"
                data-provider={provider.providerId}
                cx={point.x}
                cy={point.y}
                r="3.5"
                key={`${provider.key}:partial:${index}`}
              />
            )))}
            {activeIndex !== null && (
              <line
                className="usage-chart-cursor"
                x1={activeIndex * step}
                x2={activeIndex * step}
                y1={top}
                y2={baseline}
              />
            )}
            {labelIndexes.map((index) => (
              <text
                className="usage-chart-label"
                x={index * step}
                y={height - 2}
                textAnchor={index === 0 ? "start" : index === dashboard.daily.length - 1 ? "end" : "middle"}
                key={dashboard.daily[index]!.date}
              >
                {formatDate(dashboard.daily[index]!.date)}
              </text>
            ))}
          </svg>
          <div
            className="usage-chart-interactor"
            role="slider"
            tabIndex={0}
            aria-label="Explore daily token chart"
            aria-valuemin={1}
            aria-valuemax={dashboard.daily.length}
            aria-valuenow={(activeIndex ?? dashboard.daily.length - 1) + 1}
            aria-valuetext={`${formatDate(announcedDay.date, true)}, ${announcedDay.processedTokens.value === null ? "tokens unavailable" : `${formatTokens(announcedDay.processedTokens.value)} measured tokens${announcedDay.processedTokens.coverage === "partial" ? ", partial" : ""}`}`}
            onFocus={() => setActiveIndex((current) => current ?? dashboard.daily.length - 1)}
            onBlur={() => setActiveIndex(null)}
            onKeyDown={moveByKeyboard}
          />
          {selectedDay !== null && (
            <div
              className="usage-chart-tooltip"
              style={{
                left: `${dashboard.daily.length <= 1 ? 0 : activeIndex! / (dashboard.daily.length - 1) * 100}%`,
                transform: activeIndex! > dashboard.daily.length * 0.62
                  ? "translateX(-100%)"
                  : "translateX(0)",
              }}
              aria-hidden="true"
            >
              <strong>{formatDate(selectedDay.date, true)}</strong>
              {dashboard.providers.map((provider) => {
                const metric = dailyProviderMetric(selectedDay, provider.providerId);
                return (
                  <span key={provider.key}>
                    <i><ProviderMark providerId={provider.providerId} size={11} />{provider.providerLabel}</i>
                    <b>{metric.value === null ? "Unavailable" : `${formatTokens(metric.value)}${metric.coverage === "partial" ? "*" : ""}`}</b>
                  </span>
                );
              })}
              <span className="usage-chart-tooltip-total">
                <i>Total measured</i>
                <b>{selectedDay.processedTokens.value === null ? "Unavailable" : `${formatTokens(selectedDay.processedTokens.value)}${selectedDay.processedTokens.coverage === "partial" ? "*" : ""}`}</b>
              </span>
              {selectedDay.processedTokens.coverage === "partial" && <small>* Partial coverage</small>}
            </div>
          )}
        </div>
      </div>
      <table className="visually-hidden">
        <caption>Daily measured tokens by provider</caption>
        <thead>
          <tr><th>Date</th>{dashboard.providers.map((provider) => <th key={provider.key}>{provider.providerLabel}</th>)}<th>Total</th></tr>
        </thead>
        <tbody>
          {dashboard.daily.map((day) => (
            <tr key={day.date}>
              <th>{day.date}</th>
              {dashboard.providers.map((provider) => {
                const metric = dailyProviderMetric(day, provider.providerId);
                return <td key={provider.key}>{metric.value === null ? "Unavailable" : `${metric.value} (${metric.coverage})`}</td>;
              })}
              <td>{day.processedTokens.value === null ? "Unavailable" : `${day.processedTokens.value} (${day.processedTokens.coverage})`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

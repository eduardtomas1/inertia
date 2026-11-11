import { useId, useRef, useState } from "react";
import type { UsageDashboardBreakdown, UsageMeasuredValue } from "@shared/contracts";

import { formatCompact, formatUsd, formatUsdAxis } from "../../lib/usageFormat";
import { ProviderMark } from "../ProviderMark";
import {
  chartScale,
  dayProviderMetric,
  displayDate,
  metricOf,
  type UsageOverviewDay,
  type UsageOverviewMetric,
} from "./UsageOverviewModel";

interface ChartPoint {
  x: number;
  y: number;
}

interface ChartCopy {
  caption: string;
  description: string;
  explore: string;
  unit: string;
  unavailable: string;
  total: string;
  partial: string;
}

const CHART_COPY: Record<UsageOverviewMetric, ChartCopy> = {
  cost: {
    caption: "Daily estimated cost by provider",
    description: "Layered provider series use estimated API cost at public list prices. A gap means none of that provider's requests could be priced that day; ringed points are partial.",
    explore: "Explore daily cost chart",
    unit: "estimated cost",
    unavailable: "cost unavailable",
    total: "Total estimate",
    partial: "* Partial estimate",
  },
  tokens: {
    caption: "Daily measured tokens by provider",
    description: "Layered provider series use measured processed-token totals. A gap means the provider did not report a defensible total for that day; ringed points are partial.",
    explore: "Explore daily token chart",
    unit: "measured tokens",
    unavailable: "tokens unavailable",
    total: "Total measured",
    partial: "* Partial coverage",
  },
};

const WIDTH = 900;
const HEIGHT = 224;
const BASELINE = HEIGHT - 25;
const TOP = 10;
const PLOT_HEIGHT = BASELINE - TOP;

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

function valueText(
  metric: UsageMeasuredValue,
  format: (value: number) => string,
): string {
  return metric.value === null
    ? "Unavailable"
    : `${format(metric.value)}${metric.coverage === "partial" ? "*" : ""}`;
}

function cellText(entry: UsageMeasuredValue, metric: UsageOverviewMetric): string {
  if (entry.value === null) return "Unavailable";
  return `${metric === "cost" ? formatUsd(entry.value) : entry.value} (${entry.coverage})`;
}

export function UsageOverviewChart({
  metric,
  daily,
  providers,
}: {
  metric: UsageOverviewMetric;
  daily: readonly UsageOverviewDay[];
  providers: readonly UsageDashboardBreakdown[];
}): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const lastIndex = daily.length - 1;
  if (lastIndex < 0) return null;

  const copy = CHART_COPY[metric];
  const format = metric === "cost" ? formatUsd : formatCompact;
  const formatAxis = metric === "cost" ? formatUsdAxis : formatCompact;
  const activeIndex = selectedIndex === null ? null : Math.min(selectedIndex, lastIndex);
  const step = lastIndex === 0 ? 0 : WIDTH / lastIndex;
  const peak = Math.max(0, ...daily.flatMap((day) =>
    providers.map((provider) =>
      dayProviderMetric(day, provider.providerId, metric).value ?? 0)));
  const { maximum, ticks } = chartScale(peak);
  const toY = (value: number): number => BASELINE - value / maximum * PLOT_HEIGHT;
  const series = providers.map((provider) => {
    const metrics = daily.map((day) =>
      dayProviderMetric(day, provider.providerId, metric));
    const points = metrics.map((entry, index): ChartPoint | null =>
      entry.value === null ? null : { x: index * step, y: toY(entry.value) });
    const partialPoints = metrics.flatMap((entry, index) =>
      entry.value !== null && entry.coverage === "partial"
        ? [{ x: index * step, y: toY(entry.value) }]
        : []);
    return { provider, segments: splitSegments(points), partialPoints };
  });
  const selectedDay = activeIndex === null ? null : daily[activeIndex]!;
  const announcedDay = daily[activeIndex ?? lastIndex]!;
  const announced = metricOf(announcedDay, metric);
  const moveToPointer = (clientX: number): void => {
    const bounds = plotRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
    setSelectedIndex(Math.round(ratio * lastIndex));
  };
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") setSelectedIndex(0);
    else if (event.key === "End") setSelectedIndex(lastIndex);
    else setSelectedIndex((current) => {
      const next = Math.min(current ?? lastIndex, lastIndex)
        + (event.key === "ArrowLeft" ? -1 : 1);
      return Math.min(lastIndex, Math.max(0, next));
    });
  };
  const labelIndexes = [...new Set([0, Math.floor(lastIndex / 2), lastIndex])];
  const selectedTotal = selectedDay === null ? null : metricOf(selectedDay, metric);

  return (
    <figure className="usage-overview-chart" data-metric={metric}>
      <figcaption className="visually-hidden" id={titleId}>{copy.caption}</figcaption>
      <p className="visually-hidden" id={descriptionId}>{copy.description}</p>
      <div className="usage-overview-chart-layout">
        <div className="usage-overview-chart-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span style={{ top: `${(toY(tick) / HEIGHT) * 100}%` }} key={tick}>
              {tick === 0 ? "0" : formatAxis(tick)}
            </span>
          ))}
        </div>
        <div
          className="usage-overview-chart-plot"
          ref={plotRef}
          onPointerMove={(event) => moveToPointer(event.clientX)}
          onPointerLeave={() => setSelectedIndex(null)}
        >
          <svg
            className="usage-overview-chart-svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-labelledby={`${titleId} ${descriptionId}`}
          >
            {ticks.map((tick) => {
              const y = toY(tick);
              return <line className="usage-overview-chart-grid" x1="0" x2={WIDTH} y1={y} y2={y} key={tick} />;
            })}
            {series.map(({ provider, segments }) => segments.map((segment, index) => {
              if (segment.length < 2) return null;
              const first = segment[0]!;
              const last = segment.at(-1)!;
              return (
                <path
                  className="usage-overview-chart-area"
                  data-provider={provider.providerId}
                  d={`${smoothPath(segment)} L ${last.x.toFixed(2)} ${BASELINE} L ${first.x.toFixed(2)} ${BASELINE} Z`}
                  key={`${provider.key}:area:${index}`}
                />
              );
            }))}
            {series.map(({ provider, segments }) => segments.map((segment, index) => (
              segment.length === 1 ? (
                <g key={`${provider.key}:point:${index}`}>
                  <path
                    className="usage-overview-chart-isolated-point"
                    data-provider={provider.providerId}
                    d={`M ${segment[0]!.x} ${segment[0]!.y} h 0`}
                  />
                  <path className="usage-overview-chart-point-core" d={`M ${segment[0]!.x} ${segment[0]!.y} h 0`} />
                </g>
              ) : (
                <path
                  className="usage-overview-chart-series"
                  data-provider={provider.providerId}
                  d={smoothPath(segment)}
                  key={`${provider.key}:line:${index}`}
                />
              )
            )))}
            {series.map(({ provider, partialPoints }) => partialPoints.map((point, index) => (
              <g key={`${provider.key}:partial:${index}`}>
                <path
                  className="usage-overview-chart-partial-point"
                  data-provider={provider.providerId}
                  d={`M ${point.x} ${point.y} h 0`}
                />
                <path className="usage-overview-chart-point-core" d={`M ${point.x} ${point.y} h 0`} />
              </g>
            )))}
            {activeIndex !== null && (
              <line
                className="usage-overview-chart-cursor"
                x1={activeIndex * step}
                x2={activeIndex * step}
                y1={TOP}
                y2={BASELINE}
              />
            )}
          </svg>
          <div className="usage-overview-chart-labels" aria-hidden="true">
            {labelIndexes.map((index) => (
              <span
                data-anchor={index === 0 ? "start" : index === lastIndex ? "end" : "middle"}
                style={{ left: `${index * step / WIDTH * 100}%` }}
                key={daily[index]!.date}
              >
                {displayDate(daily[index]!.date)}
              </span>
            ))}
          </div>
          <div
            className="usage-overview-chart-interactor"
            role="slider"
            tabIndex={0}
            aria-label={copy.explore}
            aria-valuemin={1}
            aria-valuemax={daily.length}
            aria-valuenow={(activeIndex ?? lastIndex) + 1}
            aria-valuetext={`${displayDate(announcedDay.date, true)}, ${announced.value === null ? copy.unavailable : `${format(announced.value)} ${copy.unit}${announced.coverage === "partial" ? ", partial" : ""}`}`}
            onFocus={() => setSelectedIndex((current) => current ?? lastIndex)}
            onBlur={() => setSelectedIndex(null)}
            onKeyDown={moveByKeyboard}
          />
          {selectedDay !== null && selectedTotal !== null && (
            <div
              className="usage-overview-chart-tooltip"
              style={{
                left: `${lastIndex === 0 ? 0 : activeIndex! / lastIndex * 100}%`,
                transform: activeIndex! > daily.length * 0.62
                  ? "translateX(-100%)"
                  : "translateX(0)",
              }}
              aria-hidden="true"
            >
              <strong>{displayDate(selectedDay.date, true)}</strong>
              {providers.map((provider) => (
                <span key={provider.key}>
                  <i><ProviderMark providerId={provider.providerId} size={14} />{provider.providerLabel}</i>
                  <b>{valueText(dayProviderMetric(selectedDay, provider.providerId, metric), format)}</b>
                </span>
              ))}
              <span className="usage-overview-chart-tooltip-total">
                <i>{copy.total}</i>
                <b>{valueText(selectedTotal, format)}</b>
              </span>
              {selectedTotal.coverage === "partial" && <small>{copy.partial}</small>}
            </div>
          )}
        </div>
      </div>
      <table className="visually-hidden">
        <caption>{copy.caption}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            {providers.map((provider) => <th scope="col" key={provider.key}>{provider.providerLabel}</th>)}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((day) => {
            const total = metricOf(day, metric);
            return (
              <tr key={day.date}>
                <th scope="row">{day.date}</th>
                {providers.map((provider) => {
                  const entry = dayProviderMetric(day, provider.providerId, metric);
                  return <td key={provider.key}>{cellText(entry, metric)}</td>;
                })}
                <td>{cellText(total, metric)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}

import { useId, useState } from "react";
import type {
  UsageDashboardModelBreakdown,
  UsageMeasuredValue,
} from "@shared/contracts";

import {
  formatCompact,
  formatCount,
  formatShare,
  formatUsd,
} from "../../lib/usageFormat";
import { ProviderMark } from "../ProviderMark";
import {
  dayProviderMetric,
  displayDate,
  metricOf,
  shareOf,
  sortByMetric,
  type UsageOverviewData,
  type UsageOverviewMetric,
} from "./UsageOverviewModel";

type BreakdownMode = "model" | "day";

function Measured({
  value,
  format,
  empty = "Unavailable",
}: {
  value: UsageMeasuredValue;
  format(value: number): string;
  empty?: string;
}): React.JSX.Element {
  if (value.value === null) return <span className="usage-overview-muted">{empty}</span>;
  return (
    <>
      {value.coverage === "partial" && <small>Partial</small>}
      {format(value.value)}
    </>
  );
}

function modelIdentity(model: UsageDashboardModelBreakdown): string {
  return JSON.stringify([model.providerId, model.backendLabel, model.model]);
}

function ModelTable({
  data,
  metric,
  showCost,
}: {
  data: UsageOverviewData;
  metric: UsageOverviewMetric;
  showCost: boolean;
}): React.JSX.Element {
  const models = sortByMetric(data.models, metric);
  const total = metricOf(data, metric);
  const peak = Math.max(0, ...models.map((model) => metricOf(model, metric).value ?? 0));
  const identities = new Map<string, number>();
  for (const model of models) {
    const identity = modelIdentity(model);
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  return (
    <table className="usage-overview-table is-model-table">
      <thead>
        <tr>
          <th scope="col" className="is-rank"><span className="visually-hidden">Rank</span><span aria-hidden="true">#</span></th>
          <th scope="col">Model</th>
          {showCost && <th scope="col">Cost</th>}
          <th scope="col" className="is-share">Share</th>
          <th scope="col">Tokens</th>
          <th scope="col">Requests</th>
        </tr>
      </thead>
      <tbody>
        {models.map((model, index) => {
          const value = metricOf(model, metric).value;
          const share = shareOf(metricOf(model, metric), total);
          const detail = [
            model.providerLabel,
            model.backendLabel === model.providerLabel ? null : model.backendLabel,
            (identities.get(modelIdentity(model)) ?? 0) > 1
              ? `revision ${model.backendConfigurationRevision}`
              : null,
            showCost && model.pricedAs !== null && model.pricedAs !== model.model
              ? `priced as ${model.pricedAs}`
              : null,
          ].filter(Boolean).join(" · ");
          return (
            <tr key={model.key} data-provider={model.providerId}>
              <td className="is-rank">{index + 1}</td>
              <th scope="row">
                <span className="usage-overview-model">
                  <ProviderMark providerId={model.providerId} size={14} />
                  <span>
                    <strong>{model.model}</strong>
                    <small>{detail}</small>
                    {value !== null && value > 0 && peak > 0 && (
                      <span className="usage-overview-model-meter" aria-hidden="true">
                        <i style={{ width: `${(value / peak) * 100}%` }} />
                      </span>
                    )}
                  </span>
                </span>
              </th>
              {showCost && (
                <td className="is-primary">
                  <Measured
                    value={model.cost}
                    format={formatUsd}
                    empty={model.pricedAs === null ? "Unpriced" : "No estimate"}
                  />
                </td>
              )}
              <td className="is-share">{share === null ? "—" : formatShare(share)}</td>
              <td className={showCost ? undefined : "is-primary"}>
                <Measured value={model.processedTokens} format={formatCompact} />
              </td>
              <td>{formatCount(model.requestCount)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DayTable({
  data,
  metric,
  showCost,
}: {
  data: UsageOverviewData;
  metric: UsageOverviewMetric;
  showCost: boolean;
}): React.JSX.Element {
  const days = data.daily.filter(({ requestCount }) => requestCount > 0).reverse();
  const providers = sortByMetric(data.providers, metric);
  const format = metric === "cost" ? formatUsd : formatCompact;
  const other: UsageOverviewMetric = metric === "cost" ? "tokens" : "cost";
  const formatOther = other === "cost" ? formatUsd : formatCompact;
  const emptyOf = (kind: UsageOverviewMetric): string =>
    kind === "cost" ? "No estimate" : "Unavailable";
  return (
    <table className="usage-overview-table is-day-table">
      <thead>
        <tr>
          <th scope="col">Day</th>
          {providers.map((provider) => <th scope="col" key={provider.key}>{provider.providerLabel}</th>)}
          <th scope="col">{metric === "cost" ? "Total cost" : "Total tokens"}</th>
          {(other === "tokens" || showCost) && <th scope="col">{other === "cost" ? "Cost" : "Tokens"}</th>}
          <th scope="col">Requests</th>
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day.date}>
            <th scope="row">{displayDate(day.date, true)}</th>
            {providers.map((provider) => {
              const active = day.providers.some((entry) => entry.providerId === provider.providerId);
              return (
                <td key={provider.key}>
                  {active
                    ? <Measured value={dayProviderMetric(day, provider.providerId, metric)} format={format} empty={emptyOf(metric)} />
                    : <span className="usage-overview-muted">—</span>}
                </td>
              );
            })}
            <td className="is-primary">
              <Measured value={metricOf(day, metric)} format={format} empty={emptyOf(metric)} />
            </td>
            {(other === "tokens" || showCost) && (
              <td><Measured value={metricOf(day, other)} format={formatOther} empty={emptyOf(other)} /></td>
            )}
            <td>{formatCount(day.requestCount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsageOverviewBreakdown({
  data,
  metric,
  showCost,
}: {
  data: UsageOverviewData;
  metric: UsageOverviewMetric;
  showCost: boolean;
}): React.JSX.Element {
  const headingId = useId();
  const [mode, setMode] = useState<BreakdownMode>("model");
  return (
    <section className="usage-overview-breakdown" aria-labelledby={headingId}>
      <div className="usage-overview-breakdown-heading">
        <h2 id={headingId}>Breakdown</h2>
        <div className="usage-overview-segment" role="group" aria-label="Breakdown mode">
          <button type="button" aria-pressed={mode === "model"} onClick={() => setMode("model")}>Model</button>
          <button type="button" aria-pressed={mode === "day"} onClick={() => setMode("day")}>Day</button>
        </div>
      </div>
      <div
        className={`usage-overview-table-wrap usage-overview-figure${mode === "day" ? " is-day-mode" : ""}`}
        role="region"
        tabIndex={0}
        aria-label={`${mode === "model" ? "Model" : "Day"} usage table`}
      >
        {mode === "model"
          ? <ModelTable data={data} metric={metric} showCost={showCost} />
          : <DayTable data={data} metric={metric} showCost={showCost} />}
      </div>
    </section>
  );
}

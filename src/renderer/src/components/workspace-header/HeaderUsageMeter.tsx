import { useEffect, useId, useState, type CSSProperties } from "react";

import type { EnvironmentUsageSummary } from "../../utils/environmentSummary";
import {
  clampRemainingPercent,
  HEADER_METER_LOW_REMAINING_PERCENT,
  headerUsageMeterModel,
  quotaResetLabel,
  quotaWindowLabel,
} from "../../utils/headerUsageMeter";

export function HeaderUsageMeter({
  usage,
  onOpenUsage,
}: {
  usage: EnvironmentUsageSummary | null;
  onOpenUsage: () => void;
}): React.JSX.Element | null {
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const model = headerUsageMeterModel(usage);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
  }, [open]);
  if (!model || !usage) return null;
  const bars = [model.primary, model.secondary].filter(
    (limit): limit is NonNullable<typeof limit> => limit !== null,
  );
  return (
    <span
      className="header-usage-meter-anchor"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={`header-usage-meter${model.low ? " is-low" : ""}`}
        aria-label={model.accessibleLabel}
        aria-describedby={open ? popoverId : undefined}
        data-freshness={model.freshness}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        onClick={() => {
          setOpen(false);
          onOpenUsage();
        }}
      >
        <span className="header-usage-meter-bars" aria-hidden="true">
          {bars.map((limit) => (
            <i
              key={limit.id}
              data-low={limit.remainingPercent < HEADER_METER_LOW_REMAINING_PERCENT || undefined}
            >
              <b style={{ "--meter-value": `${clampRemainingPercent(limit.remainingPercent)}%` } as CSSProperties} />
            </i>
          ))}
        </span>
        <span aria-hidden="true">{model.valueLabel}</span>
      </button>
      {open && (
        <span className="header-usage-popover" id={popoverId} role="tooltip">
          <span className="header-usage-popover-title">
            <strong>{usage.providerLabel}</strong>
            {model.freshness !== "current" && (
              <small>{model.freshness === "refreshing" ? "Refreshing" : model.freshness === "stale" ? "May be out of date" : "Unavailable"}</small>
            )}
          </span>
          {model.limits.map((limit) => {
            const window = quotaWindowLabel(limit.windowMinutes);
            return (
              <span
                className="header-usage-popover-row"
                key={limit.id}
                data-low={limit.remainingPercent < HEADER_METER_LOW_REMAINING_PERCENT || undefined}
              >
                <span>
                  {window ? `${window.slice(0, 1).toUpperCase()}${window.slice(1)} limit` : limit.label}
                  <small>{quotaResetLabel(limit.resetsAt, now)}</small>
                </span>
                <b>{clampRemainingPercent(limit.remainingPercent)}% left</b>
              </span>
            );
          })}
          <small className="header-usage-popover-hint">Open Usage for details</small>
        </span>
      )}
    </span>
  );
}

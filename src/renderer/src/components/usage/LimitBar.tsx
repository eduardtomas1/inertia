import { Gauge, TrendingDown, TrendingUp } from "lucide-react";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import clsx from "clsx";

import { usageWindowTitle } from "@shared/usage-window-title";
import { INTERFACE_LOCALE } from "../../lib/locale";
import {
  limitCountdown,
  limitPace,
  limitReadings,
  limitResetText,
  limitRestoreWidth,
  paceRemainingPercent,
  type LimitPace,
  type LimitReading,
} from "./limitMath";
import "./LimitBar.css";

const PACE = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", Icon: TrendingUp },
  on: { label: "On pace with the window", Icon: Gauge },
  under: { label: "Under pace: headroom left for the rest of the window", Icon: TrendingDown },
} as const;

export const LIMIT_LOW_REMAINING_PERCENT = 50;
export const LIMIT_CRITICAL_REMAINING_PERCENT = 20;

export interface LimitRowValue {
  id: string;
  label: string;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export function limitResetDate(resetsAt: string | null): string | undefined {
  const time = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toLocaleString(INTERFACE_LOCALE, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function PaceIcon({ pace }: { pace: LimitPace }): React.JSX.Element {
  const { label, Icon } = PACE[pace];
  return (
    <span className="limit-pace" role="img" aria-label={label} title={label}>
      <Icon size={14} aria-hidden="true" />
    </span>
  );
}

export function LimitBar({
  providerId,
  reading,
  now,
  compact = false,
  muted = false,
  className,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"span">, "children"> & {
  providerId: string | null | undefined;
  reading: LimitReading;
  now: number;
  compact?: boolean;
  muted?: boolean;
  children?: ReactNode;
}): React.JSX.Element {
  const mark = paceRemainingPercent(reading, now);
  const restore = limitRestoreWidth(reading);
  const remaining = reading.due ? 0 : reading.remaining ?? 0;
  return (
    <span
      {...props}
      className={clsx("limit-bar", className)}
      data-provider={providerId ?? undefined}
      data-compact={compact || undefined}
      data-marked={mark === null ? undefined : ""}
      data-due={reading.due || undefined}
      data-muted={muted || undefined}
      style={mark === null ? undefined : { "--limit-mark": `${mark}%` } as CSSProperties}
    >
      <span className="limit-bar-track" aria-hidden="true" />
      <span className="limit-bar-layers" aria-hidden="true">
        {remaining > 0 && <i className="limit-bar-fill" style={{ width: `${remaining}%` }} />}
        {restore > 0 && <i className="limit-bar-hatch" style={{ width: `${restore}%` }} />}
      </span>
      {mark !== null && <i className="limit-bar-mark" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function LimitRows({
  providerId,
  limits,
  now,
  className,
}: {
  providerId: string | null | undefined;
  limits: readonly LimitRowValue[];
  now: number;
  className?: string;
}): React.JSX.Element {
  const readings = limitReadings(limits, now);
  return (
    <ul className={clsx("limit-rows", className)}>
      {limits.map((limit, index) => {
        const reading = readings[index]!;
        const title = usageWindowTitle(limit);
        const pace = limitPace(reading, now);
        const reset = limitResetText(limitCountdown(reading.resetsAt, now));
        const remaining = reading.remaining;
        const tone = reading.due || remaining === null
          ? undefined
          : remaining < LIMIT_CRITICAL_REMAINING_PERCENT
            ? "critical"
            : remaining < LIMIT_LOW_REMAINING_PERCENT ? "low" : "ok";
        const value = reading.due ? "Reset" : remaining === null ? "Unavailable" : `${remaining}% left`;
        return (
          <li
            className="limit-row"
            key={limit.id}
            data-tone={tone}
            data-low={tone === "critical" || undefined}
            data-reset-due={reading.due || undefined}
          >
            <span className="limit-row-head">
              <span className="limit-row-label">{title}</span>
              <span className="limit-row-value">
                {pace && <PaceIcon pace={pace} />}
                <b>{value}</b>
              </span>
            </span>
            <LimitBar
              compact
              providerId={providerId}
              reading={reading}
              now={now}
              role="meter"
              aria-label={`${title} remaining`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={reading.due || remaining === null ? undefined : remaining}
              aria-valuetext={reading.due ? "Reset due, usage not yet updated" : value}
            />
            {reset && <small className="limit-row-reset" title={limitResetDate(reading.resetsAt)}>{reset}</small>}
          </li>
        );
      })}
    </ul>
  );
}

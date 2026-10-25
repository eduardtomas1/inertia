import { z } from "zod";
import type { UsageWindow } from "../../shared/provider-usage-limits";
const finite = z.number().finite();
const percent = (used: number) => Math.max(0, Math.min(100, 100 - used));
const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
export function openCodeSubscriptionWindows(raw: unknown): UsageWindow[] {
  const window = z.object({ percent: finite.nonnegative(), resetsAt: z.string().refine((value) => iso(value) !== null) });
  const { usage } = z.object({ usage: z.object({ rolling: window, weekly: window, monthly: window }) }).parse(raw);
  return ([ ["rolling", "Go · Session", 300], ["weekly", "Go · Weekly", 10080], ["monthly", "Go · Monthly", null] ] as const)
    .map(([id, label, windowMinutes]) => ({ id: `opencode:go_${id}`, label, remainingPercent: percent(usage[id].percent), resetsAt: iso(usage[id].resetsAt), windowMinutes }));
}

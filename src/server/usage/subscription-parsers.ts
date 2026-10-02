import { z } from "zod";
import type { UsageWindow } from "../../shared/provider-usage-limits";
const finite = z.number().finite();
const percent = (used: number) => Math.max(0, Math.min(100, 100 - used));
const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
export function cursorSubscriptionWindows(raw: unknown): UsageWindow[] {
  const value = z.object({ billingCycleEnd: z.union([z.string(), finite]).optional(),
    planUsage: z.object({ totalPercentUsed: finite.nonnegative().optional(), autoPercentUsed: finite.nonnegative().optional(), apiPercentUsed: finite.nonnegative().optional() }).optional() }).parse(raw);
  const end = Number(value.billingCycleEnd);
  const resetsAt = end > 0 && Number.isFinite(end) && end < 8.64e15 ? new Date(end).toISOString() : null;
  return ([ ["totalPercentUsed", "Overall"], ["autoPercentUsed", "Cursor models"], ["apiPercentUsed", "Other models"] ] as const)
    .flatMap(([id, label]) => value.planUsage?.[id] === undefined ? [] : [{ id: `cursor:${id}`, label,
      remainingPercent: percent(value.planUsage[id]), resetsAt, windowMinutes: null }]);
}
export function openCodeSubscriptionWindows(raw: unknown): UsageWindow[] {
  const window = z.object({ percent: finite.nonnegative(), resetsAt: z.string().refine((value) => iso(value) !== null) });
  const { usage } = z.object({ usage: z.object({ rolling: window, weekly: window, monthly: window }) }).parse(raw);
  return ([ ["rolling", "Go · Session", 300], ["weekly", "Go · Weekly", 10080], ["monthly", "Go · Monthly", null] ] as const)
    .map(([id, label, windowMinutes]) => ({ id: `opencode:go_${id}`, label, remainingPercent: percent(usage[id].percent), resetsAt: iso(usage[id].resetsAt), windowMinutes }));
}
const count = z.union([finite.nonnegative(), z.string().regex(/^\d+(?:\.\d+)?$/u)]).transform(Number).pipe(finite.nonnegative());
const kimiWindow = z.object({ limit: count, used: count.optional(), remaining: count.optional(),
  reset_at: z.unknown().optional(), resetAt: z.unknown().optional(), reset_time: z.unknown().optional(), resetTime: z.unknown().optional(),
  reset_in: count.optional(), resetIn: count.optional(), ttl: count.optional() });
export function kimiSubscriptionWindows(raw: unknown, receivedAt: number): UsageWindow[] {
  const duration = z.object({ duration: count, timeUnit: z.string() }).optional();
  const limit = z.union([z.object({ detail: kimiWindow, window: duration }), kimiWindow.extend({ window: duration }).transform((detail) => ({ detail, window: detail.window }))]);
  const value = z.object({ usage: kimiWindow.optional(), limits: z.array(limit).max(31).optional() }).parse(raw);
  const entries = [ ...(value.usage ? [{ id: "kimi:weekly", label: "Weekly", detail: value.usage, minutes: 10080 }] : []),
    ...(value.limits ?? []).map((entry, index) => ({ id: `kimi:window_${index}`, label: `Limit ${index + 1}`, detail: entry.detail,
      minutes: entry.window ? entry.window.duration * ({ MINUTE: 1, HOUR: 60, DAY: 1440, SECOND: 1 / 60 }[entry.window.timeUnit] ?? 0) || null : null })) ];
  return entries.map(({ id, label, detail, minutes }) => {
    if (detail.remaining !== undefined && detail.remaining > detail.limit) {
      throw new Error("The provider reported an invalid remaining quota.");
    }
    const used = detail.used ?? (detail.remaining !== undefined ? detail.limit - detail.remaining : null);
    const relative = detail.reset_in ?? detail.resetIn ?? detail.ttl;
    const reset = iso(detail.reset_at ?? detail.resetAt ?? detail.reset_time ?? detail.resetTime)
      ?? (relative !== undefined && relative > 0 && relative <= 31 * 86400 ? new Date(receivedAt + relative * 1000).toISOString() : null);
    return { id, label, remainingPercent: used === null || detail.limit <= 0 ? null : percent(used / detail.limit * 100),
      resetsAt: reset, windowMinutes: minutes && minutes > 0 && minutes <= 525600 ? minutes : null };
  });
}

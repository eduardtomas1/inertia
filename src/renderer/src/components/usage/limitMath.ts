export type LimitPace = "ahead" | "on" | "under";

export interface LimitWindowValue {
  id: string;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface LimitReading {
  used: number | null;
  remaining: number | null;
  restore: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  due: boolean;
}

export type LimitCountdown =
  | { state: "none" | "due" | "soon" }
  | { state: "counting"; text: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK_MINUTES = 10_080;
const MONTH_MINUTES = 43_200;
const PACE_TOLERANCE = 5;

export function limitResetTime(resetsAt: string | null | undefined): number | null {
  const time = Date.parse(resetsAt ?? "");
  return Number.isFinite(time) ? time : null;
}

function usedPercent(remainingPercent: number | null | undefined): number | null {
  return typeof remainingPercent === "number" && Number.isFinite(remainingPercent)
    ? 100 - Math.max(0, Math.min(100, remainingPercent))
    : null;
}

export function limitRemaining(remainingPercent: number | null | undefined): number | null {
  const used = usedPercent(remainingPercent);
  return used === null ? null : Math.round(100 - used);
}

export function limitWindowKind(windowMinutes: number | null): 0 | 1 | 2 | 3 {
  if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return 3;
  if (windowMinutes >= MONTH_MINUTES) return 2;
  return windowMinutes >= WEEK_MINUTES ? 1 : 0;
}

export function elapsedShare(
  reading: Pick<LimitReading, "resetsAt" | "windowMinutes">,
  now: number,
): number | null {
  const resetsAt = limitResetTime(reading.resetsAt);
  if (resetsAt === null || !reading.windowMinutes || !Number.isFinite(reading.windowMinutes)) return null;
  const length = reading.windowMinutes * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export function paceOfShares(used: number, elapsed: number): LimitPace {
  const gap = used - elapsed * 100;
  if (gap > PACE_TOLERANCE) return "ahead";
  if (gap < -PACE_TOLERANCE) return "under";
  return "on";
}

export function limitPace(reading: LimitReading, now: number): LimitPace | null {
  if (reading.due || reading.used === null) return null;
  const elapsed = elapsedShare(reading, now);
  return elapsed === null ? null : paceOfShares(reading.used, elapsed);
}

export function paceRemainingPercent(reading: LimitReading, now: number): number | null {
  if (reading.due) return null;
  const elapsed = elapsedShare(reading, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export function formatLimitDuration(milliseconds: number): string {
  const remaining = Math.max(0, milliseconds);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function limitCountdown(resetsAt: string | null | undefined, now: number): LimitCountdown {
  const time = limitResetTime(resetsAt);
  if (time === null) return { state: "none" };
  if (time <= now) return { state: "due" };
  if (time - now < MINUTE) return { state: "soon" };
  return { state: "counting", text: formatLimitDuration(time - now) };
}

export function limitChipText(countdown: LimitCountdown): string | null {
  if (countdown.state === "counting") return `↻ ${countdown.text}`;
  if (countdown.state === "soon") return "Resets momentarily";
  return countdown.state === "due" ? "Reset due" : null;
}

export function limitResetText(countdown: LimitCountdown): string | null {
  if (countdown.state === "counting") return `Resets in ${countdown.text}`;
  if (countdown.state === "soon") return "Resets momentarily";
  return countdown.state === "due" ? "Reset due · updating" : null;
}

export function limitRestoreWidth(reading: LimitReading): number {
  if (reading.due) return 100;
  if (reading.remaining === null || reading.remaining >= 100 || reading.restore <= 0) return 0;
  if (limitResetTime(reading.resetsAt) === null) return 0;
  return Math.min(100 - reading.remaining, Math.round(reading.restore));
}

function exhaustsSession(window: LimitWindowValue, session: LimitWindowValue, now: number): boolean {
  if (window === session || (usedPercent(window.remainingPercent) ?? 0) < 100) return false;
  const reset = limitResetTime(window.resetsAt);
  if (reset !== null && reset <= now) return false;
  if (session.id.startsWith("claude:")) return window.id === "claude:seven_day";
  return session.id.startsWith("codex:") && window.id.startsWith("codex:")
    && limitWindowKind(window.windowMinutes) === 1;
}

function plainReading(window: LimitWindowValue, now: number): LimitReading {
  const used = usedPercent(window.remainingPercent);
  const reset = limitResetTime(window.resetsAt);
  return {
    used,
    remaining: limitRemaining(window.remainingPercent),
    restore: used ?? 0,
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes,
    due: reset !== null && reset <= now,
  };
}

export function limitReadings(
  windows: readonly LimitWindowValue[],
  now: number,
  checkedAt: string | null = null,
): LimitReading[] {
  const reference = Math.max(now, limitResetTime(checkedAt) ?? 0);
  return windows.map((window) => {
    const reading = plainReading(window, now);
    if (reading.due || reading.used === null || limitWindowKind(window.windowMinutes) !== 0) return reading;
    const weekly = windows.find((candidate) => exhaustsSession(candidate, window, now));
    if (!weekly) return reading;
    const sessionReset = limitResetTime(window.resetsAt);
    const weeklyReset = limitResetTime(weekly.resetsAt);
    const exhausted = { ...reading, used: 100, remaining: 0, windowMinutes: null };
    if (sessionReset === null || weeklyReset === null || sessionReset <= reference || weeklyReset <= reference) {
      return { ...exhausted, resetsAt: null, restore: 0 };
    }
    if (sessionReset <= weeklyReset) return { ...exhausted, resetsAt: weekly.resetsAt, restore: 100 };
    return reading.used >= 100
      ? { ...exhausted, resetsAt: window.resetsAt, restore: 100 }
      : { ...exhausted, resetsAt: weekly.resetsAt, restore: 100 - reading.used };
  });
}

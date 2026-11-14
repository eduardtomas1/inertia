import { INTERFACE_LOCALE } from "../../lib/locale";

export function dateLabel(value: string | null): string {
  return value
    ? new Date(value).toLocaleString(INTERFACE_LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    : "Not reported";
}

export function ageLabel(value: string | null, now: number): string | null {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

import { INTERFACE_LOCALE } from "./locale";

export function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(INTERFACE_LOCALE, { numeric: "auto" });

  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(INTERFACE_LOCALE, { month: "short", day: "numeric" }).format(timestamp);
}

/** Compact elapsed labels keep Work cards readable at narrow sidebar widths. */
export function formatWorkAge(value: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1_000);
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d`;
  return formatRelativeTime(value);
}

export function formatClockTime(value: string): string {
  return new Intl.DateTimeFormat(INTERFACE_LOCALE, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function projectNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "Untitled project";
}

export function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

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

let timestampFormatterKey = "";
const timestampFormatters = new Map<string, Intl.DateTimeFormat>();

function timestampFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const now = new Date();
  const key = `${now.getTimezoneOffset()}:${Math.floor(now.getTime() / 60_000)}`;
  if (key !== timestampFormatterKey) {
    timestampFormatters.clear();
    timestampFormatterKey = key;
  }
  const id = JSON.stringify(options);
  let formatter = timestampFormatters.get(id);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(INTERFACE_LOCALE, options);
    timestampFormatters.set(id, formatter);
  }
  return formatter;
}

export function formatMessageTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === now.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();
  return timestampFormatter({
    ...(sameDay ? {} : { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatFullDateTime(value: string): string {
  return timestampFormatter({
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(value));
}

export function projectNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "Untitled project";
}

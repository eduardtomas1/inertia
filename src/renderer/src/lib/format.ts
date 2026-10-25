import { INTERFACE_LOCALE } from "./locale";

const relativeTimeFormatter = new Intl.RelativeTimeFormat(INTERFACE_LOCALE, { numeric: "auto" });

export function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  const seconds = Math.round((timestamp - Date.now()) / 1_000);

  if (Math.abs(seconds) < 60) return relativeTimeFormatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTimeFormatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTimeFormatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relativeTimeFormatter.format(days, "day");
  return new Intl.DateTimeFormat(INTERFACE_LOCALE, { month: "short", day: "numeric" }).format(timestamp);
}

export function formatUpdatedAge(value: string | null, now = Date.now()): string | null {
  const updatedAt = Date.parse(value ?? "");
  if (!Number.isFinite(updatedAt)) return null;
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours} h ago`;
  return `updated ${Math.floor(hours / 24)} d ago`;
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
  const name = (normalized.split(/[\\/]/).pop() ?? "").trim().slice(0, 80);
  return name.replace(/[\uD800-\uDBFF]$/u, "").trimEnd() || "Untitled project";
}

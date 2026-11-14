export { formatCompact } from "./compactFormat";

const countFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 0,
});

export function formatCount(value: number): string {
  return countFormatter.format(value);
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdCompactFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const usdWholeFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdSmallFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2,
});
const shareFormatter = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 1,
});

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return usdFormatter.format(value);
}

export function formatUsdAxis(value: number): string {
  if (value === 0) return "$0";
  if (value >= 1_000) return usdCompactFormatter.format(value);
  if (Number.isInteger(value)) return usdWholeFormatter.format(value);
  if (value >= 0.01) return usdFormatter.format(value);
  return usdSmallFormatter.format(value);
}

export function formatShare(value: number): string {
  if (value > 0 && value < 0.001) return "<0.1%";
  return shareFormatter.format(value);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

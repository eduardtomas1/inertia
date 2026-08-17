const countFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 0,
});
const compactFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
});

export function formatCount(value: number): string {
  return countFormatter.format(value);
}

export function formatCompact(value: number): string {
  return compactFormatter.format(value);
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

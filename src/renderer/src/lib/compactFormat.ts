const compactFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
});

export function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

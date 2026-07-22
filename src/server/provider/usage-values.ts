export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Accept provider reset timestamps in ISO form, epoch seconds, or epoch milliseconds. */
export function providerTimestamp(value: unknown): string | null {
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = Math.abs(value) >= 100_000_000_000 ? value : value * 1_000;
  } else if (typeof value === "string" && value.trim()) {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

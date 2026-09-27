import type { TurnExecutionStreamEntry } from "../../utils/responseTimeline";

function sameValue(left: unknown, right: unknown): boolean {
  return left === right
    || (Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => value === right[index]));
}

function sameExecutionEntry(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => sameValue(left[key], right[key]));
}

export function stabilizeTurnExecutionStream(
  next: TurnExecutionStreamEntry[],
  previous: readonly TurnExecutionStreamEntry[],
): TurnExecutionStreamEntry[] {
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  return next.map((entry) => {
    const prior = previousById.get(entry.id);
    return prior && sameExecutionEntry(prior, entry) ? prior : entry;
  });
}

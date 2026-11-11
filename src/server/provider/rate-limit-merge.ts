import type { ProviderRateLimit } from "../../shared/contracts";

const RESET_TOLERANCE_MS = 5 * 60_000;

function resetTime(limit: ProviderRateLimit | undefined): number | null {
  const time = Date.parse(limit?.resetsAt ?? "");
  return Number.isFinite(time) ? time : null;
}

export function mergeSparseRateLimits(
  previous: readonly ProviderRateLimit[],
  update: readonly ProviderRateLimit[],
  now: number,
): ProviderRateLimit[] {
  const incoming = new Map(update.map((limit) => [limit.id, limit]));
  const describesAnotherWindow = previous.some((prior) => {
    const before = resetTime(prior);
    const after = resetTime(incoming.get(prior.id));
    return before !== null
      && after !== null
      && before > now
      && Math.abs(after - before) > RESET_TOLERANCE_MS;
  });
  const merged = new Map<string, ProviderRateLimit>();
  if (!describesAnotherWindow) {
    for (const prior of previous) {
      const ended = (resetTime(prior) ?? Infinity) <= now;
      if (incoming.has(prior.id) || !ended) merged.set(prior.id, prior);
    }
  }
  for (const limit of update) merged.set(limit.id, limit);
  return [...merged.values()];
}

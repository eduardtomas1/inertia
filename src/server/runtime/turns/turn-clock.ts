/** Lifecycle ordering survives OS time corrections; deadlines use their own timers. */
export function monotonicTurnClock(wallClock: () => Date = () => new Date()): () => Date {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    last = Math.max(last, wallClock().getTime());
    return new Date(last);
  };
}

export function monotonicTurnClock(wallClock: () => Date = () => new Date()): () => Date {
  let last = Number.NEGATIVE_INFINITY;
  let clamped = false;
  return () => {
    const wall = wallClock().getTime();
    clamped = wall < last || (clamped && wall === last);
    last = clamped ? last + 1 : wall;
    return new Date(last);
  };
}

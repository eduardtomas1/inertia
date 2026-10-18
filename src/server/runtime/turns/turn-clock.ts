export function monotonicTurnClock(
  wallClock: () => Date = () => new Date(),
  floor = Number.NEGATIVE_INFINITY,
): () => Date {
  let last = floor;
  let clamped = true;
  return () => {
    const wall = wallClock().getTime();
    clamped = wall < last || (clamped && wall === last);
    last = clamped ? last + 1 : wall;
    return new Date(last);
  };
}

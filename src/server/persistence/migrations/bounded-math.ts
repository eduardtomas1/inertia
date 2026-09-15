export function boundedMathMin(...lists: ReadonlyArray<readonly number[]>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const values of lists) {
    for (const value of values) {
      if (Number.isNaN(value)) return Number.NaN;
      if (value < minimum || (Object.is(value, -0) && minimum === 0)) minimum = value;
    }
  }
  return minimum;
}

export function boundedMathMax(...lists: ReadonlyArray<readonly number[]>): number {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const values of lists) {
    for (const value of values) {
      if (Number.isNaN(value)) return Number.NaN;
      if (value > maximum || (Object.is(value, 0) && maximum === 0)) maximum = value;
    }
  }
  return maximum;
}

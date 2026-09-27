type ReviewCallbacks = Record<string, (...args: never[]) => unknown>;

export function scopedReviewDispatch<Callbacks extends ReviewCallbacks>(
  callbacks: Callbacks,
  openedScope: string,
  currentScope: () => string,
): Callbacks {
  return Object.fromEntries(Object.entries(callbacks).map(([name, callback]) => [
    name,
    (...args: never[]) => currentScope() === openedScope ? callback(...args) : undefined,
  ])) as Callbacks;
}

export interface SurfaceLoader<T> {
  (): Promise<T>;
  peek: () => T | null;
}

export function createSurfaceLoader<T>(
  load: () => Promise<T>,
): SurfaceLoader<T> {
  let promise: Promise<T> | null = null;
  let loaded: T | null = null;
  const loadOnce = (() => {
    promise ??= Promise.resolve().then(load).then((value) => {
      loaded = value;
      return value;
    }, (error: unknown) => {
      promise = null;
      throw error;
    });
    // Hover/idle prefetch may have no caller awaiting the result. Mark the
    // rejection handled while preserving it for callers that do await it.
    void promise.catch(() => undefined);
    return promise;
  }) as SurfaceLoader<T>;
  loadOnce.peek = () => loaded;
  return loadOnce;
}

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
    promise ??= load().then((value) => {
      loaded = value;
      return value;
    });
    return promise;
  }) as SurfaceLoader<T>;
  loadOnce.peek = () => loaded;
  return loadOnce;
}

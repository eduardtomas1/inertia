import { useEffect, useState } from "react";

import type { SurfaceLoader } from "../utils/surfaceLoader";

/**
 * React.lazy still suspends on its first render when a shared import promise
 * has already settled. Reading the cached module synchronously keeps intent
 * and idle prefetches meaningful while preserving an on-demand fallback when
 * a chunk genuinely is not ready yet.
 */
export function useLoadedSurface<Component>(
  loader: SurfaceLoader<{ default: Component }>,
  enabled: boolean,
): Component | null {
  const [, setRevision] = useState(0);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const loaded = loader.peek()?.default ?? null;
  useEffect(() => {
    if (!enabled || loaded) return;
    let current = true;
    void loader().then(
      () => {
        if (current) setRevision((revision) => revision + 1);
      },
      (error: unknown) => {
        if (current) setFailure({ error });
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, loaded, loader]);
  if (failure) throw failure.error;
  return loaded;
}

export const RENDERER_RECOVERY_INTERVAL_MS = 60_000;

interface RendererCrashRecoveryOptions {
  reload(): void;
  canReload(): boolean;
  now?(): number;
  setTimer?(callback: () => void, milliseconds: number): void;
}

export function createRendererCrashRecovery(
  options: RendererCrashRecoveryOptions,
): (details: { reason: string }) => boolean {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer
    ?? ((callback: () => void, milliseconds: number) => { setTimeout(callback, milliseconds); });
  let lastReload = Number.NEGATIVE_INFINITY;
  let reloadDeferred = false;
  const reload = (): void => {
    lastReload = now();
    options.reload();
  };
  return (details) => {
    if (details.reason === "clean-exit" || !options.canReload()) return false;
    const remaining = lastReload + RENDERER_RECOVERY_INTERVAL_MS - now();
    if (remaining <= 0) {
      reload();
      return true;
    }
    if (reloadDeferred) return true;
    reloadDeferred = true;
    setTimer(() => {
      reloadDeferred = false;
      if (options.canReload()) reload();
    }, remaining);
    return true;
  };
}

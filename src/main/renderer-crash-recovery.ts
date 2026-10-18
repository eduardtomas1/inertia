export const RENDERER_RECOVERY_INTERVAL_MS = 60_000;

interface RendererCrashRecoveryOptions {
  reload(): void;
  canReload(): boolean;
  now?(): number;
}

export function createRendererCrashRecovery(
  options: RendererCrashRecoveryOptions,
): (details: { reason: string }) => boolean {
  const now = options.now ?? (() => performance.now());
  let lastReload = Number.NEGATIVE_INFINITY;
  return (details) => {
    if (details.reason === "clean-exit" || !options.canReload()) return false;
    const at = now();
    if (at - lastReload < RENDERER_RECOVERY_INTERVAL_MS) return false;
    lastReload = at;
    options.reload();
    return true;
  };
}

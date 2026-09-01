import { runtimeSupervisorShutdownEnvelopeMs } from
  "../node/runtime-shutdown-deadline.js";

export const WINDOWS_RUNTIME_JOB_BROKER_SHUTDOWN_TIMEOUT_MS = 4_000;
export const WINDOWS_RUNTIME_JOB_BROKER_FORCE_CLOSE_MARGIN_MS = 1_000;

/**
 * Covers every bounded privileged owner that must settle before the Electron
 * main process may exit. The Windows executable-lock broker is released only
 * after the supervised runtime has stopped, so its deadline is additive.
 */
export function privilegedShutdownEnvelopeMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return runtimeSupervisorShutdownEnvelopeMs(platform)
    + (platform === "win32"
      ? WINDOWS_RUNTIME_JOB_BROKER_SHUTDOWN_TIMEOUT_MS
        + WINDOWS_RUNTIME_JOB_BROKER_FORCE_CLOSE_MARGIN_MS
      : 0);
}

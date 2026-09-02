import {
  RUNTIME_SUPERVISOR_FORCE_KILL_WAIT_MS,
  runtimeSupervisorShutdownGraceMs,
} from "../node/runtime-shutdown-deadline.js";

const INITIAL_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 8_000;

export const runtimeSupervisorDefaults = {
  // Startup can include an explicitly authorized macOS ownership retirement,
  // attachment reconciliation, and interrupted-run recovery before readiness.
  // Electron's Intel utility startup must retain enough bounded headroom for
  // that complete sequence without forcing a second recovery decision.
  startupTimeoutMs: 30_000,
  stableUptimeMs: 30_000,
  // Let the utility runtime finish its complete platform-owned cleanup proof
  // before main begins the process-tree fallback. macOS includes bounded
  // guardian admission/retirement; Windows includes ConPTY drain headroom.
  shutdownGraceMs: runtimeSupervisorShutdownGraceMs(),
  forceKillWaitMs: RUNTIME_SUPERVISOR_FORCE_KILL_WAIT_MS,
  requestTimeoutMs: 10_000,
  databaseRecoveryTimeoutMs: 120_000,
  databaseRecoveryCancelTimeoutMs: 5_000,
  credentialRequestTimeoutMs: 10_000,
  maxUnconfirmedRestarts: 2,
} as const;

export function runtimeRestartDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.trunc(attempt), 30));
  return Math.min(INITIAL_RESTART_DELAY_MS * 2 ** exponent, MAX_RESTART_DELAY_MS);
}

export function boundedDuration(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), 120_000));
}

export function publicProcessError(
  error: unknown,
  fallback: string,
): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim().replace(/\s+/gu, " ").slice(0, 500);
  return message || fallback;
}

export function unconfirmedRuntimeCleanupMessage(
  _systemBootId: string,
  prefix: string,
): string {
  return `${prefix} Inertia kept the affected work unchanged and will retry exact cleanup when its local service starts again.`;
}

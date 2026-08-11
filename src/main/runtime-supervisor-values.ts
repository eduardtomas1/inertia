const INITIAL_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 8_000;

export const runtimeSupervisorDefaults = {
  startupTimeoutMs: 20_000,
  stableUptimeMs: 30_000,
  shutdownGraceMs: 3_000,
  forceKillWaitMs: 1_000,
  requestTimeoutMs: 10_000,
  databaseRecoveryTimeoutMs: 120_000,
  databaseRecoveryCancelTimeoutMs: 5_000,
  credentialRequestTimeoutMs: 10_000,
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

import {
  windowsCleanupFailureSchema,
  type WindowsCleanupFailure,
} from "../shared/lifecycle-diagnostics";

// Runtime-local, bounded evidence only. Never retain a PID, executable,
// command line, environment, provider output, or arbitrary error text.
const failures: WindowsCleanupFailure[] = [];

export function recordWindowsCleanupFailure(
  failure: WindowsCleanupFailure,
): void {
  const parsed = windowsCleanupFailureSchema.safeParse(failure);
  if (!parsed.success) return;
  failures.push(parsed.data);
  if (failures.length > 8) failures.shift();
}

export function windowsCleanupFailures(): WindowsCleanupFailure[] {
  return failures.map((failure) => ({ ...failure }));
}

export function windowsCleanupElapsedMs(startedAt: number): number {
  return Math.max(0, Math.min(300_000, Math.trunc(performance.now() - startedAt)));
}

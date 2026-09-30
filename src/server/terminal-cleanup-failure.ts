import type { PosixCleanupFailure } from "./posix-cleanup-diagnostics";
import { windowsCleanupFailures } from "./windows-cleanup-diagnostics";

export function terminalCleanupFailureOptions<T>(
  windowsAtStop: T | null,
  windowsAtFailure: () => T,
  posixCleanupFailure: PosixCleanupFailure | null,
): ErrorOptions {
  return windowsAtStop
    ? { cause: {
        windowsCleanupFailures: windowsCleanupFailures(),
        windowsTerminalCleanup: { atStop: windowsAtStop, atFailure: windowsAtFailure() },
      } }
    : { cause: { posixCleanupFailure } };
}

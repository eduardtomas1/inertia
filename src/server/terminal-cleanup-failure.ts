import { posixCleanupFailures } from "./posix-cleanup-diagnostics";
import { windowsCleanupFailures } from "./windows-cleanup-diagnostics";

export function terminalCleanupFailureOptions<T>(
  windowsAtStop: T | null,
  windowsAtFailure: () => T,
): ErrorOptions {
  return windowsAtStop
    ? { cause: {
        windowsCleanupFailures: windowsCleanupFailures(),
        windowsTerminalCleanup: { atStop: windowsAtStop, atFailure: windowsAtFailure() },
      } }
    : { cause: { posixCleanupFailures: posixCleanupFailures() } };
}

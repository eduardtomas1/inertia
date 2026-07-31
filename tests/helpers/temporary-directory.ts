import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE_REMOVAL_ERRORS = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

/**
 * Removes a test-owned directory while allowing Windows file handles a
 * bounded interval to finish closing.
 */
export async function removeTemporaryDirectory(directory: string): Promise<void> {
  const retryDelays = process.platform === "win32"
    ? [0, 50, 150, 350, 750, 1_500, 3_000]
    : [0];
  let lastError: unknown;

  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) await delay(retryDelay);
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
      if (typeof code !== "string" || !RETRYABLE_REMOVAL_ERRORS.has(code)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError;
}

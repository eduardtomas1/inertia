import type { ProviderRunResult } from "../../provider/contracts";
import type { TurnTerminalCause } from "./turn-controller-types";

export function providerFailureCause(
  result: ProviderRunResult,
): TurnTerminalCause {
  if (result.failure?.reason === "goal-continuation-timeout") {
    return "goal-continuation-timeout";
  }
  const transportFailure = result.failure
    ? result.failure.reason !== "codex-error"
    : result.exitCode !== null || result.signal !== null;
  return transportFailure ? "provider-process-exit" : "provider-error";
}

import {
  RUNTIME_STARTUP_FAILURE_CATEGORIES,
  categorizedRuntimeStartupFailureMessage,
  isRuntimeStartupFailureMessage,
} from "../shared/runtime-startup-diagnostics.js";
import {
  parseRuntimeOwnedProcessDiagnostic,
  type RuntimeRestartRequestedEvent,
} from "./runtime-owned-process-diagnostic.js";
import type { RuntimeShutdownUnconfirmedReason } from "./runtime-shutdown-protocol.js";

const shutdownMessages = {
  "runtime-close-deadline": "Runtime shutdown exceeded its deadline while closing local resources.",
  "runtime-close": "Runtime shutdown failed while closing local resources.",
  "owned-process-cleanup": "Runtime shutdown could not confirm owned-process cleanup.",
  "incomplete-startup": "Runtime shutdown could not confirm cleanup after incomplete startup.",
} as const satisfies Record<RuntimeShutdownUnconfirmedReason, string>;
const unknownShutdown = "The runtime could not confirm complete process cleanup.";
const restartMessages = {
  "owned-process-tainted": "The runtime restarted because owned process containment could not be confirmed.",
  "owned-process-cleanup-unconfirmed": "The runtime restarted because owned process cleanup could not be confirmed.",
} as const;

export function runtimeShutdownFailureMessage(reason?: RuntimeShutdownUnconfirmedReason): string {
  return reason ? shutdownMessages[reason] : unknownShutdown;
}

export function runtimeRestartFailureMessage(event: RuntimeRestartRequestedEvent): string {
  const diagnostic = event.diagnostic;
  const details = diagnostic ? [
    `stage=${diagnostic.stage}`,
    ...(diagnostic.signal !== undefined ? [`signal=${diagnostic.signal}`] : []),
    ...(diagnostic.exitCode !== undefined ? [`exit-code=${diagnostic.exitCode}`] : []),
    ...(diagnostic.probe !== undefined ? [`probe=${diagnostic.probe}`] : []),
  ].join(", ") : "";
  return restartMessages[event.reason] + (details ? ` (${details})` : "");
}

function initiatingFailureCode(message: string): string | null {
  for (const phase of ["initialization", "startup completion"] as const) {
    for (const category of RUNTIME_STARTUP_FAILURE_CATEGORIES) {
      if (message === categorizedRuntimeStartupFailureMessage(phase, category)) {
        return `startup-${phase === "initialization" ? "initialization" : "completion"}-${category}`;
      }
    }
  }
  if (isRuntimeStartupFailureMessage(message)) return "startup-failed";
  for (const reason of ["owned-process-tainted", "owned-process-cleanup-unconfirmed"] as const) {
    if (message === restartMessages[reason]) return reason;
  }
  if (!message.startsWith(restartMessages["owned-process-tainted"])) return null;
  const details = message.slice(restartMessages["owned-process-tainted"].length)
    .match(/^ \(stage=([a-z-]+)(?:, signal=([A-Za-z0-9]+))?(?:, exit-code=(\d{1,3}))?(?:, probe=([a-z-]+))?\)$/u);
  if (!details) return null;
  const diagnostic = parseRuntimeOwnedProcessDiagnostic({ stage: details[1],
    ...(details[2] !== undefined ? { signal: details[2] } : {}),
    ...(details[3] !== undefined ? { exitCode: Number(details[3]) } : {}),
    ...(details[4] !== undefined ? { probe: details[4] } : {}),
  });
  if (!diagnostic || runtimeRestartFailureMessage({
    type: "runtime.restart-requested", reason: "owned-process-tainted", diagnostic,
  }) !== message) return null;
  return `owned-process-tainted-${diagnostic.stage}`;
}

/** Accept only complete canonical messages built from validated fixed vocabularies. */
export function parseRuntimeFailureDiagnosticMessage(value: unknown): {
  initiatingCode: string | null;
  shutdownMessage: string | null;
} | null {
  if (typeof value !== "string" || value.length > 400) return null;
  for (const shutdown of [...Object.values(shutdownMessages), unknownShutdown]) {
    if (value === shutdown) return { initiatingCode: null, shutdownMessage: shutdown };
    if (!value.endsWith(` ${shutdown}`)) continue;
    const code = initiatingFailureCode(value.slice(0, -(shutdown.length + 1)));
    return code ? { initiatingCode: code, shutdownMessage: shutdown } : null;
  }
  const code = initiatingFailureCode(value);
  return code ? { initiatingCode: code, shutdownMessage: null } : null;
}

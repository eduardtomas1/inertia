/** Fixed lifecycle evidence only; never process output, arguments, or identities. */
export const OWNED_PROCESS_TAINT_STAGES = [
  "linux-guardian-monitor", "linux-admission", "linux-guardian-close",
  "linux-pid-spawn", "linux-pid-close", "darwin-guardian-close", "darwin-pid-close",
  "darwin-readiness", "darwin-durable-claim", "darwin-preauthorization-identity",
  "darwin-stop", "darwin-authorization",
] as const;

const GUARDIAN_CLOSE_SIGNALS = ["none", "SIGUSR2", "SIGKILL", "SIGTERM", "SIGINT", "other"] as const;

export interface RuntimeOwnedProcessDiagnostic {
  readonly stage: (typeof OWNED_PROCESS_TAINT_STAGES)[number];
  readonly signal?: (typeof GUARDIAN_CLOSE_SIGNALS)[number];
  readonly exitCode?: number;
}

export function parseRuntimeOwnedProcessDiagnostic(value: unknown): RuntimeOwnedProcessDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["stage", "signal", "exitCode"].includes(key))
    || !OWNED_PROCESS_TAINT_STAGES.includes(record.stage as RuntimeOwnedProcessDiagnostic["stage"])
    || (record.signal !== undefined && !GUARDIAN_CLOSE_SIGNALS.includes(record.signal as NonNullable<RuntimeOwnedProcessDiagnostic["signal"]>))
    || (record.exitCode !== undefined && (typeof record.exitCode !== "number"
      || !Number.isInteger(record.exitCode) || record.exitCode < 0 || record.exitCode > 255))) return null;
  return {
    stage: record.stage as RuntimeOwnedProcessDiagnostic["stage"],
    ...(record.signal !== undefined ? { signal: record.signal as RuntimeOwnedProcessDiagnostic["signal"] } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode as number } : {}),
  };
}

export function guardianCloseDiagnostic(
  stage: RuntimeOwnedProcessDiagnostic["stage"],
  signal: unknown,
  exitCode?: unknown,
): RuntimeOwnedProcessDiagnostic {
  return {
    stage,
    signal: signal === null || signal === 0 ? "none"
      : GUARDIAN_CLOSE_SIGNALS.includes(signal as NonNullable<RuntimeOwnedProcessDiagnostic["signal"]>)
        ? signal as NonNullable<RuntimeOwnedProcessDiagnostic["signal"]> : "other",
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
      ? { exitCode } : {}),
  };
}

export type RuntimeRestartReason = "owned-process-tainted" | "owned-process-cleanup-unconfirmed";

export interface RuntimeRestartRequestedEvent {
  readonly type: "runtime.restart-requested";
  readonly reason: RuntimeRestartReason;
  readonly diagnostic?: RuntimeOwnedProcessDiagnostic;
}

export function parseRuntimeRestartRequestedEvent(value: Record<string, unknown>): RuntimeRestartRequestedEvent | null {
  if (value.type !== "runtime.restart-requested"
    || Object.keys(value).some((key) => !["type", "reason", "diagnostic"].includes(key))
    || (value.reason !== "owned-process-tainted" && value.reason !== "owned-process-cleanup-unconfirmed")) return null;
  if (!Object.hasOwn(value, "diagnostic")) return { type: "runtime.restart-requested", reason: value.reason };
  const diagnostic = parseRuntimeOwnedProcessDiagnostic(value.diagnostic);
  return diagnostic && value.reason === "owned-process-tainted"
    ? { type: "runtime.restart-requested", reason: value.reason, diagnostic } : null;
}

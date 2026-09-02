const RUNTIME_SHUTDOWN_UNCONFIRMED_REASONS = [
  "incomplete-startup",
  "owned-process-cleanup",
  "runtime-close",
  "runtime-close-deadline",
] as const;

export type RuntimeShutdownUnconfirmedReason =
  typeof RUNTIME_SHUTDOWN_UNCONFIRMED_REASONS[number];

export interface RuntimeShutdownUnconfirmedEvent {
  type: "runtime.shutdown-unconfirmed";
  reason: RuntimeShutdownUnconfirmedReason;
}

export function validRuntimeShutdownUnconfirmedReason(
  value: unknown,
): value is RuntimeShutdownUnconfirmedReason {
  return typeof value === "string"
    && RUNTIME_SHUTDOWN_UNCONFIRMED_REASONS.some((reason) => reason === value);
}

export function parseRuntimeShutdownUnconfirmedEvent(
  value: unknown,
): RuntimeShutdownUnconfirmedEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.type !== "runtime.shutdown-unconfirmed"
    || Object.keys(record).length !== 2
    || !validRuntimeShutdownUnconfirmedReason(record.reason)
  ) return null;
  return { type: record.type, reason: record.reason };
}

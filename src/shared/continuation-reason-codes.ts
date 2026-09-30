export const CONTINUATION_REASON_CODES = [
  "first-turn",
  "same-continuation",
  "same-route-without-session",
  "supported-model-switch",
  "supported-performance-mode-switch",
  "missing-continuation-identity",
  "harness-changed",
  "backend-profile-changed",
  "backend-configuration-changed",
  "backend-endpoint-changed",
  "provider-installation-changed",
  "provider-installation-unverified",
  "incompatible-model-changed",
  "incompatible-performance-mode-changed",
  "stale-provider-session",
] as const;

export type ContinuationReasonCode =
  (typeof CONTINUATION_REASON_CODES)[number];

export function isContinuationReasonCode(
  value: unknown,
): value is ContinuationReasonCode {
  return typeof value === "string"
    && CONTINUATION_REASON_CODES.includes(value as ContinuationReasonCode);
}

export const CONTINUATION_COMPATIBILITY_REJECTION_REASON_CODES = [
  "missing-continuation-identity",
  "harness-changed",
  "backend-profile-changed",
  "backend-configuration-changed",
  "backend-endpoint-changed",
  "provider-installation-changed",
  "provider-installation-unverified",
  "incompatible-model-changed",
  "incompatible-performance-mode-changed",
  "stale-provider-session",
] as const satisfies readonly ContinuationReasonCode[];

/** Canonical classifier for reasons that prohibit hidden-session reuse. */
export function continuationRejectedForCompatibility(value: unknown): boolean {
  return typeof value === "string"
    && CONTINUATION_COMPATIBILITY_REJECTION_REASON_CODES.includes(
      value as (typeof CONTINUATION_COMPATIBILITY_REJECTION_REASON_CODES)[number],
    );
}

export interface TurnSessionRecovery {
  restoredMessageCount: number;
  omittedMessageCount: number;
}

export function isTurnSessionRecovery(value: unknown): value is TurnSessionRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const count = (input: unknown): boolean => typeof input === "number"
    && Number.isSafeInteger(input) && input >= 0 && input <= 1_002_000;
  return Object.keys(record).length === 2
    && count(record.restoredMessageCount)
    && count(record.omittedMessageCount);
}

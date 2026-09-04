export const RUNTIME_STARTUP_BLOCKER_CODES = [
  "prior-runtime-cleanup-unconfirmed",
  "provider-installation-quarantined",
] as const;

export type RuntimeStartupBlockerCode =
  (typeof RUNTIME_STARTUP_BLOCKER_CODES)[number];

export const RUNTIME_STARTUP_FAILURE_MESSAGES = [
  "The runtime received an invalid lifecycle command.",
  "The runtime was asked to start more than once.",
  "Runtime process ownership could not be initialized.",
  "The local runtime could not start.",
  "Runtime startup is blocked because prior process cleanup remains unconfirmed.",
  "Provider installation recovery requires manual attention.",
] as const;

export type RuntimeStartupFailureMessage =
  (typeof RUNTIME_STARTUP_FAILURE_MESSAGES)[number];

export interface RuntimeStartupFailureEvent {
  readonly type: "runtime.startup-failed";
  readonly message: RuntimeStartupFailureMessage;
  readonly blockerCode?: RuntimeStartupBlockerCode;
}

export function isRuntimeStartupBlockerCode(
  value: unknown,
): value is RuntimeStartupBlockerCode {
  return typeof value === "string"
    && RUNTIME_STARTUP_BLOCKER_CODES.includes(
      value as RuntimeStartupBlockerCode,
    );
}

export function isRuntimeStartupFailureMessage(
  value: unknown,
): value is RuntimeStartupFailureMessage {
  return typeof value === "string"
    && RUNTIME_STARTUP_FAILURE_MESSAGES.includes(
      value as RuntimeStartupFailureMessage,
    );
}

/** Parses the complete safe worker event so transport schemas cannot drift. */
export function parseRuntimeStartupFailureEvent(
  value: unknown,
): RuntimeStartupFailureEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join("|");
  if (keys !== "message|type" && keys !== "blockerCode|message|type") return null;
  const event = value as Partial<RuntimeStartupFailureEvent>;
  if (
    event.type !== "runtime.startup-failed"
    || !isRuntimeStartupFailureMessage(event.message)
    || (event.blockerCode !== undefined
      && !isRuntimeStartupBlockerCode(event.blockerCode))
  ) return null;
  return {
    type: event.type,
    message: event.message,
    ...(event.blockerCode ? { blockerCode: event.blockerCode } : {}),
  };
}

export function runtimeStartupFailureMessage(
  blockerCode: RuntimeStartupBlockerCode | null,
): RuntimeStartupFailureMessage {
  return blockerCode === "prior-runtime-cleanup-unconfirmed"
    ? "Runtime startup is blocked because prior process cleanup remains unconfirmed."
    : blockerCode === "provider-installation-quarantined"
      ? "Provider installation recovery requires manual attention."
      : "The local runtime could not start.";
}

/**
 * Carries one renderer-safe reason code across the worker boundary. The
 * human-readable error remains useful locally, while reports consume only the
 * closed vocabulary and never infer a reason from arbitrary failure text.
 */
export class RuntimeStartupBlockerError extends Error {
  readonly blockerCode: RuntimeStartupBlockerCode;

  constructor(blockerCode: RuntimeStartupBlockerCode, message: string) {
    super(message);
    this.name = "RuntimeStartupBlockerError";
    this.blockerCode = blockerCode;
  }
}

export function runtimeStartupBlockerCode(
  error: unknown,
): RuntimeStartupBlockerCode | null {
  return error instanceof RuntimeStartupBlockerError
    ? error.blockerCode
    : null;
}

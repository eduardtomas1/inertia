import type { ProviderActivityPhase, ProviderRunFailure } from "../provider/contracts";
import { objectValue, type JsonObject } from "./protocol";

export type CodexCommandOrPatchStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined";

export type CodexHookStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "stopped";

const ITEM_STATUS_PHASE = {
  inProgress: "started",
  completed: "completed",
  failed: "failed",
  declined: "failed",
} as const satisfies Record<
  CodexCommandOrPatchStatus,
  ProviderActivityPhase
>;

const HOOK_STATUS_PHASE = {
  running: "started",
  completed: "completed",
  failed: "failed",
  blocked: "failed",
  stopped: "failed",
} as const satisfies Record<CodexHookStatus, ProviderActivityPhase>;

export function codexItemActivityPhase(
  method: "item/started" | "item/completed",
  status: unknown,
): ProviderActivityPhase {
  if (isRecordKey(ITEM_STATUS_PHASE, status)) {
    return ITEM_STATUS_PHASE[status];
  }
  // Older fixture/server versions omitted status. Preserve the notification's
  // lifecycle meaning, while failing closed for a present unknown status.
  return status === undefined || status === null
    ? method === "item/started" ? "started" : "completed"
    : "failed";
}

export function codexHookActivityPhase(
  method: "hook/started" | "hook/completed",
  status: unknown,
): ProviderActivityPhase {
  if (isRecordKey(HOOK_STATUS_PHASE, status)) {
    return HOOK_STATUS_PHASE[status];
  }
  return status === undefined || status === null
    ? method === "hook/started" ? "started" : "completed"
    : "failed";
}

export function codexTurnInterruptionFailure(
  status: string | undefined,
  turnError: JsonObject | undefined,
  cancelRequested: boolean,
): Pick<ProviderRunFailure, "message" | "technicalDetail"> | undefined {
  // Guardian's strict circuit breaker carries its error on the interrupted
  // turn without a separate error notification. Earlier retry errors alone
  // do not turn a plain interruption into a provider failure.
  if (status !== "interrupted" || !turnError || cancelRequested) return undefined;
  const errorInfo = codexErrorInfoName(turnError.codexErrorInfo);
  return {
    message: errorInfo === "tooManyDenials"
      ? "Codex stopped the turn after repeated approval denials."
      : "Codex interrupted the turn before completion.",
    ...(errorInfo ? { technicalDetail: `Codex error: ${errorInfo}` } : {}),
  };
}

function codexErrorInfoName(value: unknown): string | undefined {
  const keys = Object.keys(objectValue(value) ?? {});
  const name = typeof value === "string" ? value : keys.length === 1 ? keys[0] : undefined;
  return name && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : undefined;
}

function isRecordKey<T extends object>(
  record: T,
  value: unknown,
): value is keyof T {
  return typeof value === "string" && Object.hasOwn(record, value);
}

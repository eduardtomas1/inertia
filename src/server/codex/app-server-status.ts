import type { ProviderActivityPhase } from "../provider/contracts";

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

function isRecordKey<T extends object>(
  record: T,
  value: unknown,
): value is keyof T {
  return typeof value === "string" && Object.hasOwn(record, value);
}

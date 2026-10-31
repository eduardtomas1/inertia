import { DUO_COMPARISON_STATES, DUO_DISPATCH_STATES, DUO_LAUNCH_STATES } from "./duo";
import {
  arrayOf,
  booleanField,
  integerFieldAtLeast,
  nullableStringField,
  oneOf,
  optionalBooleanField,
  record,
  recordWithStrings,
  stringField,
  type UnknownRecord,
} from "./server-event-fields";

function duoPreparedSide(value: unknown): boolean {
  return recordWithStrings(value, "conversationId", "turnId")
    && (value.ordinal === 0 || value.ordinal === 1);
}

function duoLaunchSide(value: unknown): boolean {
  return record(value)
    && (value.ordinal === 0 || value.ordinal === 1)
    && nullableStringField(value, "conversationId")
    && nullableStringField(value, "turnId")
    && oneOf(value, "dispatchState", DUO_DISPATCH_STATES);
}

function duoComparison(value: unknown): boolean {
  return record(value)
    && oneOf(value, "state", DUO_COMPARISON_STATES)
    && nullableStringField(value, "conversationId")
    && nullableStringField(value, "turnId")
    && integerFieldAtLeast(value, "attempt")
    && nullableStringField(value, "error");
}

function duoRecoveryAction(value: unknown): boolean {
  return recordWithStrings(value, "label", "cwd")
    && value.executable === "git"
    && arrayOf(value.args, (entry) => typeof entry === "string");
}

function duoRecoveryGuidance(value: unknown): boolean {
  return recordWithStrings(
    value,
    "repositoryPath",
    "plannedPath",
    "generatedBranch",
  )
    && value.kind === "git-worktree"
    && (value.ordinal === 0 || value.ordinal === 1)
    && oneOf(value, "topology", ["owned", "conflict", "ambiguous", "branch-retained"])
    && nullableStringField(value, "observedPath")
    && nullableStringField(value, "worktreeId")
    && nullableStringField(value, "expectedHead")
    && nullableStringField(value, "observedBranch")
    && nullableStringField(value, "observedHead")
    && arrayOf(value.actions, duoRecoveryAction);
}

function duoPrepared(value: UnknownRecord): boolean {
  return stringField(value, "launchId")
    && value.state === "prepared"
    && Array.isArray(value.sides)
    && value.sides.length === 2
    && value.sides[0]?.ordinal === 0
    && value.sides[1]?.ordinal === 1
    && value.sides.every(duoPreparedSide)
    && (value.comparison === undefined
      || recordWithStrings(value.comparison, "conversationId"));
}

function duoStatus(value: UnknownRecord): boolean {
  return stringField(value, "launchId") && oneOf(value, "state", DUO_LAUNCH_STATES)
    && optionalBooleanField(value, "cancelRequested")
    && nullableStringField(value, "error")
    && Array.isArray(value.sides)
    && value.sides.length === 2
    && value.sides[0]?.ordinal === 0
    && value.sides[1]?.ordinal === 1
    && value.sides.every(duoLaunchSide)
    && (value.comparison === undefined || duoComparison(value.comparison))
    && (value.recoveryGuidance === undefined
      || arrayOf(value.recoveryGuidance, duoRecoveryGuidance));
}

/** Request-result validators for duo launches at the renderer's server-event boundary. */
export const duoResultValidators = {
  "duo.pending": (value: UnknownRecord) =>
    arrayOf(value.launchIds, (entry) => typeof entry === "string")
    && new Set(value.launchIds as unknown[]).size === (value.launchIds as unknown[]).length
    && booleanField(value, "hasMore"),
  "duo.prepared": (value: UnknownRecord) => duoPrepared(value),
  "duo.status": (value: UnknownRecord) => duoStatus(value),
} as const;

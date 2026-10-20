import { activityExecutionCategory } from "../../../shared/activity-display";
import type { ProviderActivityEvent, ProviderEvent } from "../../provider/contracts";
import { agentActivityKind } from "../../runtime-snapshots";
import type { ReadOnlyWatcherViolationKind } from "./turn-controller-types";

export const READ_ONLY_WATCHER_STOP_MESSAGE = "Watchers are read-only. Inertia stopped this check.";
/** Denials tolerated in one watcher turn before Inertia stops it. */
export const READ_ONLY_WATCHER_MAX_DENIALS = 2;

const MAX_DETAIL_CHARS = 200;

type ApprovalRequest = Extract<ProviderEvent, { type: "approval" }>["request"];

/** Bounded single-line display text for a provider-supplied title. */
export function readOnlyViolationDetail(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim() || "a provider action";
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}…` : line;
}

/**
 * A started activity that edits, creates or deletes files. Commands are not
 * stopped here: the provider's own read-only gate governs them.
 */
export function isReadOnlyWriteActivity(event: ProviderActivityEvent): boolean {
  if (event.phase !== "started") return false;
  const kind = agentActivityKind(event);
  if (kind === "command") return false;
  return activityExecutionCategory({ kind, title: event.label, status: "running" }) === "coding";
}

export function readOnlyApprovalViolationKind(request: ApprovalRequest): ReadOnlyWatcherViolationKind {
  if (request.kind === "file-change") return "write-attempt";
  if (request.kind === "permissions" && request.permissionRoots.some(({ access }) => access === "write")) {
    return "write-attempt";
  }
  return "command-attempt";
}

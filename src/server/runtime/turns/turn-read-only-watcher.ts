import { activityExecutionCategory } from "../../../shared/activity-display";
import type { ProviderActivityEvent, ProviderEvent } from "../../provider/contracts";
import { agentActivityKind } from "../../runtime-snapshots";
import type { ReadOnlyWatcherViolationKind } from "./turn-controller-types";

export const READ_ONLY_WATCHER_STOP_MESSAGE = "Watchers are read-only. Inertia stopped this check.";
export const READ_ONLY_WATCHER_MAX_DENIALS = 2;

const MAX_DETAIL_CHARS = 200;
const MULTI_EDIT_TOOL_PATTERN = /^multi[\s_-]?edit$/iu;

type ApprovalRequest = Extract<ProviderEvent, { type: "approval" }>["request"];

export function readOnlyViolationDetail(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim() || "a provider action";
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}…` : line;
}

export function isReadOnlyWriteActivity(event: ProviderActivityEvent): boolean {
  if (event.phase !== "started") return false;
  const kind = agentActivityKind(event);
  if (kind === "command") return false;
  if (kind === "tool" && MULTI_EDIT_TOOL_PATTERN.test(event.label.trim())) return true;
  return activityExecutionCategory({ kind, title: event.label, status: "running" }) === "coding";
}

export function readOnlyApprovalViolationKind(request: ApprovalRequest): ReadOnlyWatcherViolationKind {
  if (request.kind === "file-change") return "write-attempt";
  if (request.kind === "permissions" && request.permissionRoots.some(({ access }) => access === "write")) {
    return "write-attempt";
  }
  return "command-attempt";
}

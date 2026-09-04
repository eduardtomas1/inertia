import type {
  PermissionOption,
  RequestPermissionRequest,
  ToolKind,
} from "@agentclientprotocol/sdk";

import { isSafeApprovalDisplayText } from "./approval-display";

export function cursorPermissionDisplayIsSafe(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  return isSafeApprovalDisplayText(
    params.toolCall.title || "Cursor requested permission",
  ) && isSafeApprovalDisplayText(jsonSummary(params.toolCall.rawInput), true);
}

export function isCursorFileMutationKind(
  kind: ToolKind | null | undefined,
): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

export function cursorOneShotPermissionOption(
  options: PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  // Inertia's provider-neutral approval only represents this request. Never
  // turn it into a provider-persisted grant or denial without an explicit UI
  // choice for that stronger scope.
  const kind = allow ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === kind);
}

function jsonSummary(value: unknown): string {
  try {
    return value === undefined
      ? "Cursor requested permission."
      : JSON.stringify(value);
  } catch {
    return "Cursor requested permission.";
  }
}

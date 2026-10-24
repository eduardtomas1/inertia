import type { ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";

import type { ProviderRunInput } from "./contracts";

export const ACP_WATCHER_QUESTION_DECLINED = "Declined a question: watchers can't ask the user questions during a check";
export const ACP_WATCHER_PLAN_DECLINED = "Declined the plan hand-off: a watcher answers in its reply";

export function acpReadOnlyWatcher(input: Pick<ProviderRunInput, "readOnlyProfile">): boolean {
  return input.readOnlyProfile === "watcher";
}

export function acpFileMutation(
  kind: ToolKind | null | undefined,
  status: ToolCallStatus | null | undefined,
): { fileMutation?: true } {
  const mutation = kind === "edit" || kind === "delete" || kind === "move";
  return mutation && status === "in_progress" ? { fileMutation: true } : {};
}

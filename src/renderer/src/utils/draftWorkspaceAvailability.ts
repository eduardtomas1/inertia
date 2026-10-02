const UNAVAILABLE_REASON =
  "Workspace tools are available after the first message creates this chat's workspace.";

export function draftWorkspaceToolsUnavailableReason(
  requiresMaterialization: boolean,
): string | null {
  return requiresMaterialization ? UNAVAILABLE_REASON : null;
}

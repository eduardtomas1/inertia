import type { WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";

export interface AttentionVisibilityContext {
  documentVisible: boolean;
  documentFocused: boolean;
  workspaceVisible: boolean;
  latestContentVisible: boolean;
  obstructed: boolean;
}

export function workspaceAttentionObstructed(input: {
  paletteOpen: boolean;
  commitDialogOpen: boolean;
  authProviderOpen: boolean;
  multiSpawnOpen: boolean;
  mobileSidebarOpen: boolean;
}): boolean {
  return input.paletteOpen
    || input.commitDialogOpen
    || input.authProviderOpen
    || input.multiSpawnOpen
    || input.mobileSidebarOpen;
}

/**
 * Visibility is deliberately renderer-owned: server selection alone is not
 * evidence that the user saw a result. The transcript must be the focused,
 * unobstructed workspace and its latest content must be in view.
 */
export function shouldMarkWorkspaceRunSeen(
  run: WorkspaceRun,
  visibleConversationId: string | null,
  context: AttentionVisibilityContext,
): boolean {
  return run.kind === "agent"
    && run.conversationId !== null
    && run.conversationId === visibleConversationId
    && workspaceRunAttentionView(run).canMarkSeen
    && context.documentVisible
    && context.documentFocused
    && context.workspaceVisible
    && context.latestContentVisible
    && !context.obstructed;
}

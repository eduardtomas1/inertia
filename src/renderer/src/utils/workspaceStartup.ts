import type { WorkspacePanelTab } from "../components/workspacePanelTypes";
import { isRightPanelSurface, isWorkspaceBoundSurface } from "./rightPanelSurfaces";

export const LAST_WORKSPACE_TOOL_KEY = "inertia:layout:last-workspace-tool:v2";

export function workspacePanelTab(value: string | null): WorkspacePanelTab | null {
  return isRightPanelSurface(value) ? value : null;
}

export function forgetWorkspaceBoundLastTool(
  storage: Pick<Storage, "getItem" | "removeItem">,
): void {
  const stored = storage.getItem(LAST_WORKSPACE_TOOL_KEY);
  const tool = workspacePanelTab(stored);
  // An unknown value, such as a terminal tab from before it docked, is stale.
  if (stored !== null && (tool === null || isWorkspaceBoundSurface(tool))) {
    storage.removeItem(LAST_WORKSPACE_TOOL_KEY);
  }
}

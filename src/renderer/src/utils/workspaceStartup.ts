import type { WorkspacePanelTab } from "../components/workspacePanelTypes";
import { isRightPanelSurface, isWorkspaceBoundSurface } from "./rightPanelSurfaces";
import type { WorkspaceStartupSurface } from "@shared/contracts";

export type { WorkspaceStartupSurface } from "@shared/contracts";

const LEGACY_ACTIVE_TOOL_KEY = "inertia:layout:active-tool:v1";
const LEGACY_MIGRATED_KEY = "inertia:layout:startup-surface-migrated:v1";
export const LAST_WORKSPACE_TOOL_KEY = "inertia:layout:last-workspace-tool:v2";

export interface LegacyWorkspaceStartupPreference {
  surface: WorkspaceStartupSurface;
  tool: WorkspacePanelTab | null;
}

export function workspacePanelTab(value: string | null): WorkspacePanelTab | null {
  return isRightPanelSurface(value) ? value : null;
}

export function readLegacyWorkspaceStartup(
  storage: Pick<Storage, "getItem">,
): LegacyWorkspaceStartupPreference | null {
  if (storage.getItem(LEGACY_MIGRATED_KEY) === "true") return null;
  const legacy = storage.getItem(LEGACY_ACTIVE_TOOL_KEY);
  if (legacy === null) return null;
  const tool = workspacePanelTab(legacy);
  return {
    surface: tool ? "tools" : "summary",
    tool,
  };
}

export function forgetWorkspaceBoundLastTool(
  storage: Pick<Storage, "getItem" | "removeItem">,
): void {
  if (isWorkspaceBoundSurface(workspacePanelTab(storage.getItem(LAST_WORKSPACE_TOOL_KEY)))) {
    storage.removeItem(LAST_WORKSPACE_TOOL_KEY);
  }
}

export function finishLegacyWorkspaceStartupMigration(
  storage: Pick<Storage, "setItem" | "removeItem">,
  preference: LegacyWorkspaceStartupPreference,
): void {
  if (preference.tool) storage.setItem(LAST_WORKSPACE_TOOL_KEY, preference.tool);
  storage.setItem(LEGACY_MIGRATED_KEY, "true");
  storage.removeItem(LEGACY_ACTIVE_TOOL_KEY);
}

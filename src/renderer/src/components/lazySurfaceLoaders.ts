import type { WorkspacePanelTab } from "./workspacePanelTypes";
import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadCommandPalette = createSurfaceLoader(async () => ({
  default: (await import("./CommandPalette")).CommandPalette,
}));
export const loadCommitDialog = createSurfaceLoader(() => import("./CommitDialog"));
export const loadDailyWorkDialog = createSurfaceLoader(() => import("./DailyWorkDialog"));
export const loadEnvironmentPanel = createSurfaceLoader(() => import("./EnvironmentPanel"));
export const loadFilesPanel = createSurfaceLoader(() => import("./FilesPanel"));
export const loadGoalPanel = createSurfaceLoader(() => import("./GoalPanel"));
export const loadHistoricalDiffPanel = createSurfaceLoader(() => import("./HistoricalDiffPanel"));
export const loadMultiSpawnDialog = createSurfaceLoader(() => import("./MultiSpawnDialog"));
export const loadPlanPanel = createSurfaceLoader(() => import("./PlanPanel"));
export const loadPreMergeConfidenceLauncher = createSurfaceLoader(
  () => import("./PreMergeConfidenceLauncher"),
);
export const loadPreviewPanel = createSurfaceLoader(() => import("./PreviewPanel"));
export const loadProviderAuthDialog = createSurfaceLoader(() => import("./ProviderAuthDialog"));
export const loadSettingsView = createSurfaceLoader(async () => ({
  default: (await import("./SettingsView")).SettingsView,
}));
export const loadUsageView = createSurfaceLoader(() => import("./UsageView"));
export const loadTerminalPanel = createSurfaceLoader(() => import("./TerminalPanel"));
export const loadWorkspaceChangesPanel = createSurfaceLoader(() => import("./WorkspaceChangesPanel"));

const frequentSurfaceLoads = [
  loadCommandPalette,
  loadDailyWorkDialog,
  loadSettingsView,
] as const;

export function prefetchFrequentSurfaces(): void {
  for (const load of frequentSurfaceLoads) void load();
}

export function prefetchWorkspaceTool(tab: WorkspacePanelTab): void {
  if (tab === "environment") {
    return;
  } else if (tab === "changes") {
    void loadWorkspaceChangesPanel();
    void loadHistoricalDiffPanel();
    void loadPreMergeConfidenceLauncher();
  } else if (tab === "files") {
    void loadFilesPanel();
  } else if (tab === "terminal") {
    void loadTerminalPanel();
  } else if (tab === "goal") {
    void loadGoalPanel();
  } else if (tab === "plan") {
    void loadPlanPanel();
  } else if (tab === "preview") {
    void loadPreviewPanel();
  }
}

export function scheduleFrequentSurfacePrefetch(): () => void {
  const requestIdle = window.requestIdleCallback;
  const cancelIdle = window.cancelIdleCallback;
  let finished = false;
  let idleHandle: number | null = null;
  let timeoutHandle: number | null = null;
  const run = (): void => {
    if (finished) return;
    finished = true;
    prefetchFrequentSurfaces();
  };
  if (typeof requestIdle === "function" && typeof cancelIdle === "function") {
    idleHandle = requestIdle(run, {
      timeout: 750,
    });
  }
  // Chromium may keep requestIdleCallback pending during startup observers or
  // animation work. The same bounded timer guarantees the frequent overlays
  // and lightweight settings shell are ready without pulling in heavyweight
  // settings sections or workspace tools.
  timeoutHandle = window.setTimeout(run, 750);
  return () => {
    finished = true;
    if (idleHandle !== null && typeof cancelIdle === "function") {
      cancelIdle(idleHandle);
    }
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
  };
}

import type { WorkspacePanelTab } from "./workspacePanelTypes";

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= load();
    return promise;
  };
}

export const loadActivityCenter = once(() => import("./ActivityCenter"));
export const loadCommandPalette = once(() => import("./CommandPalette"));
export const loadCommitDialog = once(() => import("./CommitDialog"));
export const loadFilesPanel = once(() => import("./FilesPanel"));
export const loadGoalPanel = once(() => import("./GoalPanel"));
export const loadHistoricalDiffPanel = once(() => import("./HistoricalDiffPanel"));
export const loadMultiSpawnDialog = once(() => import("./MultiSpawnDialog"));
export const loadPlanPanel = once(() => import("./PlanPanel"));
export const loadPreviewPanel = once(() => import("./PreviewPanel"));
export const loadProviderAuthDialog = once(() => import("./ProviderAuthDialog"));
export const loadSettingsView = once(() => import("./SettingsView"));
export const loadTerminalPanel = once(() => import("./TerminalPanel"));
export const loadWorkspaceChangesPanel = once(() => import("./WorkspaceChangesPanel"));

const frequentSurfaceLoads = [
  loadActivityCenter,
  loadCommandPalette,
] as const;

export function prefetchFrequentSurfaces(): void {
  for (const load of frequentSurfaceLoads) void load();
}

export function prefetchWorkspaceTool(tab: WorkspacePanelTab): void {
  if (tab === "changes") {
    void loadWorkspaceChangesPanel();
    void loadHistoricalDiffPanel();
  } else if (tab === "files") {
    void loadFilesPanel();
  } else if (tab === "terminal") {
    void loadTerminalPanel();
  } else if (tab === "goal") {
    void loadGoalPanel();
  } else if (tab === "plan") {
    void loadPlanPanel();
  } else {
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
  // animation work. The same bounded timer guarantees the two tiny overlay
  // chunks are prefetched without extending this to heavyweight workspace
  // tools.
  timeoutHandle = window.setTimeout(run, 750);
  return () => {
    finished = true;
    if (idleHandle !== null && typeof cancelIdle === "function") {
      cancelIdle(idleHandle);
    }
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
  };
}

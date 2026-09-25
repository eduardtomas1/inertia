import type { WorkspacePanelTab } from "./workspacePanelTypes";
import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadCommandPalette = createSurfaceLoader(async () => ({
  default: (await import("./CommandPalette")).CommandPalette,
}));
export const loadCommitDialog = createSurfaceLoader(() => import("./CommitDialog"));
export const loadConversationSplitView = createSurfaceLoader(() => import("./ConversationSplitView"));
export const loadDailyWorkDialog = createSurfaceLoader(() => import("./DailyWorkDialog"));
export const loadAttachmentsSurface = createSurfaceLoader(() => import("./AttachmentsSurface"));
export const loadAgentsSurface = createSurfaceLoader(() => import("./AgentsSurface"));
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
export const loadUsageSurface = createSurfaceLoader(() => import("./UsageSurface"));
export const loadUsageView = createSurfaceLoader(() => import("./UsageView"));
export const loadWorkspaceTerminal = createSurfaceLoader(() => import("./WorkspaceTerminal"));
export const loadTerminalPanel = createSurfaceLoader(() => import("./TerminalPanel"));
export const loadWorkspaceChangesPanel = createSurfaceLoader(() => import("./WorkspaceChangesPanel"));
export const loadWelcomeGuide = createSurfaceLoader(() => import("./welcome-guide/WelcomeGuide"));

const frequentSurfaceLoads = [
  loadCommandPalette,
  loadConversationSplitView,
  loadDailyWorkDialog,
  loadSettingsView,
] as const;

export function prefetchFrequentSurfaces(): void {
  for (const load of frequentSurfaceLoads) void load();
}

export function prefetchWorkspaceTool(tab: WorkspacePanelTab): void {
  if (tab === "terminal") {
    void loadWorkspaceTerminal();
    void loadTerminalPanel();
  } else if (tab === "attachments") {
    void loadAttachmentsSurface();
  } else if (tab === "usage") {
    void loadUsageSurface();
  } else if (tab === "agents") {
    void loadAgentsSurface();
  } else if (tab === "changes") {
    void loadWorkspaceChangesPanel();
    void loadHistoricalDiffPanel();
    void loadPreMergeConfidenceLauncher();
  } else if (tab === "files") {
    void loadFilesPanel();
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

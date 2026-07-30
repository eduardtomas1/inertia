import type {
  AppSnapshot,
  Conversation,
  Project,
  WorkspaceRun,
} from "@shared/contracts";
import { lazy, Suspense } from "react";

import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { WorkspacePanelTab } from "./WorkspacePanel";

const ActivityCenter = lazy(async () => ({
  default: (await import("./ActivityCenter")).ActivityCenter,
}));
const CommandPalette = lazy(async () => ({
  default: (await import("./CommandPalette")).CommandPalette,
}));

interface AppNavigationOverlaysProps {
  snapshot: AppSnapshot | null;
  activityOpen: boolean;
  paletteOpen: boolean;
  setActivityOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setWorkspaceView: () => void;
  selectProject: (project: Project) => void;
  selectConversation: (conversation: Conversation) => void;
  createConversation: () => void;
  importProject: () => Promise<void>;
  activateActivityContext: (
    run: WorkspaceRun,
    tool?: WorkspacePanelTab,
  ) => void;
  openActivityLocation: (run: WorkspaceRun) => void;
  openActivityPreview: (run: WorkspaceRun) => void;
  stopActivity: (run: WorkspaceRun) => void;
  rerunActivity: (run: WorkspaceRun) => void;
  markActivitySeen: (run: WorkspaceRun) => void;
  acknowledgeActivity: (run: WorkspaceRun) => void;
  dismissActivity: (run: WorkspaceRun) => void;
  openSettings: () => void;
}

export function AppNavigationOverlays({
  snapshot,
  activityOpen,
  paletteOpen,
  setActivityOpen,
  setPaletteOpen,
  setWorkspaceView,
  selectProject,
  selectConversation,
  createConversation,
  importProject,
  activateActivityContext,
  openActivityLocation,
  openActivityPreview,
  stopActivity,
  rerunActivity,
  markActivitySeen,
  acknowledgeActivity,
  dismissActivity,
  openSettings,
}: AppNavigationOverlaysProps): React.JSX.Element {
  // Suspend the native preview from the always-loaded shell. Waiting for an
  // overlay's lazy chunk to mount would briefly place untrusted native content
  // above the trusted Runs or command-palette surface.
  useNativePreviewSuspension(activityOpen || paletteOpen);
  const projects = snapshot?.projects ?? [];
  const conversations = snapshot?.conversations ?? [];
  return (
    <>
      {activityOpen && (
        <Suspense fallback={null}>
          <ActivityCenter
            open
            runs={snapshot?.runs ?? []}
            projects={projects}
            conversations={conversations}
            onClose={() => setActivityOpen(false)}
            onOpenThread={(thread) => {
              selectConversation(thread);
              setWorkspaceView();
              setActivityOpen(false);
            }}
            onOpenLocation={openActivityLocation}
            onOpenTerminal={(run) => {
              activateActivityContext(run, "terminal");
              setActivityOpen(false);
            }}
            onOpenPreview={openActivityPreview}
            onStop={stopActivity}
            onRerun={rerunActivity}
            onMarkSeen={markActivitySeen}
            onAcknowledge={acknowledgeActivity}
            onDismiss={dismissActivity}
          />
        </Suspense>
      )}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open
            projects={projects}
            conversations={conversations}
            onClose={() => setPaletteOpen(false)}
            onSelectProject={(project) => {
              selectProject(project);
              setWorkspaceView();
            }}
            onSelectConversation={(conversation) => {
              selectConversation(conversation);
              setWorkspaceView();
            }}
            onNewThread={createConversation}
            onAddProject={() => void importProject()}
            onOpenSettings={openSettings}
          />
        </Suspense>
      )}
    </>
  );
}

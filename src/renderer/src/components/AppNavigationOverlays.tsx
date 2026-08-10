import type {
  AppSnapshot,
  Conversation,
  Project,
  WorkspaceRun,
} from "@shared/contracts";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { WorkspacePanelTab } from "./WorkspacePanel";
import { loadActivityCenter, loadCommandPalette } from "./lazySurfaceLoaders";
import { LoadingMark } from "./ui";

function ActivityLoadingShell(): React.JSX.Element {
  return (
    <div className="activity-center-backdrop" role="presentation">
      <section className="activity-center overlay-loading-shell" aria-busy="true">
        <LoadingMark label="Loading runs" />
      </section>
    </div>
  );
}

function PaletteLoadingShell(): React.JSX.Element {
  return (
    <div className="palette-backdrop" role="presentation">
      <section className="command-palette overlay-loading-shell" aria-busy="true">
        <LoadingMark label="Loading search" />
      </section>
    </div>
  );
}

interface AppNavigationOverlaysProps {
  snapshot: AppSnapshot | null;
  activityOpen: boolean;
  paletteOpen: boolean;
  newThreadShortcut: string;
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
  newThreadShortcut,
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
  const ActivityCenter = useLoadedSurface(loadActivityCenter, activityOpen);
  const CommandPalette = useLoadedSurface(loadCommandPalette, paletteOpen);
  return (
    <>
      {activityOpen && (
        ActivityCenter ? (
          <ActivityCenter
            open
            runs={snapshot?.runs ?? []}
            projects={projects}
            conversations={conversations}
            providerIdentityLabels={snapshot?.settings.providerIdentityLabels}
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
        ) : <ActivityLoadingShell />
      )}
      {paletteOpen && (
        CommandPalette ? (
          <CommandPalette
            open
            projects={projects}
            conversations={conversations}
            newThreadShortcut={newThreadShortcut}
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
        ) : <PaletteLoadingShell />
      )}
    </>
  );
}

import type {
  AppSnapshot,
  Conversation,
  Project,
  WorkspaceRun,
} from "@shared/contracts";

import type { WorkspacePanelTab } from "./WorkspacePanel";
import { ActivityCenter } from "./ActivityCenter";
import { CommandPalette } from "./CommandPalette";

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
  const projects = snapshot?.projects ?? [];
  const conversations = snapshot?.conversations ?? [];
  return (
    <>
      <ActivityCenter
        open={activityOpen}
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
      <CommandPalette
        open={paletteOpen}
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
    </>
  );
}

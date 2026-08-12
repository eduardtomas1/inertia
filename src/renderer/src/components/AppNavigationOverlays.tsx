import type {
  AppSnapshot,
  Conversation,
  Project,
} from "@shared/contracts";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { loadCommandPalette } from "./lazySurfaceLoaders";
import { LoadingMark } from "./ui";

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
  paletteOpen: boolean;
  newThreadShortcut: string;
  setPaletteOpen: (open: boolean) => void;
  setWorkspaceView: () => void;
  selectProject: (project: Project) => void;
  selectConversation: (conversation: Conversation) => void;
  createConversation: () => void;
  importProject: () => Promise<void>;
  openSettings: () => void;
}

export function AppNavigationOverlays({
  snapshot,
  paletteOpen,
  newThreadShortcut,
  setPaletteOpen,
  setWorkspaceView,
  selectProject,
  selectConversation,
  createConversation,
  importProject,
  openSettings,
}: AppNavigationOverlaysProps): React.JSX.Element {
  // Suspend the native preview from the always-loaded shell. Waiting for the
  // palette's lazy chunk to mount would briefly place untrusted native content
  // above the trusted command-palette surface.
  useNativePreviewSuspension(paletteOpen);
  const projects = snapshot?.projects ?? [];
  const conversations = snapshot?.conversations ?? [];
  const CommandPalette = useLoadedSurface(loadCommandPalette, paletteOpen);
  return (
    <>
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

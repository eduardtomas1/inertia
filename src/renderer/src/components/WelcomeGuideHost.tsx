import { lazy, Suspense, useCallback, useEffect, useSyncExternalStore } from "react";
import type { AppSnapshot, ProviderId } from "@shared/contracts";

import {
  closeWelcomeGuide,
  markWelcomeGuideSeen,
  openWelcomeGuide,
  readWelcomeGuideSeen,
  subscribeWelcomeGuide,
  welcomeGuideGate,
  welcomeGuideIsOpen,
  type WelcomeShortcut,
} from "../utils/welcomeGuide";
import { useHelpGuideOpen } from "../hooks/useHelpGuideOpen";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { DialogPresence, useDialogPresence } from "./DialogPresence";
import { loadWelcomeGuide } from "./lazySurfaceLoaders";

const WelcomeGuide = lazy(async () => ({
  default: (await loadWelcomeGuide()).WelcomeGuide,
}));

export function WelcomeGuideHost({
  snapshot,
  blocked,
  existingProfile,
  shortcuts,
  onOpenProviderSetup,
  onAddProject,
}: {
  snapshot: AppSnapshot | null;
  blocked: boolean;
  existingProfile: boolean;
  shortcuts: WelcomeShortcut[];
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onAddProject: () => void;
}): React.JSX.Element {
  const open = useSyncExternalStore(subscribeWelcomeGuide, welcomeGuideIsOpen);
  const helpOpen = useHelpGuideOpen();
  const projectCount = snapshot
    ? snapshot.projects.filter(({ workspaceKind }) => workspaceKind !== "scratch").length
    : null;
  useNativePreviewSuspension(useDialogPresence(open));

  useEffect(() => {
    const gate = welcomeGuideGate({
      seen: readWelcomeGuideSeen(window.localStorage),
      projectCount,
      blocked: blocked || helpOpen,
      existingProfile,
    });
    if (gate === "open") openWelcomeGuide();
    if (gate === "mark-seen") markWelcomeGuideSeen(window.localStorage);
  }, [blocked, existingProfile, helpOpen, projectCount]);

  const close = useCallback(() => {
    markWelcomeGuideSeen(window.localStorage);
    closeWelcomeGuide();
  }, []);

  return (
    <DialogPresence open={open}>
      <Suspense fallback={null}>
        <WelcomeGuide
          providers={snapshot?.providers ?? []}
          shortcuts={shortcuts}
          onClose={close}
          onOpenProviderSetup={(providerId) => {
            close();
            onOpenProviderSetup(providerId);
          }}
          onAddProject={() => {
            close();
            onAddProject();
          }}
        />
      </Suspense>
    </DialogPresence>
  );
}

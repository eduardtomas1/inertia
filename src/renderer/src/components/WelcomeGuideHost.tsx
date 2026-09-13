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
import { DialogPresence } from "./DialogPresence";
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
  const projectCount = snapshot ? snapshot.projects.length : null;

  useEffect(() => {
    const gate = welcomeGuideGate({
      seen: readWelcomeGuideSeen(window.localStorage),
      projectCount,
      blocked,
      existingProfile,
    });
    if (gate === "open") openWelcomeGuide();
    if (gate === "mark-seen") markWelcomeGuideSeen(window.localStorage);
  }, [blocked, existingProfile, projectCount]);

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

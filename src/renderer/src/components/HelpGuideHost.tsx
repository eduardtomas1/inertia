import { useEffect, useLayoutEffect, useState } from "react";
import type { AppShortcutAction } from "@shared/keybindings";

import { useHelpGuideOpen } from "../hooks/useHelpGuideOpen";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { closeHelpGuide, settleHelpGuideRequest } from "../utils/helpGuide";
import { DialogPresence, useDialogPresence } from "./DialogPresence";
import { loadWelcomeGuide } from "./lazySurfaceLoaders";
import type { SettingsTarget } from "../lib/settingsTarget";
import type { HelpCommand } from "./welcome-guide/helpTopics";

export function HelpGuideHost({
  shortcutLabel,
  commands,
  onOpenSettings,
  onLeave,
  onLoadError,
}: {
  shortcutLabel: (action: AppShortcutAction) => string;
  commands: Record<HelpCommand, () => void>;
  onOpenSettings: (target: SettingsTarget) => void;
  onLeave: () => void;
  onLoadError: (message: string) => void;
}): React.JSX.Element {
  const open = useHelpGuideOpen();
  const [session, setSession] = useState({ open, id: 0 });
  const [, setLoads] = useState(0);
  const HelpGuide = loadWelcomeGuide.peek()?.HelpGuide ?? null;
  const present = useDialogPresence(open);
  useNativePreviewSuspension(present);
  useLayoutEffect(() => {
    if (present) settleHelpGuideRequest();
  }, [present]);
  useEffect(() => {
    if (!open || HelpGuide) return;
    let current = true;
    void loadWelcomeGuide().then(
      () => {
        if (current) setLoads((loads) => loads + 1);
      },
      () => {
        if (!current) return;
        closeHelpGuide();
        onLoadError("Help could not be loaded. Try again.");
      },
    );
    return () => {
      current = false;
    };
  }, [HelpGuide, onLoadError, open]);
  if (session.open !== open) setSession({ open, id: open ? session.id + 1 : session.id });
  return (
    <DialogPresence open={open}>
      {HelpGuide && (
        <HelpGuide
          key={session.id}
          shortcutLabel={shortcutLabel}
          onClose={closeHelpGuide}
          onCommand={(command) => {
            onLeave();
            commands[command]();
          }}
          onOpenSettings={(target) => {
            onLeave();
            onOpenSettings(target);
          }}
        />
      )}
    </DialogPresence>
  );
}

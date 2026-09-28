import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import type { AppShortcutAction } from "@shared/keybindings";

import { closeHelpGuide, helpGuideIsOpen, subscribeHelpGuide } from "../utils/helpGuide";
import { DialogPresence } from "./DialogPresence";
import { loadWelcomeGuide } from "./lazySurfaceLoaders";
import type { SettingsSection } from "./settingsSections";
import type { HelpCommand } from "./welcome-guide/helpTopics";

const HelpGuide = lazy(async () => ({
  default: (await loadWelcomeGuide()).HelpGuide,
}));

export function HelpGuideHost({
  shortcutLabel,
  commands,
  onOpenSettings,
  onLeave,
}: {
  shortcutLabel: (action: AppShortcutAction) => string;
  commands: Record<HelpCommand, () => void>;
  onOpenSettings: (section: SettingsSection) => void;
  onLeave: () => void;
}): React.JSX.Element {
  const open = useSyncExternalStore(subscribeHelpGuide, helpGuideIsOpen);
  const [session, setSession] = useState({ open, id: 0 });
  if (session.open !== open) setSession({ open, id: open ? session.id + 1 : session.id });
  return (
    <DialogPresence open={open}>
      <Suspense fallback={null}>
        <HelpGuide
          key={session.id}
          shortcutLabel={shortcutLabel}
          onClose={closeHelpGuide}
          onCommand={(command) => {
            onLeave();
            commands[command]();
          }}
          onOpenSettings={(section) => {
            onLeave();
            onOpenSettings(section);
          }}
        />
      </Suspense>
    </DialogPresence>
  );
}

import { RotateCcw } from "lucide-react";

import type { AppSettings } from "@shared/contracts";
import { defaultSettings } from "@shared/contracts/app";
import { parseCompletionSoundSettings } from "@shared/completion-sound";
import { SettingStatus } from "./SettingsLayout";
import { useSettingAction } from "./useSettingAction";

export const RESTORE_DEFAULTS_CONFIRMATION = "Restore every setting to its default? Keybindings, provider labels, the Codex binary path, and the default provider and model are reset too. Imported completion sounds are kept.";

export function RestoreDefaults({
  completionSound,
  confirmDestructiveActions,
  disabled,
  onUpdate,
}: {
  completionSound: AppSettings["completionSound"];
  confirmDestructiveActions: boolean;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const restore = (): void => {
    if (confirmDestructiveActions && !window.confirm(RESTORE_DEFAULTS_CONFIRMATION)) return;
    void action.run(() => onUpdate({
      ...defaultSettings,
      completionSound: {
        ...defaultSettings.completionSound,
        library: parseCompletionSoundSettings(completionSound).library,
      },
    }), { success: "Defaults restored." });
  };
  return (
    <div className="settings-toolbar" data-setting-id="restore-defaults">
      <SettingStatus notice={action.notice} />
      <button type="button" className="secondary-button" disabled={disabled} onClick={restore}>
        <RotateCcw size={14} />Restore defaults
      </button>
    </div>
  );
}

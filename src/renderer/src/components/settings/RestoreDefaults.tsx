import { RotateCcw } from "lucide-react";

import { RESTORE_DEFAULTS_CONFIRMATION, RESTORE_DEFAULTS_SCOPE } from "@shared/restore-defaults";
import { SettingActionRow } from "./SettingsLayout";
import { useSettingAction } from "./useSettingAction";

export function RestoreDefaults({
  confirmDestructiveActions,
  disabled,
  onRestoreDefaults,
}: {
  confirmDestructiveActions: boolean;
  disabled: boolean;
  onRestoreDefaults: () => Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const restore = (): void => {
    if (action.busy) return;
    if (confirmDestructiveActions && !window.confirm(RESTORE_DEFAULTS_CONFIRMATION)) return;
    void action.run(onRestoreDefaults, { exclusive: true, success: "Defaults restored." });
  };
  return (
    <SettingActionRow
      id="restore-defaults"
      className="runtime-log-setting"
      title="Restore defaults"
      description={RESTORE_DEFAULTS_SCOPE}
      notice={action.notice}
      actions={(
        <button type="button" className="secondary-button" disabled={disabled} aria-disabled={action.busy || undefined} onClick={restore}>
          <RotateCcw size={14} />Restore defaults
        </button>
      )}
    />
  );
}

import { useLayoutEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { RESTORE_DEFAULTS_SCOPE } from "@shared/restore-defaults";
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
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  const close = (): void => {
    setConfirming(false);
    trigger.current?.focus();
  };
  const restore = (): void => {
    if (action.busy) return;
    close();
    void action.run(onRestoreDefaults, { exclusive: true, success: "Defaults restored." });
  };
  return (
    <>
      <SettingActionRow
        id="restore-defaults"
        className="runtime-log-setting"
        title="Restore defaults"
        description={RESTORE_DEFAULTS_SCOPE}
        notice={action.notice}
        actions={(
          <button
            ref={trigger}
            type="button"
            className="secondary-button"
            disabled={disabled}
            aria-disabled={action.busy || undefined}
            aria-expanded={confirmDestructiveActions ? confirming : undefined}
            onClick={() => {
              if (action.busy) return;
              if (confirmDestructiveActions) setConfirming(!confirming);
              else restore();
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />{confirmDestructiveActions ? "Restore defaults…" : "Restore defaults"}
          </button>
        )}
      />
      {confirming && (
        <div
          className="restore-defaults-confirm"
          role="group"
          aria-label="Confirm restore defaults"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          <strong>Restore defaults?</strong>
          <small>This cannot be undone.</small>
          <div>
            <button ref={cancel} type="button" className="secondary-button" onClick={close}>Cancel</button>
            <button type="button" className="secondary-button is-danger" disabled={disabled} onClick={restore}>Restore defaults</button>
          </div>
        </div>
      )}
    </>
  );
}

import { useLayoutEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

import { SettingRow } from "./SettingsLayout";
import type { SettingNotice } from "./useSettingAction";

export function ProjectRemoval({
  projectName,
  confirmDestructiveActions,
  disabled,
  busy,
  running,
  notice,
  onRemove,
}: {
  projectName: string;
  confirmDestructiveActions: boolean;
  disabled: boolean;
  busy: boolean;
  running: boolean;
  notice: SettingNotice | null;
  onRemove: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  const unavailable = busy || running;
  const close = (): void => {
    setConfirming(false);
    trigger.current?.focus();
  };
  const remove = (): void => {
    if (unavailable) return;
    setConfirming(false);
    onRemove();
  };
  return (
    <>
      <SettingRow
        id="project-remove"
        title="Remove project"
        description={running
          ? "Stop this project's running chats first."
          : "Removes the project and its chats from Inertia. Files on disk are not touched."}
        notice={notice}
      >
        <button
          ref={trigger}
          type="button"
          className="secondary-button is-danger"
          disabled={disabled}
          aria-disabled={unavailable || undefined}
          aria-expanded={confirmDestructiveActions ? confirming : undefined}
          onClick={() => {
            if (unavailable) return;
            if (confirmDestructiveActions) setConfirming(!confirming);
            else remove();
          }}
        >
          <Trash2 size={14} aria-hidden="true" />Remove project
        </button>
      </SettingRow>
      {confirming && (
        <div
          className="project-remove-confirm"
          role="group"
          aria-label="Confirm removing the project"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          <strong>Remove “{projectName}” and its chats from Inertia?</strong>
          <small>This cannot be undone. Files on disk will not be deleted.</small>
          <div>
            <button ref={cancel} type="button" className="secondary-button" onClick={close}>Cancel</button>
            <button type="button" className="secondary-button is-danger" disabled={disabled} aria-disabled={unavailable || undefined} onClick={remove}>
              Remove from Inertia
            </button>
          </div>
        </div>
      )}
    </>
  );
}

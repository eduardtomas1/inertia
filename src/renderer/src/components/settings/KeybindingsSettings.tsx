import { useEffect, useRef, useState } from "react";
import { Keyboard, RotateCcw } from "lucide-react";

import type { AppSettings } from "@shared/contracts";
import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
  type AppKeybindings,
  type AppShortcutAction,
  type AppShortcutKey,
} from "@shared/keybindings";
import { SettingsGroup, SettingStatus } from "./SettingsLayout";
import { useSettingAction } from "./useSettingAction";

export const SHORTCUT_ROWS: ReadonlyArray<readonly [AppShortcutAction, string]> = [
  ["search", "Search everything"],
  ["new-chat", "New chat"],
  ["toggle-sidebar", "Toggle project navigation"],
  ["toggle-terminal", "Toggle terminal"],
];

function keybindingsFingerprint(value: AppKeybindings): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")));
}

export function KeybindingsSettings({
  keybindings,
  disabled,
  onUpdate,
}: {
  keybindings: AppKeybindings;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const [draft, setDraft] = useState(keybindings);
  const draftRef = useRef(draft);
  const authoritativeRef = useRef(keybindings);
  const pendingRef = useRef<string | null>(null);
  const fingerprint = keybindingsFingerprint(keybindings);
  const primaryModifier = window.inertia.getPlatform() === "darwin" ? "⌘" : "Ctrl";
  useEffect(() => {
    authoritativeRef.current = keybindings;
    if (pendingRef.current !== null && pendingRef.current !== fingerprint) return;
    pendingRef.current = null;
    draftRef.current = keybindings;
    setDraft(keybindings);
  }, [fingerprint, keybindings]);
  const save = (next: AppKeybindings): void => {
    draftRef.current = next;
    setDraft(next);
    const nextFingerprint = keybindingsFingerprint(next);
    pendingRef.current = nextFingerprint;
    void action.run(() => onUpdate({ keybindings: next })).then((saved) => {
      if (saved || pendingRef.current !== nextFingerprint) return;
      pendingRef.current = null;
      draftRef.current = authoritativeRef.current;
      setDraft(authoritativeRef.current);
    });
  };
  const atDefaults = Object.entries(DEFAULT_APP_KEYBINDINGS)
    .every(([shortcut, key]) => draft[shortcut as AppShortcutAction] === key);
  return (
    <SettingsGroup title="Keyboard shortcuts" headingId="keybindings-heading" description="Fast paths for common actions." icon={Keyboard}>
      <div className="shortcut-list">
        {SHORTCUT_ROWS.map(([shortcut, label]) => (
          <label key={shortcut} data-setting-id={`shortcut-${shortcut}`}>
            <span>{label}</span>
            <span className="shortcut-binding">
              <kbd>{primaryModifier}</kbd>
              <select
                aria-label={`${label} key`}
                value={draft[shortcut]}
                disabled={disabled}
                onChange={(event) => save({
                  ...draftRef.current,
                  [shortcut]: event.target.value as AppShortcutKey,
                })}
              >
                {APP_SHORTCUT_KEYS.map((key) => (
                  <option
                    value={key}
                    key={key}
                    disabled={SHORTCUT_ROWS.some(([other]) => other !== shortcut && draft[other] === key)}
                  >
                    {key.toUpperCase()}
                  </option>
                ))}
              </select>
            </span>
          </label>
        ))}
      </div>
      <div className="settings-keybinding-actions" data-setting-id="reset-shortcuts">
        <button
          className="secondary-button settings-keybinding-reset"
          type="button"
          disabled={disabled || atDefaults}
          onClick={() => save({ ...DEFAULT_APP_KEYBINDINGS })}
        >
          <RotateCcw size={14} />Reset shortcuts
        </button>
        <SettingStatus notice={action.notice} />
      </div>
      <p className="settings-card-note">Cmd/Ctrl stays fixed; available keys avoid system shortcuts.</p>
    </SettingsGroup>
  );
}

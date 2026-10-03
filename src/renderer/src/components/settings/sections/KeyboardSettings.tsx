import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import type { AppSettings } from "@shared/contracts";
import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
  type AppKeybindings,
  type AppShortcutAction,
  type AppShortcutKey,
} from "@shared/keybindings";
import type { SnapshotState } from "@shared/snapshots";
import { SettingSelect } from "../SettingControls";
import { SettingRow, SettingsGroup, SettingStatus } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";
import { useSnapshotSettings } from "../useSnapshotSettings";

const SHORTCUT_ROWS: ReadonlyArray<readonly [AppShortcutAction, string]> = [
  ["search", "Search everything"],
  ["new-chat", "New chat"],
  ["toggle-sidebar", "Toggle project navigation"],
  ["toggle-terminal", "Toggle terminal"],
];

function keybindingsFingerprint(value: AppKeybindings): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function SnapshotShortcut(): React.JSX.Element | null {
  const { available, state, pending, linux, accelerator, configure } = useSnapshotSettings();
  if (!available) return null;
  const options = [
    ...(linux ? [] : [{ value: "both-shift" as const, label: "Both Shift keys" }]),
    { value: "accelerator" as const, label: accelerator },
  ];
  return (
    <SettingsGroup title="Global shortcut" headingId="global-shortcut-heading">
      <SettingSelect<SnapshotState["shortcut"]>
        id="snapshot-shortcut"
        title="Window snapshot"
        description="Works while another app is in front."
        value={state?.shortcut ?? "accelerator"}
        options={options}
        disabled={pending || !state?.available}
        failure={(cause) => cause instanceof Error ? cause.message : "Snapshots unavailable."}
        onChange={(shortcut) => state ? configure({ type: "configure", enabled: state.enabled, shortcut }) : undefined}
      />
    </SettingsGroup>
  );
}

export function KeyboardSettings({
  keybindings,
  disabled,
  onUpdate,
}: {
  keybindings: AppKeybindings;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const reset = useSettingAction();
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
  const persist = async (next: AppKeybindings): Promise<void> => {
    draftRef.current = next;
    setDraft(next);
    const nextFingerprint = keybindingsFingerprint(next);
    pendingRef.current = nextFingerprint;
    try {
      await onUpdate({ keybindings: next });
    } catch (error) {
      if (pendingRef.current === nextFingerprint) {
        pendingRef.current = null;
        draftRef.current = authoritativeRef.current;
        setDraft(authoritativeRef.current);
      }
      throw error;
    }
  };
  const atDefaults = Object.entries(DEFAULT_APP_KEYBINDINGS)
    .every(([shortcut, key]) => draft[shortcut as AppShortcutAction] === key);
  return (
    <>
      <SettingsGroup title="App shortcuts" headingId="keybindings-heading" description={`${primaryModifier} stays fixed; available keys avoid system shortcuts.`}>
        <div className="settings-rows">
          {SHORTCUT_ROWS.map(([shortcut, label]) => (
            <SettingSelect<AppShortcutKey>
              key={shortcut}
              id={`shortcut-${shortcut}`}
              title={label}
              label={`${label} key`}
              prefix={<kbd>{primaryModifier}</kbd>}
              value={draft[shortcut]}
              disabled={disabled}
              options={APP_SHORTCUT_KEYS.map((key) => ({
                value: key,
                label: key.toUpperCase(),
                disabled: SHORTCUT_ROWS.some(([other]) => other !== shortcut && draft[other] === key),
              }))}
              onChange={(key) => persist({ ...draftRef.current, [shortcut]: key })}
            />
          ))}
          <SettingRow id="open-settings" title="Open settings" description="Also closes Settings. This shortcut is fixed.">
            <span className="setting-keys"><kbd>{primaryModifier}</kbd><kbd>,</kbd></span>
          </SettingRow>
        </div>
        <div className="settings-keybinding-actions" data-setting-id="reset-shortcuts">
          <button
            className="secondary-button settings-keybinding-reset"
            type="button"
            disabled={disabled || atDefaults}
            onClick={() => { void reset.run(() => persist({ ...DEFAULT_APP_KEYBINDINGS })); }}
          >
            <RotateCcw size={14} />Reset shortcuts
          </button>
          <SettingStatus notice={reset.notice} />
        </div>
      </SettingsGroup>
      <SnapshotShortcut />
    </>
  );
}

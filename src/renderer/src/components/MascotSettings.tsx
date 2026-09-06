import { Switch } from "./ui";
import { useEffect, useState } from "react";
import { MASCOT_LABELS, type MascotSettingsBridge, type MascotSnapshot } from "../../../shared/mascot";

declare global { interface Window { inertiaMascot?: MascotSettingsBridge } }

export function MascotSettings() {
  const [snapshot, setSnapshot] = useState<MascotSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const bridge = window.inertiaMascot;
    if (!bridge) return;
    let active = true;
    let received = false;
    const unsubscribe = bridge.onChanged((value) => { received = true; setSnapshot(value); });
    void bridge.snapshot().then((value) => {
      if (active && !received) setSnapshot(value);
    }).catch(() => { if (active) setError("Could not load mascot settings."); });
    return () => { active = false; unsubscribe(); };
  }, []);
  if (!window.inertiaMascot) return null;
  const configure = (enabled: boolean): void => {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    void window.inertiaMascot!.configure({ ...snapshot.preferences, enabled })
      .then(setSnapshot).catch(() => setError("Could not update the mascot. Try again."))
      .finally(() => setBusy(false));
  };
  const enabled = snapshot?.preferences.enabled ?? false;
  return (
    <div className="mascot-settings">
      <div className="setting-row">
        <span className="setting-copy"><strong>Desktop mascot</strong><small>A tiny companion above your windows, showing live chat status.</small></span>
        <Switch label="Desktop mascot" checked={enabled} disabled={busy || !snapshot} onChange={configure} />
      </div>
      {enabled && snapshot && <div className="mascot-settings-controls">
        <span role="status">{MASCOT_LABELS[snapshot.status.phase]}</span>
        <button className="secondary-button" type="button" onClick={() => {
          void window.inertiaMascot!.action("focus").catch(() => setError("Could not focus the mascot."));
        }}>{snapshot.placement === "system" ? "Focus mascot" : "Move with keyboard"}</button>
        <button className="secondary-button" type="button" disabled={snapshot.placement === "system"} onClick={() => {
          void window.inertiaMascot!.action("reset-position").catch(() => setError("Could not reset the position."));
        }}>Reset position</button>
        <small>{snapshot.placement === "system" ? "Your Wayland window manager controls mascot placement. " : "Drag to move, or focus and use arrow keys. "}Escape hides it. Right-click for animation and hide controls. Reduced motion uses still artwork.</small>
      </div>}
      {error && <p role="alert" className="settings-card-note">{error}</p>}
    </div>
  );
}

import { Switch } from "./ui";
import { useEffect, useState } from "react";
import { MASCOT_LABELS, type MascotSettingsBridge, type MascotSnapshot } from "../../../shared/mascot";
import { MASCOT_SPRITE_LABELS, MASCOT_SPRITE_STATES, type MascotSprites } from "../../../shared/mascot-sprites";
import { MASCOT_SPRITE_NOTES, MASCOT_SPRITE_RULES, MASCOT_SPRITE_STEPS } from "../../../shared/mascot-sprite-guide";
import { SettingDisclosure, SettingRow } from "./settings/SettingsLayout";
import { useSettingAction } from "./settings/useSettingAction";

declare global { interface Window { inertiaMascot?: MascotSettingsBridge } }

class SpriteRejection extends Error {}

export function MascotSettings() {
  const [snapshot, setSnapshot] = useState<MascotSnapshot | null>(null);
  const [pending, setPending] = useState<MascotSprites | null>(null);
  const mascot = useSettingAction();
  const spriteAction = useSettingAction();
  const { report } = mascot;
  useEffect(() => {
    const bridge = window.inertiaMascot;
    if (!bridge) return;
    let active = true;
    let received = false;
    const unsubscribe = bridge.onChanged((value) => { received = true; setSnapshot(value); });
    void bridge.snapshot().then((value) => {
      if (active && !received) setSnapshot(value);
    }).catch(() => { if (active) report({ tone: "error", text: "Could not load mascot settings." }); });
    return () => { active = false; unsubscribe(); };
  }, [report]);
  const bridge = window.inertiaMascot;
  if (!bridge) return null;
  const busy = mascot.busy || spriteAction.busy;
  const runSprites = (
    key: string,
    operation: () => Promise<string | null>,
    failure: string,
  ): void => {
    void spriteAction.run(operation, {
      key,
      exclusive: true,
      success: (message) => message,
      failure: (error) => error instanceof SpriteRejection ? error.message : failure,
    });
  };
  const configure = (enabled: boolean): void => {
    if (snapshot) void mascot.run(async () => setSnapshot(await bridge.configure({ ...snapshot.preferences, enabled })), { key: "configure", exclusive: true });
  };
  const placementAction = (action: "focus" | "reset-position", failure: string): void => {
    void mascot.run(() => bridge.action(action), { key: action, success: null, failure });
  };
  const importSprites = (): void => runSprites("import", async () => {
    const result = await bridge.importSprites();
    setPending(result.status === "ready" ? result.sprites : null);
    if (result.status === "invalid") throw new SpriteRejection(result.message);
    return null;
  }, "Could not import the sprites.");
  const applySprites = (sprites: MascotSprites): void => runSprites("apply", async () => {
    setSnapshot(await bridge.applySprites(sprites.id));
    setPending(null);
    return "Custom sprites applied.";
  }, "Could not apply the sprites. Import them again.");
  const resetSprites = (): void => runSprites("reset", async () => {
    setSnapshot(await bridge.resetSprites());
    setPending(null);
    return "Default sprites restored.";
  }, "Could not reset the sprites.");
  const exportTemplate = (): void => runSprites("export", async () => {
    const result = await bridge.exportSpriteTemplate();
    if (result.status === "invalid") throw new SpriteRejection(result.message);
    return result.status === "exported" ? "Template exported. Replace its PNG files, then import the folder." : null;
  }, "Could not export the template.");
  const enabled = snapshot?.preferences.enabled ?? false;
  const shown = pending ?? snapshot?.sprites;
  const counts = shown && `${MASCOT_SPRITE_STATES.length} states, ${shown.animated} animated`;
  const spriteError = spriteAction.notice?.tone === "error" ? spriteAction.notice.text : null;
  const spriteNotice = spriteAction.notice?.tone === "info" ? spriteAction.notice.text : null;
  const discardPreview = (): void => {
    setPending(null);
    spriteAction.report(null);
  };
  return (
    <div className="mascot-settings">
      <SettingRow id="desktop-mascot" title="Desktop mascot" description="A tiny companion above your windows, showing live chat status." notice={mascot.notice}>
        <Switch label="Desktop mascot" checked={enabled} disabled={busy || !snapshot} onChange={configure} />
      </SettingRow>
      {enabled && snapshot && <div className="mascot-settings-controls">
        <span role="status">{MASCOT_LABELS[snapshot.status.phase]}</span>
        <button className="secondary-button" type="button" onClick={() => placementAction("focus", "Could not focus the mascot.")}>{snapshot.placement === "system" ? "Focus mascot" : "Move with keyboard"}</button>
        <button className="secondary-button" type="button" disabled={snapshot.placement === "system"} onClick={() => placementAction("reset-position", "Could not reset the position.")}>Reset position</button>
        <small>{snapshot.placement === "system" ? "Your Wayland window manager controls mascot placement. " : "Drag to move, or focus and use arrow keys. "}Escape hides it. Right-click for animation and hide controls. Reduced motion uses still artwork.</small>
      </div>}
      {snapshot && <section className="mascot-sprites" aria-labelledby="mascot-sprites-heading">
        <div className="mascot-sprites-heading">
          <span className="setting-copy">
            <strong id="mascot-sprites-heading">Custom sprites</strong>
            <small>{pending ? `Preview: ${counts}. Apply to use them.` : shown ? `Using your sprites: ${counts}.` : "Import your own artwork for each state. The built-in mascot stays until you apply a set."}</small>
          </span>
          <div>
            <button className="secondary-button" type="button" disabled={busy} onClick={exportTemplate}>{spriteAction.pending === "export" ? "Exporting…" : "Export template"}</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={importSprites}>{spriteAction.pending === "import" ? "Importing…" : "Import sprites"}</button>
          </div>
        </div>
        <SettingDisclosure className="mascot-sprite-guide" key={snapshot.sprites ? "custom" : "default"} defaultOpen={!snapshot.sprites} summary="How custom sprites work">
          <ol aria-label="Steps">
            {MASCOT_SPRITE_STEPS.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <ul aria-label="Format">
            {MASCOT_SPRITE_RULES.map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
        </SettingDisclosure>
        {shown ? <ul className="mascot-sprite-preview" aria-label={pending ? "Sprite preview" : "Current sprites"}>
          {MASCOT_SPRITE_STATES.map((state) => <li key={state}>
            <picture>
              <source media="(prefers-reduced-motion: no-preference)" srcSet={shown.files[state].animation} />
              <img src={shown.files[state].poster} width={96} height={96} alt="" draggable={false} />
            </picture>
            <span>{MASCOT_SPRITE_LABELS[state]}</span>
            <code>{`${state}.png`}</code>
            {shown.files[state].animation !== shown.files[state].poster && <small>Animated</small>}
          </li>)}
        </ul> : <ul className="mascot-sprite-files" aria-label="Required files">
          {MASCOT_SPRITE_STATES.map((state) => <li key={state}>
            <code>{`${state}.png`}</code>
            <strong>{MASCOT_SPRITE_LABELS[state]}</strong>
            <small>{MASCOT_SPRITE_NOTES[state]}</small>
          </li>)}
        </ul>}
        {spriteError && <p role="alert" className="mascot-sprites-error">{spriteError}</p>}
        {(pending || snapshot.sprites) && <div className="mascot-sprites-actions">
          {pending ? <>
            <button className="primary-button" type="button" disabled={busy} onClick={() => applySprites(pending)}>{spriteAction.pending === "apply" ? "Applying…" : "Apply sprites"}</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={discardPreview}>Discard preview</button>
          </> : <button className="secondary-button" type="button" disabled={busy} onClick={resetSprites}>{spriteAction.pending === "reset" ? "Resetting…" : "Reset to default"}</button>}
        </div>}
        {spriteNotice && <p role="status" className="settings-card-note">{spriteNotice}</p>}
        {shown && !enabled && <p className="settings-card-note">Turn on Desktop mascot above to see these sprites on your desktop.</p>}
      </section>}
    </div>
  );
}

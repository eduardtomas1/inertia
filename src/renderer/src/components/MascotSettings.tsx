import { Switch } from "./ui";
import { useEffect, useState } from "react";
import { MASCOT_LABELS, type MascotSettingsBridge, type MascotSnapshot } from "../../../shared/mascot";
import { MASCOT_SPRITE_LABELS, MASCOT_SPRITE_STATES, type MascotSprites } from "../../../shared/mascot-sprites";
import { MASCOT_SPRITE_NOTES, MASCOT_SPRITE_RULES, MASCOT_SPRITE_STEPS } from "../../../shared/mascot-sprite-guide";

declare global { interface Window { inertiaMascot?: MascotSettingsBridge } }

export function MascotSettings() {
  const [snapshot, setSnapshot] = useState<MascotSnapshot | null>(null);
  const [pending, setPending] = useState<MascotSprites | null>(null);
  const [busy, setBusy] = useState<"import" | "export" | "apply" | "reset" | "configure" | null>(null);
  const [error, setError] = useState("");
  const [spriteError, setSpriteError] = useState("");
  const [notice, setNotice] = useState("");
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
  const bridge = window.inertiaMascot;
  if (!bridge) return null;
  const run = (
    kind: NonNullable<typeof busy>,
    operation: () => Promise<void>,
    failure: string,
    report = setError,
  ): void => {
    setBusy(kind);
    setError("");
    setSpriteError("");
    setNotice("");
    void operation().catch(() => report(failure)).finally(() => setBusy(null));
  };
  const configure = (enabled: boolean): void => {
    if (snapshot) run("configure", async () => setSnapshot(await bridge.configure({ ...snapshot.preferences, enabled })), "Could not update the mascot. Try again.");
  };
  const importSprites = (): void => run("import", async () => {
    const result = await bridge.importSprites();
    setPending(result.status === "ready" ? result.sprites : null);
    if (result.status === "invalid") setSpriteError(result.message);
  }, "Could not import the sprites.", setSpriteError);
  const applySprites = (sprites: MascotSprites): void => run("apply", async () => {
    setSnapshot(await bridge.applySprites(sprites.id));
    setPending(null);
    setNotice("Custom sprites applied.");
  }, "Could not apply the sprites. Import them again.", setSpriteError);
  const resetSprites = (): void => run("reset", async () => {
    setSnapshot(await bridge.resetSprites());
    setPending(null);
    setNotice("Default sprites restored.");
  }, "Could not reset the sprites.", setSpriteError);
  const exportTemplate = (): void => run("export", async () => {
    const result = await bridge.exportSpriteTemplate();
    if (result.status === "exported") setNotice("Template exported. Replace its PNG files, then import the folder.");
    if (result.status === "invalid") setSpriteError(result.message);
  }, "Could not export the template.", setSpriteError);
  const enabled = snapshot?.preferences.enabled ?? false;
  const shown = pending ?? snapshot?.sprites;
  const counts = shown && `${MASCOT_SPRITE_STATES.length} states, ${shown.animated} animated`;
  const discardPreview = (): void => {
    setPending(null);
    setSpriteError("");
    setNotice("");
  };
  return (
    <div className="mascot-settings">
      <div className="setting-row">
        <span className="setting-copy"><strong>Desktop mascot</strong><small>A tiny companion above your windows, showing live chat status.</small></span>
        <Switch label="Desktop mascot" checked={enabled} disabled={busy !== null || !snapshot} onChange={configure} />
      </div>
      {enabled && snapshot && <div className="mascot-settings-controls">
        <span role="status">{MASCOT_LABELS[snapshot.status.phase]}</span>
        <button className="secondary-button" type="button" onClick={() => {
          void bridge.action("focus").catch(() => setError("Could not focus the mascot."));
        }}>{snapshot.placement === "system" ? "Focus mascot" : "Move with keyboard"}</button>
        <button className="secondary-button" type="button" disabled={snapshot.placement === "system"} onClick={() => {
          void bridge.action("reset-position").catch(() => setError("Could not reset the position."));
        }}>Reset position</button>
        <small>{snapshot.placement === "system" ? "Your Wayland window manager controls mascot placement. " : "Drag to move, or focus and use arrow keys. "}Escape hides it. Right-click for animation and hide controls. Reduced motion uses still artwork.</small>
      </div>}
      {snapshot && <section className="mascot-sprites" aria-labelledby="mascot-sprites-heading">
        <div className="mascot-sprites-heading">
          <span className="setting-copy">
            <strong id="mascot-sprites-heading">Custom sprites</strong>
            <small>{pending ? `Preview: ${counts}. Apply to use them.` : shown ? `Using your sprites: ${counts}.` : "Import your own artwork for each state. The built-in mascot stays until you apply a set."}</small>
          </span>
          <div>
            <button className="secondary-button" type="button" disabled={busy !== null} onClick={exportTemplate}>{busy === "export" ? "Exporting…" : "Export template"}</button>
            <button className="secondary-button" type="button" disabled={busy !== null} onClick={importSprites}>{busy === "import" ? "Importing…" : "Import sprites"}</button>
          </div>
        </div>
        <details className="mascot-sprite-guide" key={snapshot.sprites ? "custom" : "default"} open={!snapshot.sprites || undefined}>
          <summary>How custom sprites work</summary>
          <ol aria-label="Steps">
            {MASCOT_SPRITE_STEPS.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <ul aria-label="Format">
            {MASCOT_SPRITE_RULES.map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
        </details>
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
            <button className="primary-button" type="button" disabled={busy !== null} onClick={() => applySprites(pending)}>{busy === "apply" ? "Applying…" : "Apply sprites"}</button>
            <button className="secondary-button" type="button" disabled={busy !== null} onClick={discardPreview}>Discard preview</button>
          </> : <button className="secondary-button" type="button" disabled={busy !== null} onClick={resetSprites}>{busy === "reset" ? "Resetting…" : "Reset to default"}</button>}
        </div>}
        {notice && <p role="status" className="settings-card-note">{notice}</p>}
        {shown && !enabled && <p className="settings-card-note">Turn on Desktop mascot above to see these sprites on your desktop.</p>}
      </section>}
      {error && <p role="alert" className="settings-card-note">{error}</p>}
    </div>
  );
}

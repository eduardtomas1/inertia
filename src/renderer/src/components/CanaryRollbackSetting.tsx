import { useEffect, useState } from "react";
import { RotateCcw, ShieldCheck } from "lucide-react";

import type { CanaryRollbackStatus } from "@shared/desktop";
import { INERTIA_VERSION } from "@shared/version";

export default function CanaryRollbackSetting(): React.JSX.Element {
  const [status, setStatus] = useState<CanaryRollbackStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void window.inertia.getCanaryRollbackStatus().then((next) => {
      if (active) setStatus(next);
    }, () => {
      if (active) setStatus({
        state: "failed",
        version: null,
        message: "The Canary rollback status could not be verified.",
      });
    });
    return () => { active = false; };
  }, []);

  const run = async (operation: () => Promise<CanaryRollbackStatus>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(await operation());
    } catch {
      setStatus({
        state: "failed",
        version: status?.version ?? null,
        message: "The Canary rollback operation could not be completed.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="codex-binary-path application-update-setting canary-rollback-setting">
        <span>
          <strong>Canary channel · isolated profile</strong>
          <small role="status" aria-live="polite" aria-atomic="true">
            {busy
              ? "Downloading and verifying the current immutable Canary package…"
              : status?.message ?? "Checking the retained last-known-good Canary package…"}
          </small>
        </span>
        <div>
          {status?.state === "ready" && status.version !== INERTIA_VERSION ? (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(window.inertia.openCanaryRollback); }}><RotateCcw size={14} />{window.inertia.getPlatform() === "linux" ? "Show rollback file" : "Open rollback"} v{status.version}</button>
          ) : status?.state !== "ready" ? (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(window.inertia.prepareCanaryRollback); }}><ShieldCheck size={14} />Prepare rollback</button>
          ) : null}
        </div>
      </div>
      <p className="settings-card-note">Canary uses a separate app identity, protocol, data directory, Chromium profile, update feed, and package cache. Stable Inertia data is never imported or modified.</p>
    </>
  );
}

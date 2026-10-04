import { useEffect, useState } from "react";
import { RotateCcw, ShieldCheck } from "lucide-react";

import type { CanaryRollbackStatus } from "@shared/desktop";
import { INERTIA_VERSION } from "@shared/version";
import { SettingActionRow } from "./settings/SettingsLayout";
import { useSettingAction } from "./settings/useSettingAction";

export default function CanaryRollbackSetting(): React.JSX.Element {
  const [status, setStatus] = useState<CanaryRollbackStatus | null>(null);
  const action = useSettingAction();

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

  const run = (operation: () => Promise<CanaryRollbackStatus>): void => {
    void action.run(async () => {
      try {
        setStatus(await operation());
      } catch {
        setStatus((current) => ({
          state: "failed",
          version: current?.version ?? null,
          message: "The Canary rollback operation could not be completed.",
        }));
      }
    }, { exclusive: true, success: null });
  };

  return (
    <>
      <SettingActionRow
        id="canary-rollback"
        className="runtime-log-setting application-update-setting"
        title="Canary rollback"
        description="Canary uses its own app identity, data, profile, update feed and package cache. Stable Inertia data is never imported or modified."
        details={(
          <small role="status" aria-live="polite" aria-atomic="true">
            {action.busy
              ? "Downloading and verifying the current immutable Canary package…"
              : status?.message ?? "Checking the retained last-known-good Canary package…"}
          </small>
        )}
        actions={status?.state === "ready" && status.version !== INERTIA_VERSION ? (
          <button type="button" className="secondary-button" disabled={action.busy} onClick={() => run(window.inertia.openCanaryRollback)}><RotateCcw size={14} aria-hidden="true" />{window.inertia.getPlatform() === "linux" ? "Show rollback file" : "Open rollback"} v{status.version}</button>
        ) : status?.state !== "ready" ? (
          <button type="button" className="secondary-button" disabled={action.busy} onClick={() => run(window.inertia.prepareCanaryRollback)}><ShieldCheck size={14} aria-hidden="true" />Prepare rollback</button>
        ) : null}
      />
    </>
  );
}

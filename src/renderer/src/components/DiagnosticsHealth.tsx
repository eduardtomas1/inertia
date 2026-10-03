import { useEffect, useState } from "react";
import {
  appUpdatePreparationDiagnostic,
  lifecycleActionableStateWithUpdate,
} from "@shared/app-update-preparation-diagnostic";
import type { RuntimeLifecycleDiagnosticSnapshot } from "@shared/contracts";
import type { AppHealthSnapshot, AppUpdateStatus } from "@shared/desktop";
import { INTERFACE_LOCALE } from "../lib/locale";

const LIFECYCLE_LABELS: Readonly<Record<RuntimeLifecycleDiagnosticSnapshot["actionableState"], string>> = {
  "safe-and-ready": "Safe and ready",
  "finishing-previous-work": "Finishing previous work",
  "waiting-for-provider-cleanup": "Waiting for provider cleanup",
  "update-blocked-by-active-work": "Update blocked by active work",
  "previous-runtime-cleanup-unconfirmed": "Previous runtime cleanup unconfirmed",
  "provider-installation-changed": "Provider installation changed",
  "session-resume-rejected-for-compatibility": "Session resume rejected for compatibility",
  "provider-capability-unavailable": "Provider capability unavailable",
  "recovery-requires-manual-attention": "Recovery requires manual attention",
};

function megabytes(bytes: number | null): string {
  return bytes === null ? "unavailable" : `${Math.round(bytes / 1_048_576)} MB`;
}

export function DiagnosticsHealth({ runtime, lifecycleDiagnostics, appUpdateStatus }: {
  runtime: "ready" | "unavailable" | null;
  lifecycleDiagnostics?: RuntimeLifecycleDiagnosticSnapshot;
  appUpdateStatus: AppUpdateStatus | null;
}): React.JSX.Element {
  const [health, setHealth] = useState<AppHealthSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const sample = async (): Promise<void> => {
      try {
        const next = await window.inertia.getAppHealth();
        if (active) { setHealth(next); setFailed(false); }
      } catch {
        if (active) setFailed(true);
      }
    };
    void sample();
    const timer = window.setInterval(() => { void sample(); }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const renderers = health?.rendererProcesses ?? null;
  const usage = health
    ? [
        `Memory ${megabytes(health.totalMemoryBytes)}`,
        `Main ${megabytes(health.mainProcess?.memoryBytes ?? null)}${health.mainProcess ? `, ${health.mainProcess.cpuPercent.toFixed(1)}% CPU` : ""}`,
        `Interface ${megabytes(renderers ? renderers.reduce((total, process) => total + process.memoryBytes, 0) : null)}`,
        `Local service ${megabytes(health.runtimeProcess?.memoryBytes ?? null)}`,
      ].join(" · ")
    : failed ? "Process health is unavailable." : "Measuring…";
  const phase = health?.runtimePhase ?? (runtime === "ready" ? "ready" : runtime === "unavailable" ? "offline" : null);
  const state = [
    phase ? `Local service ${phase}` : null,
    lifecycleDiagnostics
      ? LIFECYCLE_LABELS[lifecycleActionableStateWithUpdate(lifecycleDiagnostics.actionableState, appUpdatePreparationDiagnostic(appUpdateStatus))]
      : null,
    lifecycleDiagnostics
      ? `${lifecycleDiagnostics.ownedResources.turns} active ${lifecycleDiagnostics.ownedResources.turns === 1 ? "turn" : "turns"}`
        + ` · ${lifecycleDiagnostics.ownedResources.interactions} open ${lifecycleDiagnostics.ownedResources.interactions === 1 ? "interaction" : "interactions"}`
      : null,
    health ? `Measured ${new Date(health.sampledAt).toLocaleTimeString(INTERFACE_LOCALE)}` : null,
  ].filter(Boolean).join(" · ");
  return <div className="diagnostics-health" role="group" aria-labelledby="diagnostics-health-label">
    <span id="diagnostics-health-label" className="diagnostics-section-label">Process health</span>
    <p>{usage}</p>
    <p>{state || " "}</p>
  </div>;
}

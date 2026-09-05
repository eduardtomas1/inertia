import { useState } from "react";
import clsx from "clsx";
import { Copy, FolderOpen, ShieldCheck } from "lucide-react";

import {
  appUpdatePreparationDiagnostic,
  lifecycleActionableStateWithUpdate,
} from "@shared/app-update-preparation-diagnostic";
import type {
  ProviderInfo,
  RuntimeLifecycleDiagnosticSnapshot,
} from "@shared/contracts";
import type { AppUpdateStatus } from "@shared/desktop";

type LifecycleIntegritySettingsProps =
  | {
    surface: "provider-capability";
    provider: ProviderInfo;
  }
  | {
    surface: "runtime-diagnostics";
    diagnostics?: RuntimeLifecycleDiagnosticSnapshot;
    appUpdateStatus: AppUpdateStatus | null;
    onRevealRuntimeLogs: () => Promise<string>;
    onCopyRuntimeDiagnosticReport: () => Promise<{
      copied: boolean;
      eventCount: number;
    }>;
  };

export function LifecycleIntegritySettings(
  props: LifecycleIntegritySettingsProps,
): React.JSX.Element | null {
  const [revealingLogs, setRevealingLogs] = useState(false);
  const [copyingSupportReport, setCopyingSupportReport] = useState(false);
  const [logRevealStatus, setLogRevealStatus] = useState<string | null>(null);
  const [supportReportStatus, setSupportReportStatus] = useState<string | null>(
    null,
  );

  if (props.surface === "provider-capability") {
    const contract = props.provider.capabilityContract;
    if (!contract) return null;
    return (
      <div className="provider-settings-field">
        <span>Capability contract</span>
        <div
          className={clsx(
            "provider-settings-capability-contract",
            contract.installationVerified ? "is-verified" : "is-unverified",
          )}
          aria-label={`${props.provider.label} capability contract`}
        >
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            <strong>
              {contract.installationVerified
                ? `Verified for ${contract.installedVersion ?? "this installation"}`
                : "Waiting for exact installation verification"}
            </strong>
            <code title={contract.manifestDigest}>
              {contract.harnessId}
              {" · "}
              {contract.manifestDigest.slice(0, 12)}
            </code>
          </span>
          <small>
            {contract.installationVerified
              ? `${contract.currentlyAvailableCount} of ${contract.declaredCapabilityCount} declared capabilities are available now.`
              : "Optional provider features remain unavailable until version and protocol evidence match this manifest."}
          </small>
        </div>
      </div>
    );
  }

  const revealRuntimeLogs = async (): Promise<void> => {
    if (revealingLogs) return;
    setRevealingLogs(true);
    setLogRevealStatus(null);
    try {
      const error = await props.onRevealRuntimeLogs();
      setLogRevealStatus(error
        ? "The runtime log folder could not be opened."
        : "Runtime log folder opened.");
    } catch {
      setLogRevealStatus("The runtime log folder could not be opened.");
    } finally {
      setRevealingLogs(false);
    }
  };
  const copyRuntimeSupportReport = async (): Promise<void> => {
    if (copyingSupportReport) return;
    setCopyingSupportReport(true);
    setSupportReportStatus(null);
    try {
      const result = await props.onCopyRuntimeDiagnosticReport();
      setSupportReportStatus(result.copied
        ? `Private support summary copied · ${result.eventCount} lifecycle ${result.eventCount === 1 ? "event" : "events"}.`
        : "The support summary could not be copied.");
    } catch {
      setSupportReportStatus("The support summary could not be copied.");
    } finally {
      setCopyingSupportReport(false);
    }
  };
  const diagnostics = props.diagnostics;
  return (
    <>
      <div className="codex-binary-path runtime-log-setting">
        <span>
          <strong>Runtime diagnostics</strong>
          <small>Local-only lifecycle and failure metadata. Excludes prompts, source, tokens, and credentials. Logs rotate at 256 KB and expire after seven days.</small>
          {diagnostics && (
            <small className="runtime-lifecycle-summary">
              <strong>{lifecycleActionLabel(lifecycleActionableStateWithUpdate(
                diagnostics.actionableState,
                appUpdatePreparationDiagnostic(props.appUpdateStatus),
              ))}</strong>
              {` · ${diagnostics.ownedResources.turns} active ${diagnostics.ownedResources.turns === 1 ? "turn" : "turns"}`}
              {` · ${diagnostics.ownedResources.interactions} open ${diagnostics.ownedResources.interactions === 1 ? "interaction" : "interactions"}`}
              {` · generation ${diagnostics.runtimeGenerationHash}`}
            </small>
          )}
        </span>
        <div>
          <button type="button" className="secondary-button" disabled={copyingSupportReport} onClick={() => { void copyRuntimeSupportReport(); }}><Copy size={14} />{copyingSupportReport ? "Copying…" : "Copy support summary"}</button>
          <button type="button" className="secondary-button" disabled={revealingLogs} onClick={() => { void revealRuntimeLogs(); }}><FolderOpen size={14} />{revealingLogs ? "Opening…" : "Reveal log folder"}</button>
        </div>
      </div>
      {logRevealStatus && <p className="settings-card-note" role="status">{logRevealStatus}</p>}
      {supportReportStatus && <p className="settings-card-note" role="status">{supportReportStatus}</p>}
    </>
  );
}

function lifecycleActionLabel(
  state: RuntimeLifecycleDiagnosticSnapshot["actionableState"],
): string {
  return {
    "safe-and-ready": "Safe and ready",
    "finishing-previous-work": "Finishing previous work",
    "waiting-for-provider-cleanup": "Waiting for provider cleanup",
    "update-blocked-by-active-work": "Update blocked by active work",
    "previous-runtime-cleanup-unconfirmed": "Previous runtime cleanup unconfirmed",
    "provider-installation-changed": "Provider installation changed",
    "session-resume-rejected-for-compatibility": "Session resume rejected for compatibility",
    "provider-capability-unavailable": "Provider capability unavailable",
    "recovery-requires-manual-attention": "Recovery requires manual attention",
  }[state];
}

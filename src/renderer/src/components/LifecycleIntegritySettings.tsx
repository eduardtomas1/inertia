import { useState } from "react";
import { Copy, FolderOpen } from "lucide-react";

import {
  appUpdatePreparationDiagnostic,
  lifecycleActionableStateWithUpdate,
} from "@shared/app-update-preparation-diagnostic";
import type {
  ProviderInfo,
  RuntimeLifecycleDiagnosticSnapshot,
} from "@shared/contracts";
import type { AppUpdateStatus } from "@shared/desktop";
import { SettingDisclosure } from "./settings/SettingsLayout";

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  images: "Images",
  reasoning: "Reasoning",
  "structured-input": "Questions",
  "follow-up-steer": "Follow-ups during a turn",
  "session-resume": "Resume chats",
  compaction: "Compact context",
  "subagent-create": "Subagents",
  "subagent-stop": "Stop a subagent",
  "host-tool-bridge": "Manage Inertia chats",
  "performance-modes": "Response speed",
  "usage-tokens": "Token usage",
  "rate-limits": "Account limits",
};

const CAPABILITY_STATES = {
  available: "Ready",
  "installation-unverified": "Verify installation",
  "configuration-required": "Needs setup",
  "negotiation-required": "Checked when a chat starts",
  unsupported: "Not supported by this connection",
} as const;

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
      <SettingDisclosure className="provider-settings-details" summary="Details">
        <dl className="provider-settings-facts" aria-label={`${props.provider.label} capability contract`}>
          <div>
            <dt>Installation</dt>
            <dd>
              {contract.installationVerified
                ? `Verified for ${contract.installedVersion ?? "this installation"}`
                : "Waiting for exact installation verification"}
            </dd>
          </div>
          <div>
            <dt>Capabilities</dt>
            <dd>
              {contract.installationVerified
                ? `${contract.currentlyAvailableCount} of ${contract.declaredCapabilityCount} declared capabilities are available now.`
                : "Optional provider features stay unavailable until version and protocol evidence match."}
            </dd>
          </div>
          <div>
            <dt>Contract</dt>
            <dd title={contract.manifestDigest}>{contract.harnessId}</dd>
          </div>
        </dl>
        {contract.capabilities && (
          <>
            <ul className="provider-settings-features" aria-label={`${props.provider.label} feature availability`}>
              {contract.capabilities.filter(({ id }) => CAPABILITY_LABELS[id]).map(({ id, state }) => (
                <li key={id}>
                  <span>{CAPABILITY_LABELS[id]}</span>
                  <span>{CAPABILITY_STATES[state]}</span>
                </li>
              ))}
            </ul>
            <p className="provider-settings-features-note">Availability can also depend on the model and settings of each chat.</p>
          </>
        )}
      </SettingDisclosure>
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
      <div className="setting-action-row runtime-log-setting" data-setting-id="runtime-diagnostics">
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

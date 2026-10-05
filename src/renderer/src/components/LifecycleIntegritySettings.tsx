import type { ProviderInfo } from "@shared/contracts";
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

interface LifecycleIntegritySettingsProps {
  surface: "provider-capability";
  provider: ProviderInfo;
}

export function LifecycleIntegritySettings(
  props: LifecycleIntegritySettingsProps,
): React.JSX.Element | null {
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

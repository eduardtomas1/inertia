import clsx from "clsx";
import { ShieldCheck } from "lucide-react";

import type { ProviderInfo } from "@shared/contracts";

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
        {contract.capabilities && (
          <details className="provider-settings-capability-details">
            <summary>Feature availability</summary>
            <ul aria-label={`${props.provider.label} feature availability`}>
              {contract.capabilities.filter(({ id }) => CAPABILITY_LABELS[id]).map(({ id, state }) => (
                <li key={id}>
                  <span>{CAPABILITY_LABELS[id]}</span>
                  <span className={state === "available" ? "is-ready" : undefined}>
                    {CAPABILITY_STATES[state]}
                  </span>
                </li>
              ))}
            </ul>
            <p>Availability can also depend on the model and settings of each chat.</p>
          </details>
        )}
      </div>
    </div>
  );
}

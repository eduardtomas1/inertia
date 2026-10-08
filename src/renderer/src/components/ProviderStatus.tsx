import { CheckCircle2, CircleAlert, CircleDot, PlugZap, RefreshCw } from "lucide-react";
import clsx from "clsx";
import type { ProviderInfo } from "@shared/contracts";
import { providerStateLabel, providerVersionLabel, type ProviderSetupAction } from "../utils/providerStatus";
import { LoadingMark } from "./ui";

export { providerSetupAction, providerStateDetail, providerStateLabel } from "../utils/providerStatus";
export type { ProviderSetupAction } from "../utils/providerStatus";

export function ProviderStatus({ provider, id }: { provider: ProviderInfo; id?: string }): React.JSX.Element {
  const checking = provider.installState === "checking" || provider.authState === "checking";
  const ready = provider.canRun;
  const unavailable = provider.installState === "not-installed" || provider.installState === "unresponsive" || provider.installState === "error" || provider.authState === "error";
  const StatusIcon = checking ? LoadingMark : unavailable ? CircleAlert : ready ? CheckCircle2 : CircleDot;

  return (
    <span
      id={id}
      className={clsx(
        "provider-state",
        checking ? "is-checking" : unavailable ? "is-unavailable" : ready ? "is-ready" : "is-attention",
      )}
    >
      <StatusIcon size={13} aria-hidden="true" />
      <span>{providerStateLabel(provider)}</span>
      {provider.version && <span className="provider-state-version">{providerVersionLabel(provider.version)}</span>}
    </span>
  );
}

export function ProviderActionIcon({ action }: { action: Exclude<ProviderSetupAction, null> }): React.JSX.Element {
  return action === "connect" ? <PlugZap size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />;
}

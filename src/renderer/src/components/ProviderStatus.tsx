import { CheckCircle2, CircleAlert, CircleDot, LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import clsx from "clsx";
import type { ProviderInfo } from "@shared/contracts";
import { providerSetupAction, providerStateLabel, type ProviderSetupAction } from "@/utils/providerStatus";

export { providerSetupAction, providerStateDetail, providerStateLabel } from "@/utils/providerStatus";
export type { ProviderSetupAction } from "@/utils/providerStatus";

export function ProviderStatus({ provider, compact = false }: { provider: ProviderInfo; compact?: boolean }): React.JSX.Element {
  const checking = provider.installState === "checking" || provider.authState === "checking";
  const ready = provider.canRun;
  const unavailable = provider.installState === "not-installed" || provider.installState === "error" || provider.authState === "error";
  const StatusIcon = checking ? LoaderCircle : unavailable ? CircleAlert : ready ? CheckCircle2 : CircleDot;

  return (
    <span
      aria-label={`${provider.label}: ${providerStateLabel(provider)}`}
      className={clsx(
        "provider-status",
        compact && "is-compact",
        checking ? "is-checking" : unavailable ? "is-unavailable" : ready ? "is-ready" : "is-attention",
      )}
    >
      <StatusIcon size={compact ? 12 : 14} className={checking ? "provider-status-spinner" : undefined} />
      <span>{providerStateLabel(provider)}</span>
    </span>
  );
}

export function ProviderActionIcon({ action }: { action: Exclude<ProviderSetupAction, null> }): React.JSX.Element {
  return action === "connect" ? <PlugZap size={14} /> : <RefreshCw size={14} />;
}

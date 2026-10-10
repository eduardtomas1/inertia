import type { ProviderId } from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type { ProviderHandoffItem } from "./response-timeline/model";
import { MODEL_SOURCE_PROVIDER_LABELS } from "./modelSourceRail";

export const PROVIDER_HANDOFF_TITLE = "Context handoff";

export interface ProviderHandoffText {
  from: string;
  to: string;
  detail: string | null;
  /** The complete accessible description of the divider. */
  label: string;
}

export function providerRouteLabel(
  providerId: ProviderId,
  backend: string | null,
  labels?: ProviderIdentityLabels,
): string {
  const provider = labels?.[providerId]
    ?? MODEL_SOURCE_PROVIDER_LABELS[providerId]
    ?? providerId;
  return backend ? `${provider} · ${backend}` : provider;
}

function routeLabel(
  route: ProviderHandoffItem["from"],
  labels: ProviderIdentityLabels | undefined,
): string {
  const provider = providerRouteLabel(route.providerId, route.backend, labels);
  return route.model ? `${provider} · ${route.model}` : provider;
}

function carriedDetail(recovery: ProviderHandoffItem["sessionRecovery"]): string | null {
  if (!recovery) return null;
  const { restoredMessageCount: carried, omittedMessageCount: omitted } = recovery;
  const leftBehind = omitted + (recovery.withheldMessageCount ?? 0);
  const outcome = carried === 0
    ? "nothing carried"
    : `${carried} earlier ${carried === 1 ? "message" : "messages"} carried`;
  return leftBehind > 0 ? `${outcome} · ${leftBehind} left behind` : outcome;
}

export function providerHandoffText(
  handoff: ProviderHandoffItem,
  labels?: ProviderIdentityLabels,
): ProviderHandoffText {
  const from = routeLabel(handoff.from, labels);
  const to = routeLabel(handoff.to, labels);
  const detail = carriedDetail(handoff.sessionRecovery);
  return {
    from,
    to,
    detail,
    label: `${PROVIDER_HANDOFF_TITLE}: ${from} to ${to}${detail ? ` · ${detail}` : ""}`,
  };
}

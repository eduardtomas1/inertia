import type { ModelSelection, ProviderId } from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import { providerNativeBackendProfile } from "../../../shared/model-routing";
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

export function providerBackendName(
  providerId: ProviderId,
  selection: Pick<ModelSelection, "backendProfileId" | "backendProfileDisplayName">,
): string | null {
  return selection.backendProfileId === providerNativeBackendProfile(providerId).id
    ? null
    : selection.backendProfileDisplayName;
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

function restoredDetail(recovery: ProviderHandoffItem["sessionRecovery"]): string | null {
  if (!recovery) return null;
  const { restoredMessageCount: restored, omittedMessageCount: omitted } = recovery;
  if (restored === 0) return "earlier messages were not restored";
  const noun = restored === 1 ? "message" : "messages";
  return `${restored} earlier ${noun} restored${omitted > 0 ? ` · ${omitted} omitted` : ""}`;
}

export function providerHandoffText(
  handoff: ProviderHandoffItem,
  labels?: ProviderIdentityLabels,
): ProviderHandoffText {
  const from = routeLabel(handoff.from, labels);
  const to = routeLabel(handoff.to, labels);
  const detail = restoredDetail(handoff.sessionRecovery);
  return {
    from,
    to,
    detail,
    label: `${PROVIDER_HANDOFF_TITLE}: ${from} to ${to}${detail ? ` · ${detail}` : ""}`,
  };
}

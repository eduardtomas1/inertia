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

function routeLabel(
  route: ProviderHandoffItem["from"],
  labels: ProviderIdentityLabels | undefined,
): string {
  const provider = labels?.[route.providerId]
    ?? MODEL_SOURCE_PROVIDER_LABELS[route.providerId]
    ?? route.providerId;
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

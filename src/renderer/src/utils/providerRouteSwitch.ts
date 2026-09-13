import type { AgentActivity, AgentTurn } from "@shared/contracts";
import { GEMINI_INDIVIDUAL_ACCESS_RETIRED_MESSAGE } from "@shared/provider";

export interface ProviderRouteSwitchRequest {
  conversationId: string;
  providerId: "antigravity";
}

export const PROVIDER_ROUTE_SWITCH_EVENT = "inertia:provider-route-switch";

export function parseProviderRouteSwitch(value: unknown): ProviderRouteSwitchRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { conversationId, providerId } = value as Record<string, unknown>;
  return typeof conversationId === "string"
    && conversationId.length > 0
    && conversationId.length <= 200
    && providerId === "antigravity"
    && Object.keys(value).length === 2
    ? { conversationId, providerId }
    : null;
}

export function requestProviderRouteSwitch(request: ProviderRouteSwitchRequest): void {
  const safe = parseProviderRouteSwitch(request);
  if (safe) window.dispatchEvent(new CustomEvent(PROVIDER_ROUTE_SWITCH_EVENT, { detail: safe }));
}

export function subscribeProviderRouteSwitch(
  listener: (request: ProviderRouteSwitchRequest) => void,
): () => void {
  const handle = (event: Event): void => {
    const request = parseProviderRouteSwitch((event as CustomEvent<unknown>).detail);
    if (request) listener(request);
  };
  window.addEventListener(PROVIDER_ROUTE_SWITCH_EVENT, handle);
  return () => window.removeEventListener(PROVIDER_ROUTE_SWITCH_EVENT, handle);
}

export function geminiIndividualAccessRetired(
  turn: Pick<AgentTurn, "providerId">,
  activity: Pick<AgentActivity, "title">,
): boolean {
  return turn.providerId === "gemini"
    && activity.title === GEMINI_INDIVIDUAL_ACCESS_RETIRED_MESSAGE;
}

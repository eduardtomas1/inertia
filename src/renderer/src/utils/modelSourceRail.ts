import type { ProviderId } from "../../../shared/contracts";
import { providerIdForHarness } from "../../../shared/model-routing";
import type { ModelSearchRoute } from "./modelSearch";
import { nextSidebarNavigationIndex } from "./sidebarModel";

export const MODEL_SOURCE_PROVIDER_ORDER = [
  "codex",
  "claude",
  "cursor",
  "antigravity",
  "pi",
  "kimi",
  "opencode",
] as const satisfies readonly ProviderId[];

export const MODEL_SOURCE_PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  kimi: "Kimi Code",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
};

export type ModelSourceFilter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "provider"; providerId: ProviderId }
  | {
      kind: "custom";
      harnessId: string;
      backendProfileId: string;
    }
  | { kind: "harness"; harnessId: string };

export interface ModelSourceSetupAction {
  /** Stable caller-owned action identity. */
  id: string;
  providerId: ProviderId;
  /** Truthful action label, for example "Set up Claude". */
  label: string;
}
export interface ModelSourceRailItem<Route extends ModelSearchRoute = ModelSearchRoute> {
  id: string;
  label: string;
  detail: string | null;
  filter: ModelSourceFilter;
  routes: readonly Route[];
  routeCount: number;
  setupAction: ModelSourceSetupAction | null;
}

export interface DeriveModelSourceRailOptions<
  Route extends ModelSearchRoute = ModelSearchRoute,
> {
  favoriteRouteKeys?: readonly string[];
  favoriteRoutes?: readonly Route[];
  /**
   * Empty provider groups are omitted unless the caller can offer one of these
   * real setup actions. An action is ignored when that provider has routes.
   */
  setupActions?: readonly ModelSourceSetupAction[];
}

function encodedIdentity(value: string): string {
  return encodeURIComponent(value);
}

export function modelSourceFilterId(filter: ModelSourceFilter): string {
  if (filter.kind === "all" || filter.kind === "favorites") return filter.kind;
  if (filter.kind === "provider") return `provider:${filter.providerId}`;
  if (filter.kind === "harness") {
    return `harness:${encodedIdentity(filter.harnessId)}`;
  }
  return [
    "custom",
    encodedIdentity(filter.harnessId),
    encodedIdentity(filter.backendProfileId),
  ].join(":");
}

function routeProviderId(route: ModelSearchRoute): ProviderId | null {
  if (route.sourceProviderId) return route.sourceProviderId;
  if (route.source === "custom") return null;
  return providerIdForHarness(route.harnessId);
}

function railItem<Route extends ModelSearchRoute>(
  input: Omit<ModelSourceRailItem<Route>, "id" | "routeCount">,
): ModelSourceRailItem<Route> {
  return {
    ...input,
    id: modelSourceFilterId(input.filter),
    routeCount: input.routes.length,
  };
}

export function deriveModelSourceRailItems<Route extends ModelSearchRoute>(
  routes: readonly Route[],
  options: DeriveModelSourceRailOptions<Route> = {},
): ModelSourceRailItem<Route>[] {
  const favoriteRouteKeys = new Set(options.favoriteRouteKeys ?? []);
  const setupByProvider = new Map(
    (options.setupActions ?? []).map((action) => [action.providerId, action]),
  );
  const providerRoutes = new Map<ProviderId, Route[]>(
    MODEL_SOURCE_PROVIDER_ORDER.map((providerId) => [providerId, []]),
  );
  const customRoutes = new Map<string, {
    filter: Extract<ModelSourceFilter, { kind: "custom" }>;
    label: string;
    harnessLabel: string;
    routes: Route[];
  }>();
  const otherHarnessRoutes = new Map<string, {
    harnessId: string;
    harnessLabel: string;
    routes: Route[];
  }>();

  for (const route of routes) {
    if (route.source === "custom" && !route.sourceProviderId) {
      const filter = {
        kind: "custom",
        harnessId: route.harnessId,
        backendProfileId: route.backendProfileId,
      } as const;
      const id = modelSourceFilterId(filter);
      const existing = customRoutes.get(id);
      if (existing) existing.routes.push(route);
      else {
        customRoutes.set(id, {
          filter,
          label: route.backendProfileName,
          harnessLabel: route.harnessLabel,
          routes: [route],
        });
      }
      continue;
    }

    const providerId = routeProviderId(route);
    if (providerId) {
      providerRoutes.get(providerId)?.push(route);
      continue;
    }

    const existing = otherHarnessRoutes.get(route.harnessId);
    if (existing) existing.routes.push(route);
    else {
      otherHarnessRoutes.set(route.harnessId, {
        harnessId: route.harnessId,
        harnessLabel: route.harnessLabel,
        routes: [route],
      });
    }
  }

  const items: ModelSourceRailItem<Route>[] = [];
  const favoriteRoutes = options.favoriteRoutes
    ? [...options.favoriteRoutes]
    : routes.filter(({ key }) => favoriteRouteKeys.has(key));
  if (favoriteRoutes.length > 0) {
    items.push(railItem({
      label: "Favorites",
      detail: null,
      filter: { kind: "favorites" },
      routes: favoriteRoutes,
      setupAction: null,
    }));
  }

  for (const providerId of MODEL_SOURCE_PROVIDER_ORDER) {
    const groupedRoutes = providerRoutes.get(providerId) ?? [];
    const setupAction = groupedRoutes.length === 0
      ? setupByProvider.get(providerId) ?? null
      : null;
    if (groupedRoutes.length === 0 && !setupAction) continue;
    items.push(railItem({
      label: MODEL_SOURCE_PROVIDER_LABELS[providerId],
      detail: setupAction ? "Setup" : null,
      filter: { kind: "provider", providerId },
      routes: groupedRoutes,
      setupAction,
    }));
  }

  for (const group of customRoutes.values()) {
    items.push(railItem({
      label: group.label,
      detail: `Custom · ${group.harnessLabel}`,
      filter: group.filter,
      routes: group.routes,
      setupAction: null,
    }));
  }

  for (const group of otherHarnessRoutes.values()) {
    items.push(railItem({
      label: group.harnessLabel,
      detail: "Harness",
      filter: { kind: "harness", harnessId: group.harnessId },
      routes: group.routes,
      setupAction: null,
    }));
  }

  return items;
}

export function filterModelRoutesBySource<Route extends ModelSearchRoute>(
  routes: readonly Route[],
  filter: ModelSourceFilter,
  favoriteRouteKeys: readonly string[] = [],
): Route[] {
  if (filter.kind === "all") return [...routes];
  if (filter.kind === "favorites") {
    const favorites = new Set(favoriteRouteKeys);
    return routes.filter(({ key }) => favorites.has(key));
  }
  if (filter.kind === "custom") {
    return routes.filter((route) =>
      route.source === "custom"
      && !route.sourceProviderId
      && route.harnessId === filter.harnessId
      && route.backendProfileId === filter.backendProfileId);
  }
  if (filter.kind === "harness") {
    return routes.filter((route) =>
      route.source === "built-in"
      && !route.sourceProviderId
      && route.harnessId === filter.harnessId);
  }
  return routes.filter((route) => routeProviderId(route) === filter.providerId);
}

export const nextModelSourceRailIndex = nextSidebarNavigationIndex;

export type ModelSourceRailActivationEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "repeat" | "shiftKey"
>;

export function isModelSourceRailActivationKey(
  event: ModelSourceRailActivationEvent,
): boolean {
  return !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !event.isComposing
    && !event.repeat
    && (event.key === "Enter" || event.key === " ");
}

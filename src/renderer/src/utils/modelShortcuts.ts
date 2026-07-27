import {
  modelFavoriteKey,
  type ResolvedModelFavorite,
} from "./modelFavorites";
import type { ModelSearchRoute } from "./modelSearch";

export const MAX_MODEL_SHORTCUTS = 9;

/**
 * App-wide primary-modifier shortcuts registered by App.tsx. Model shortcuts
 * use digits, but keeping the known reservations explicit lets chooser
 * integration reject collisions instead of relying on that coincidence.
 */
export const INERTIA_RESERVED_PRIMARY_SHORTCUT_KEYS = [
  "b",
  "j",
  "k",
  "n",
] as const;

export type ModelShortcutPlatform = "darwin" | "linux" | "win32" | "unknown";

export interface ModelShortcutBinding<Route extends ModelSearchRoute> {
  favoriteKey: string;
  routeKey: string;
  route: Route;
  key: string;
  code: `Digit${number}`;
  primaryModifier: "Control" | "Meta";
  label: string;
  ariaKeyShortcuts: string;
}

export interface ResolveModelShortcutOptions {
  platform: ModelShortcutPlatform | string;
  /**
   * Additional primary-modifier keys already owned by the calling surface.
   * Keys are compared case-insensitively.
   */
  reservedPrimaryKeys?: readonly string[];
}

export type ModelShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "isComposing"
  | "key"
  | "metaKey"
  | "repeat"
  | "shiftKey"
>;

function normalizedKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function shortcutSlots(reservedPrimaryKeys: readonly string[]): string[] {
  const reserved = new Set([
    ...INERTIA_RESERVED_PRIMARY_SHORTCUT_KEYS,
    ...reservedPrimaryKeys,
  ].map(normalizedKey));

  return Array.from(
    { length: MAX_MODEL_SHORTCUTS },
    (_, index) => String(index + 1),
  ).filter((key) => !reserved.has(key));
}

/**
 * Resolves shortcuts from persisted favorite order, never provider/model
 * discovery order. Only selectable favorites in the current visible result set
 * receive a binding. Filtering therefore keeps the remaining favorite order
 * stable while compacting the available digit slots.
 */
export function resolveModelShortcutBindings<Route extends ModelSearchRoute>(
  favorites: readonly ResolvedModelFavorite<Route>[],
  visibleRoutes: readonly Route[],
  options: ResolveModelShortcutOptions,
): ModelShortcutBinding<Route>[] {
  const visibleByRouteKey = new Map(
    visibleRoutes.map((route) => [route.key, route]),
  );
  const visibleByFavoriteKey = new Map(
    visibleRoutes.map((route) => [
      modelFavoriteKey({
        harnessId: route.harnessId,
        backendProfileId: route.backendProfileId,
        modelId: route.modelId,
        reasoningEffort: route.reasoningEffort ?? null,
      }),
      route,
    ]),
  );
  const slots = shortcutSlots(options.reservedPrimaryKeys ?? []);
  const primaryModifier = options.platform === "darwin" ? "Meta" : "Control";
  const labelPrefix = primaryModifier === "Meta" ? "⌘" : "Ctrl+";
  const seenRoutes = new Set<string>();
  const bindings: ModelShortcutBinding<Route>[] = [];

  for (const favorite of favorites) {
    if (bindings.length === slots.length) break;
    const route = favorite.route
      ? visibleByRouteKey.get(favorite.route.key)
        ?? visibleByFavoriteKey.get(favorite.key)
      : undefined;
    if (!route?.selectable || seenRoutes.has(route.key)) continue;

    const key = slots[bindings.length];
    if (!key) break;
    seenRoutes.add(route.key);
    bindings.push({
      favoriteKey: favorite.key,
      routeKey: route.key,
      route,
      key,
      code: `Digit${Number(key)}`,
      primaryModifier,
      label: `${labelPrefix}${key}`,
      ariaKeyShortcuts: `${primaryModifier}+${key}`,
    });
  }

  return bindings;
}

/**
 * Exact matcher for use inside an open chooser. It intentionally rejects key
 * repeat, composition, extra modifiers, and numpad digits.
 */
export function matchesModelShortcut(
  event: ModelShortcutKeyboardEvent,
  binding: ModelShortcutBinding<ModelSearchRoute>,
): boolean {
  if (
    event.repeat
    || event.isComposing
    || event.altKey
    || event.shiftKey
    || event.metaKey !== (binding.primaryModifier === "Meta")
    || event.ctrlKey !== (binding.primaryModifier === "Control")
  ) {
    return false;
  }
  return event.code
    ? event.code === binding.code
    : event.key === binding.key;
}

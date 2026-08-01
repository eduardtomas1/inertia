import { Search, Star } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import {
  ModelChooserFavoriteButton,
  modelChooserRowFromRoute,
  ModelChooserRow,
} from "./ModelChooserRow";
import { ModelSourceRail } from "./ModelSourceRail";
import { SelectedModelChip } from "./SelectedModelChip";
import {
  modelFavoriteKey,
  readModelFavorites,
  resolveModelFavorites,
  toggleModelFavorite,
  writeModelFavorites,
  type ModelFavoriteReference,
} from "../utils/modelFavorites";
import type { ComposerModelRoute } from "../utils/modelChooserRoutes";
import { searchModelRoutes } from "../utils/modelSearch";
import {
  deriveModelSourceRailItems,
  filterModelRoutesBySource,
  modelSourceFilterId,
  type ModelSourceFilter,
} from "../utils/modelSourceRail";
import {
  matchesModelShortcut,
  resolveModelShortcutBindings,
  type ModelShortcutPlatform,
} from "../utils/modelShortcuts";
import { outsidePointerShouldRestoreFocus } from "../utils/dismissibleMenu";
import type { SelectedModelChipRoute } from "../utils/selectedModelChip";

export type ModelChooserNavigationKey =
  | "ArrowDown"
  | "ArrowUp"
  | "Home"
  | "End";

export interface ModelChooserProps {
  routes: readonly ComposerModelRoute[];
  selectedRoute: SelectedModelChipRoute;
  disabled?: boolean;
  closeSignal?: string | null;
  onSelect: (route: ComposerModelRoute) => void;
  onOpenChange?: (open: boolean) => void;
}

function availableIndices(routes: readonly ComposerModelRoute[]): number[] {
  return routes.flatMap((route, index) => route.selectable ? [index] : []);
}

export function nextModelChooserIndex(
  routes: readonly ComposerModelRoute[],
  currentIndex: number,
  key: ModelChooserNavigationKey,
): number {
  const indices = availableIndices(routes);
  if (indices.length === 0) return -1;
  if (key === "Home") return indices[0]!;
  if (key === "End") return indices.at(-1)!;
  const position = indices.indexOf(currentIndex);
  if (position < 0) {
    return key === "ArrowUp" ? indices.at(-1)! : indices[0]!;
  }
  if (key === "ArrowDown") return indices[(position + 1) % indices.length]!;
  return indices[(position - 1 + indices.length) % indices.length]!;
}

export function modelShortcutPlatform(
  platform: string,
): ModelShortcutPlatform {
  const normalized = platform.toLocaleLowerCase("en-US");
  if (normalized.includes("mac")) return "darwin";
  if (normalized.includes("win")) return "win32";
  if (normalized.includes("linux")) return "linux";
  return "unknown";
}

function initialFavorites(): ModelFavoriteReference[] {
  return typeof window === "undefined"
    ? []
    : readModelFavorites(window.localStorage);
}

function favoriteKeyForRoute(
  route: Pick<
    ComposerModelRoute,
    "harnessId" | "backendProfileId" | "modelId" | "reasoningEffort"
  >,
): string {
  return modelFavoriteKey(route);
}

function activeKeyForRoute(
  route: {
    harnessId: string;
    backendProfileId: string;
    backendConfigurationRevision?: number;
    modelId: string;
    reasoningEffort?: string | null;
  },
): string {
  return JSON.stringify([
    modelFavoriteKey({
      harnessId: route.harnessId,
      backendProfileId: route.backendProfileId,
      modelId: route.modelId,
      reasoningEffort: route.reasoningEffort ?? null,
    }),
    route.backendConfigurationRevision ?? null,
  ]);
}

/**
 * Search operates across discovered routes and saved favorite variants. A
 * favorite keeps its full reasoning identity while an exact discovered
 * duplicate is removed, so selecting a searched favorite cannot silently fall
 * back to the discovered route's default effort.
 */
export function searchableModelChooserRoutes(
  routes: readonly ComposerModelRoute[],
  favoriteRoutes: readonly ComposerModelRoute[],
): ComposerModelRoute[] {
  const seen = new Set<string>();
  return [...favoriteRoutes, ...routes].filter((route) => {
    const key = favoriteKeyForRoute(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function preferredModelChooserSource(
  items: readonly { filter: ModelSourceFilter }[],
): ModelSourceFilter {
  return items.find(({ filter }) => filter.kind === "favorites")?.filter
    ?? items[0]?.filter
    ?? { kind: "all" };
}

export function ModelChooser({
  routes,
  selectedRoute,
  disabled = false,
  closeSignal = null,
  onSelect,
  onOpenChange,
}: ModelChooserProps): JSX.Element {
  const reactId = useId().replaceAll(":", "");
  const dialogId = `${reactId}-model-chooser`;
  const resultsId = `${reactId}-model-results`;
  const searchId = `${reactId}-model-search`;
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusWhenEnabledRef = useRef(false);
  const [open, setOpen] = useState(false);
  useNativePreviewSuspension(open);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<ModelSourceFilter>({
    kind: "all",
  });
  const [favorites, setFavorites] = useState<ModelFavoriteReference[]>(
    initialFavorites,
  );
  const [activeIndex, setActiveIndex] = useState(-1);
  const favoriteKeys = useMemo(
    () => favorites.map(modelFavoriteKey),
    [favorites],
  );
  const resolvedFavorites = useMemo(
    () => resolveModelFavorites(favorites, routes),
    [favorites, routes],
  );
  const resolvedFavoriteRoutes = useMemo(
    () => resolvedFavorites.flatMap(({ route }) => route ? [route] : []),
    [resolvedFavorites],
  );
  const railItems = useMemo(
    () => deriveModelSourceRailItems(routes, {
      favoriteRoutes: resolvedFavoriteRoutes,
    }),
    [resolvedFavoriteRoutes, routes],
  );
  const selectedSourceId = modelSourceFilterId(sourceFilter);
  const searchableRoutes = useMemo(
    () => searchableModelChooserRoutes(routes, resolvedFavoriteRoutes),
    [resolvedFavoriteRoutes, routes],
  );
  const sourceRoutes = useMemo(
    () => query.trim()
      ? searchableRoutes
      : sourceFilter.kind === "favorites"
        ? resolvedFavoriteRoutes
        : filterModelRoutesBySource(routes, sourceFilter),
    [
      query,
      resolvedFavoriteRoutes,
      routes,
      searchableRoutes,
      sourceFilter,
    ],
  );
  const results = useMemo(
    () => searchModelRoutes(sourceRoutes, query),
    [query, sourceRoutes],
  );
  const platform = typeof navigator === "undefined"
    ? "unknown"
    : modelShortcutPlatform(navigator.platform);
  const shortcuts = useMemo(
    () => resolveModelShortcutBindings(
      resolvedFavorites,
      results.items,
      { platform },
    ),
    [platform, resolvedFavorites, results.items],
  );
  const shortcutsByRoute = useMemo(
    () => new Map(shortcuts.map((binding) => [binding.routeKey, binding])),
    [shortcuts],
  );
  const selectedKey = activeKeyForRoute(selectedRoute);

  const restoreTriggerFocus = useCallback((): void => {
    const trigger = triggerRef.current;
    if (!trigger || trigger.disabled) return;
    restoreFocusWhenEnabledRef.current = false;
    trigger.focus();
  }, []);

  const close = useCallback((restoreFocus = true): void => {
    setOpen(false);
    setQuery("");
    onOpenChange?.(false);
    restoreFocusWhenEnabledRef.current = restoreFocus;
    if (restoreFocus) window.requestAnimationFrame(restoreTriggerFocus);
  }, [onOpenChange, restoreTriggerFocus]);

  useEffect(() => {
    if (open || disabled || !restoreFocusWhenEnabledRef.current) return;
    const frame = window.requestAnimationFrame(restoreTriggerFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [disabled, open, restoreTriggerFocus]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = results.items.findIndex((route) =>
      activeKeyForRoute(route) === selectedKey);
    setActiveIndex(selectedIndex >= 0 && results.items[selectedIndex]?.selectable
      ? selectedIndex
      : nextModelChooserIndex(results.items, -1, "Home"));
  }, [open, results.items, selectedKey]);

  useEffect(() => {
    if (!open) return;
    if (railItems.some(({ id }) => id === selectedSourceId)) return;
    setSourceFilter(preferredModelChooserSource(railItems));
  }, [open, railItems, selectedSourceId]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && anchorRef.current?.contains(event.target)
      ) {
        return;
      }
      close(outsidePointerShouldRestoreFocus(event.target));
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [close, open]);

  useEffect(() => {
    if (!open || (!disabled && closeSignal === null)) return;
    close(false);
  }, [close, closeSignal, disabled, open]);

  const select = (route: ComposerModelRoute): void => {
    if (!route.selectable) return;
    onSelect(route);
    close(true);
  };

  const toggleFavorite = (route: ComposerModelRoute): void => {
    const next = toggleModelFavorite(favorites, route);
    setFavorites(next);
    if (typeof window !== "undefined") {
      writeModelFavorites(window.localStorage, next);
    }
  };

  const handleNavigation = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const shortcut = shortcuts.find((binding) =>
      matchesModelShortcut(event.nativeEvent, binding));
    if (shortcut) {
      event.preventDefault();
      select(shortcut.route);
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest(".model-source-rail")
      || target.closest(".model-chooser-row-favorite")
    ) {
      return;
    }
    if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      setActiveIndex((current) =>
        nextModelChooserIndex(
          results.items,
          current,
          event.key as ModelChooserNavigationKey,
        ));
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const route = results.items[activeIndex];
    if (!route?.selectable) return;
    event.preventDefault();
    select(route);
  };

  const activeRoute = results.items[activeIndex] ?? null;
  const activeDescendant = activeRoute
    ? `${reactId}-model-option-${activeIndex}`
    : undefined;
  const chooserRows = results.items.map((route) =>
    modelChooserRowFromRoute(route, {
      active: activeKeyForRoute(route) === selectedKey,
      favorite: favoriteKeys.includes(favoriteKeyForRoute(route)),
      shortcut: shortcutsByRoute.get(route.key) ?? null,
      compatibility: route.rowCompatibility,
    }));

  return (
    <div
      ref={anchorRef}
      className={`model-chooser-anchor${open ? " is-open" : ""}`}
    >
      <SelectedModelChip
        ref={triggerRef}
        route={selectedRoute}
        expanded={open}
        controlsId={dialogId}
        disabled={disabled}
        onOpen={() => {
          if (open) {
            close(true);
            return;
          }
          setSourceFilter(preferredModelChooserSource(railItems));
          setOpen(true);
          onOpenChange?.(true);
        }}
      />
      {open && (
        <div
          id={dialogId}
          className="model-chooser-palette"
          role="dialog"
          aria-modal="false"
          aria-label="Choose model"
          onKeyDown={handleNavigation}
        >
          <div className="model-chooser-header">
            <label htmlFor={searchId}>
              <Search size={15} aria-hidden="true" />
              <span className="visually-hidden">Search models</span>
            </label>
            <input
              ref={searchRef}
              id={searchId}
              type="search"
              value={query}
              autoComplete="off"
              spellCheck="false"
              placeholder="Search models, backends, or harnesses…"
              aria-label="Search models"
              aria-controls={resultsId}
              aria-activedescendant={activeDescendant}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="model-chooser-body">
            <ModelSourceRail
              items={railItems}
              selectedId={selectedSourceId}
              resultsId={resultsId}
              onFilterChange={(filter) => {
                setSourceFilter(filter);
                window.requestAnimationFrame(() => searchRef.current?.focus());
              }}
            />
            <div className="model-chooser-results-wrap">
              <div
                className="model-chooser-results"
              >
                <div
                  id={resultsId}
                  className="model-chooser-listbox"
                  role="listbox"
                  aria-label="Model results"
                >
                  {results.items.map((route, index) => (
                    <div
                      key={route.key}
                      className={activeIndex === index
                        ? "model-chooser-result is-navigated"
                        : "model-chooser-result"}
                      role="presentation"
                      style={{ gridRow: index + 1 }}
                      onPointerMove={() => {
                        if (route.selectable) setActiveIndex(index);
                      }}
                    >
                      <ModelChooserRow
                        row={chooserRows[index]!}
                        optionId={`${reactId}-model-option-${index}`}
                        onSelect={() => select(route)}
                      />
                    </div>
                  ))}
                </div>
                {chooserRows.length > 0 && (
                  <div
                    className="model-chooser-favorite-actions"
                    role="group"
                    aria-label="Model favorite actions"
                  >
                    {chooserRows.map((row, index) => (
                      <div
                        key={row.key}
                        className="model-chooser-favorite-slot"
                        role="presentation"
                        style={{ gridRow: index + 1 }}
                        onPointerMove={() => {
                          if (row.selectable) setActiveIndex(index);
                        }}
                      >
                        <ModelChooserFavoriteButton
                          row={row}
                          onFavoriteToggle={() =>
                            toggleFavorite(results.items[index]!)}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {results.emptyState && (
                  <div className="model-chooser-empty" role="status">
                    <Search size={17} aria-hidden="true" />
                    <span>
                      <strong>{results.emptyState.kind === "no-models"
                        ? "No models yet"
                        : "No matching models"}</strong>
                      <small>{results.emptyState.message}</small>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="model-chooser-footer">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>Enter</kbd> select</span>
            <span><kbd>Esc</kbd> close</span>
            {shortcuts.length > 0 && (
              <span className="model-chooser-favorite-hint">
                <Star size={10} aria-hidden="true" />
                {shortcuts.length} favorite {shortcuts.length === 1
                  ? "shortcut"
                  : "shortcuts"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

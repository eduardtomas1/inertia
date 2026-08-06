import { Search, Star } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import {
  modelChooserRowFromRoute,
  ModelChooserRow,
  type ModelChooserRowData,
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
  onSelect: (route: ComposerModelRoute) => void | Promise<void>;
  onOpenChange?: (open: boolean) => void;
}

export const MODEL_CHOOSER_VIRTUALIZATION_MIN_RESULTS = 100;
const MODEL_CHOOSER_INITIAL_VIRTUAL_RECT = {
  width: 640,
  height: 400,
};
const MODEL_CHOOSER_ESTIMATED_ROW_SIZE = 54;
const MODEL_CHOOSER_FALLBACK_RENDER_COUNT = 16;

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

interface ModelChooserResultProps {
  route: ComposerModelRoute;
  row: ModelChooserRowData;
  index: number;
  resultCount: number;
  optionId: string;
  navigated: boolean;
  onNavigate: (index: number) => void;
  onSelect: (route: ComposerModelRoute) => void;
  onFavoriteToggle: (route: ComposerModelRoute) => void;
  virtualStart?: number;
  onMeasure?: (element: Element | null) => void;
}

const ModelChooserResult = memo(function ModelChooserResult({
  route,
  row,
  index,
  resultCount,
  optionId,
  navigated,
  onNavigate,
  onSelect,
  onFavoriteToggle,
  virtualStart,
  onMeasure,
}: ModelChooserResultProps): JSX.Element {
  const selectRow = useCallback(() => onSelect(route), [onSelect, route]);
  const toggleFavorite = useCallback(
    () => onFavoriteToggle(route),
    [onFavoriteToggle, route],
  );
  return (
    <li
      className={navigated
        ? "model-chooser-result is-navigated"
        : "model-chooser-result"}
      data-index={virtualStart === undefined ? undefined : index}
      ref={virtualStart === undefined ? undefined : onMeasure}
      style={virtualStart === undefined ? undefined : {
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${virtualStart}px)`,
      }}
      aria-posinset={index + 1}
      aria-setsize={resultCount}
      onPointerMove={() => {
        if (route.selectable) onNavigate(index);
      }}
    >
      <ModelChooserRow
        row={row}
        optionId={optionId}
        onSelect={selectRow}
        onFavoriteToggle={toggleFavorite}
      />
    </li>
  );
});

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
  const resultsScrollRef = useRef<HTMLDivElement>(null);
  const restoreFocusWhenEnabledRef = useRef(false);
  const activeRouteKeyRef = useRef<string | null>(null);
  const activeSelectionContextRef = useRef<string | null>(null);
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
    () => new Set(favorites.map(modelFavoriteKey)),
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
  const virtualized = results.items.length
    >= MODEL_CHOOSER_VIRTUALIZATION_MIN_RESULTS;
  const resultVirtualizer = useVirtualizer({
    count: virtualized ? results.items.length : 0,
    getScrollElement: () => resultsScrollRef.current,
    estimateSize: () => MODEL_CHOOSER_ESTIMATED_ROW_SIZE,
    initialRect: MODEL_CHOOSER_INITIAL_VIRTUAL_RECT,
    overscan: 6,
    getItemKey: (index) => results.items[index]?.key ?? index,
  });
  const virtualItems = virtualized
    ? resultVirtualizer.getVirtualItems()
    : [];
  const renderedResultItems: readonly {
    index: number;
    virtualStart?: number;
  }[] = !virtualized
    ? results.items.map((_, index) => ({ index }))
    : virtualItems.length > 0
      ? virtualItems.map(({ index, start }) => ({ index, virtualStart: start }))
      : Array.from(
          {
            length: Math.min(
              MODEL_CHOOSER_FALLBACK_RENDER_COUNT,
              results.items.length,
            ),
          },
          (_, offset) => {
            const startIndex = Math.min(
              Math.max(activeIndex - 6, 0),
              Math.max(
                results.items.length - MODEL_CHOOSER_FALLBACK_RENDER_COUNT,
                0,
              ),
            );
            const index = startIndex + offset;
            return {
              index,
              virtualStart: index * MODEL_CHOOSER_ESTIMATED_ROW_SIZE,
            };
          },
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

  useLayoutEffect(() => {
    if (!open) {
      activeRouteKeyRef.current = null;
      activeSelectionContextRef.current = null;
      return;
    }
    const selectionContext = JSON.stringify([
      query,
      selectedSourceId,
      selectedKey,
    ]);
    const preserveNavigation =
      activeSelectionContextRef.current === selectionContext;
    const preservedIndex = preserveNavigation && activeRouteKeyRef.current
      ? results.items.findIndex((route) =>
        route.key === activeRouteKeyRef.current && route.selectable)
      : -1;
    const selectedIndex = results.items.findIndex((route) =>
      activeKeyForRoute(route) === selectedKey && route.selectable);
    const nextIndex = preservedIndex >= 0
      ? preservedIndex
      : selectedIndex >= 0
        ? selectedIndex
        : nextModelChooserIndex(results.items, -1, "Home");
    activeSelectionContextRef.current = selectionContext;
    activeRouteKeyRef.current = results.items[nextIndex]?.key ?? null;
    setActiveIndex((current) => current === nextIndex ? current : nextIndex);
  }, [open, query, results.items, selectedKey, selectedSourceId]);

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

  const select = useCallback((route: ComposerModelRoute): void => {
    if (!route.selectable) return;
    const completion = onSelect(route);
    if (!completion) {
      close(true);
      return;
    }
    void completion.then(
      () => close(true),
      () => undefined,
    );
  }, [close, onSelect]);

  const toggleFavorite = useCallback((route: ComposerModelRoute): void => {
    setFavorites((current) => {
      const next = toggleModelFavorite(current, route);
      if (typeof window !== "undefined") {
        writeModelFavorites(window.localStorage, next);
      }
      return next;
    });
  }, []);

  const navigateTo = useCallback((index: number): void => {
    activeRouteKeyRef.current = results.items[index]?.key ?? null;
    setActiveIndex(index);
  }, [results.items]);

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
      || target.closest(".model-chooser-row-option")
      || target.closest(".model-chooser-row-favorite")
    ) {
      return;
    }
    if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      setActiveIndex((current) => {
        const nextIndex = nextModelChooserIndex(
          results.items,
          current,
          event.key as ModelChooserNavigationKey,
        );
        activeRouteKeyRef.current = results.items[nextIndex]?.key ?? null;
        return nextIndex;
      });
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const route = results.items[activeIndex];
    if (!route?.selectable) return;
    event.preventDefault();
    select(route);
  };

  const activeRoute = results.items[activeIndex] ?? null;
  const activeResultMounted = !virtualized
    || renderedResultItems.some(({ index }) => index === activeIndex);
  const activeDescendant = activeRoute && activeResultMounted
    ? `${reactId}-model-option-${activeIndex}`
    : undefined;
  const chooserRows = useMemo(() => results.items.map((route) =>
    modelChooserRowFromRoute(route, {
      active: activeKeyForRoute(route) === selectedKey,
      favorite: favoriteKeys.has(favoriteKeyForRoute(route)),
      shortcut: shortcutsByRoute.get(route.key) ?? null,
      compatibility: route.rowCompatibility,
    })), [favoriteKeys, results.items, selectedKey, shortcutsByRoute]);

  useLayoutEffect(() => {
    if (!open || !virtualized || activeIndex < 0) return;
    resultVirtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, open, resultVirtualizer, virtualized]);

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
                ref={resultsScrollRef}
                className="model-chooser-results"
              >
                <ul
                  id={resultsId}
                  className="model-chooser-list"
                  aria-label="Model results"
                  style={virtualized ? {
                    position: "relative",
                    height: `${resultVirtualizer.getTotalSize()}px`,
                  } : undefined}
                >
                  {renderedResultItems.map((item) => {
                    const route = results.items[item.index]!;
                    return (
                      <ModelChooserResult
                        key={route.key}
                        route={route}
                        row={chooserRows[item.index]!}
                        index={item.index}
                        resultCount={results.items.length}
                        optionId={`${reactId}-model-option-${item.index}`}
                        navigated={activeIndex === item.index}
                        onNavigate={navigateTo}
                        onSelect={select}
                        onFavoriteToggle={toggleFavorite}
                        {...(item.virtualStart === undefined ? {} : {
                          virtualStart: item.virtualStart,
                          onMeasure: resultVirtualizer.measureElement,
                        })}
                      />
                    );
                  })}
                </ul>
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

import { Search, Star } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

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
  const [open, setOpen] = useState(false);
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
  const railItems = useMemo(
    () => deriveModelSourceRailItems(routes, {
      favoriteRouteKeys: favoriteKeys,
    }),
    [favoriteKeys, routes],
  );
  const selectedSourceId = modelSourceFilterId(sourceFilter);
  const sourceRoutes = useMemo(
    () => filterModelRoutesBySource(routes, sourceFilter, favoriteKeys),
    [favoriteKeys, routes, sourceFilter],
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
  const selectedKey = selectedRoute.key;

  const close = (restoreFocus = true): void => {
    setOpen(false);
    setQuery("");
    setSourceFilter({ kind: "all" });
    onOpenChange?.(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = results.items.findIndex(({ key }) =>
      key === selectedKey);
    setActiveIndex(selectedIndex >= 0 && results.items[selectedIndex]?.selectable
      ? selectedIndex
      : nextModelChooserIndex(results.items, -1, "Home"));
  }, [open, results.items, selectedKey]);

  useEffect(() => {
    if (!open) return;
    if (railItems.some(({ id }) => id === selectedSourceId)) return;
    setSourceFilter({ kind: "all" });
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
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener(
      "pointerdown",
      handlePointerDown,
      true,
    );
  }, [open]);

  useEffect(() => {
    if (!open || (!disabled && closeSignal === null)) return;
    close(false);
  }, [closeSignal, disabled, open]);

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
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
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
      active: route.key === selectedKey,
      favorite: favoriteKeys.includes(route.key),
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

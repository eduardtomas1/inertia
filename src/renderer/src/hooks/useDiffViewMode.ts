import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

import { layoutStorage } from "../utils/layoutStorage";

export type DiffViewMode = "unified" | "split";

/**
 * Below this width the split view falls back to unified. Split view collapses
 * the changed-file list into a strip above the diff (it takes no width), so the
 * panel width is the width both diff columns share. Columns are therefore at
 * least 360 px and scroll sideways instead of wrapping.
 */
export const DIFF_SPLIT_MIN_WIDTH = 720;

export function diffViewModeStorageKey(scope: string): string {
  return `inertia:layout:diff-view:${encodeURIComponent(scope)}:v1`;
}

function storedMode(scope: string | null): DiffViewMode {
  return scope !== null && layoutStorage.getItem(diffViewModeStorageKey(scope)) === "split"
    ? "split"
    : "unified";
}

export interface DiffViewModeState {
  /** The chosen mode for this chat. */
  mode: DiffViewMode;
  /** The mode actually rendered: split falls back to unified when narrow. */
  renderedMode: DiffViewMode;
  narrow: boolean;
  setMode: (mode: DiffViewMode) => void;
}

/**
 * Per-chat Unified | Split preference, stored beside the other per-chat layout
 * keys. Unified is the default and is not written to storage.
 */
export function useDiffViewMode(
  scope: string | null,
  measuredRef: RefObject<HTMLElement | null>,
): DiffViewModeState {
  const [persisted, setPersisted] = useState(() => ({ scope, mode: storedMode(scope) }));
  const mode = persisted.scope === scope ? persisted.mode : storedMode(scope);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = measuredRef.current;
    if (!element) return;
    const measure = (): void => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measuredRef]);

  const setMode = useCallback((next: DiffViewMode) => {
    if (scope !== null) {
      if (next === "split") layoutStorage.setItem(diffViewModeStorageKey(scope), "split");
      else layoutStorage.removeItem(diffViewModeStorageKey(scope));
    }
    setPersisted({ scope, mode: next });
  }, [scope]);

  const narrow = width < DIFF_SPLIT_MIN_WIDTH;
  return { mode, renderedMode: narrow ? "unified" : mode, narrow, setMode };
}

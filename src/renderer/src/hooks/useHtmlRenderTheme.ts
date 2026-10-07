import { useSyncExternalStore } from "react";
import {
  HTML_RENDER_THEME_VARIABLES,
  defaultHtmlRenderTheme,
  sanitizeHtmlRenderTheme,
  type HtmlRenderTheme,
} from "@shared/html-render";

const THEME_ATTRIBUTES = ["data-theme", "data-color-theme", "style"];

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let snapshot: HtmlRenderTheme | null = null;
let serializedSnapshot = "";

function readHtmlRenderTheme(): HtmlRenderTheme {
  if (typeof document === "undefined") return defaultHtmlRenderTheme("light");
  const root = document.documentElement;
  const scheme = root.dataset.theme === "dark" ? "dark" : "light";
  const fallback = defaultHtmlRenderTheme(scheme);
  const styles = window.getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const [alias, token] of HTML_RENDER_THEME_VARIABLES) {
    const value = styles.getPropertyValue(token).trim();
    variables[alias] = value || fallback.variables[alias] || "";
  }
  return sanitizeHtmlRenderTheme({ scheme, variables }) ?? fallback;
}

/** Re-reads the theme; identity only changes when a resolved value changes. */
function refreshSnapshot(): boolean {
  const next = readHtmlRenderTheme();
  const serialized = JSON.stringify(next);
  if (snapshot && serialized === serializedSnapshot) return false;
  snapshot = next;
  serializedSnapshot = serialized;
  return true;
}

function notifyIfChanged(): void {
  if (!refreshSnapshot()) return;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(notifyIfChanged);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: THEME_ATTRIBUTES,
    });
    // Custom palettes rewrite a generated <style> without touching the root attributes.
    observer.observe(document.head, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    refreshSnapshot();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = null;
  };
}

function getSnapshot(): HtmlRenderTheme {
  // Without a live observer the cache may be stale, so read through it.
  if (!observer || !snapshot) refreshSnapshot();
  return snapshot!;
}

function getServerSnapshot(): HtmlRenderTheme {
  return defaultHtmlRenderTheme("light");
}

/**
 * The app's resolved theme under the page-facing aliases a visual reply styles
 * against. One document-level observer serves every mounted frame.
 */
export function useHtmlRenderTheme(): HtmlRenderTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

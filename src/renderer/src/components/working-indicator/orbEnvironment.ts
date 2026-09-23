import { createOrbLoop, type OrbLoop, type OrbLoopEnvironment } from "./orbLoop";

const THEME_ATTRIBUTES = ["data-theme", "data-color-theme", "style", "class"];

let colorProbe: CanvasRenderingContext2D | null | undefined;

function normalizedCssColor(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(?:#|rgba?\()/iu.test(trimmed)) return trimmed;
  if (colorProbe === undefined) {
    colorProbe = document.createElement("canvas").getContext("2d");
  }
  if (!colorProbe) return null;
  colorProbe.fillStyle = "#000000";
  colorProbe.fillStyle = trimmed;
  const resolved = String(colorProbe.fillStyle);
  return resolved === "#000000" && !/^(?:black|#000(?:000)?)$/iu.test(trimmed) ? null : resolved;
}

function createIntersectionRegistry(): OrbLoopEnvironment["observeIntersection"] {
  const listeners = new Map<Element, (visible: boolean) => void>();
  let observer: IntersectionObserver | null = null;
  return (element, listener) => {
    if (typeof IntersectionObserver === "undefined") return () => undefined;
    observer ??= new IntersectionObserver((records) => {
      for (const record of records) listeners.get(record.target)?.(record.isIntersecting);
    });
    listeners.set(element, listener);
    observer.observe(element);
    return () => {
      if (!listeners.delete(element)) return;
      observer?.unobserve(element);
      if (listeners.size === 0) {
        observer?.disconnect();
        observer = null;
      }
    };
  };
}

export function browserOrbEnvironment(): OrbLoopEnvironment {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const forcedColors = window.matchMedia("(forced-colors: active)");
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
  return {
    now: () => performance.now(),
    requestFrame: (callback) => window.requestAnimationFrame(() => callback()),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
    isDocumentHidden: () => document.visibilityState === "hidden",
    prefersReducedMotion: () => reducedMotion.matches,
    forcedColors: () => forcedColors.matches,
    isDarkTheme: () => {
      const theme = document.documentElement.dataset.theme;
      return theme === "dark" || (theme !== "light" && darkScheme.matches);
    },
    devicePixelRatio: () => window.devicePixelRatio,
    resolveColor: (element, source) => {
      const styles = window.getComputedStyle(element);
      return normalizedCssColor(
        source === "accent" ? styles.getPropertyValue("--accent") : styles.color,
      );
    },
    subscribe: (listener) => {
      const mutations = new MutationObserver(listener);
      mutations.observe(document.documentElement, {
        attributes: true,
        attributeFilter: THEME_ATTRIBUTES,
      });
      document.addEventListener("visibilitychange", listener);
      for (const query of [reducedMotion, forcedColors, darkScheme]) {
        query.addEventListener("change", listener);
      }
      return () => {
        mutations.disconnect();
        document.removeEventListener("visibilitychange", listener);
        for (const query of [reducedMotion, forcedColors, darkScheme]) {
          query.removeEventListener("change", listener);
        }
      };
    },
    observeIntersection: createIntersectionRegistry(),
    createGlowLayer: (width, height) => {
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        return context ? { canvas, context } : null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      return context ? { canvas, context } : null;
    },
  };
}

let sharedLoop: OrbLoop | null = null;

export function sharedOrbLoop(): OrbLoop {
  sharedLoop ??= createOrbLoop(browserOrbEnvironment());
  return sharedLoop;
}

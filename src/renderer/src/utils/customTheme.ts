import type { ResolvedTheme } from "./theme";

export const CUSTOM_COLOR_CACHE_KEY = "inertia:custom-color:v1";
export const CUSTOM_THEME_STYLE_ID = "inertia-custom-color-theme";
export type PaletteTokens = readonly (readonly [string, string])[];

export function isCustomColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);
}

function readCache(storage: Pick<Storage, "getItem">, mode: ResolvedTheme): { color: string; tokens?: unknown } | null {
  try {
    const cached: unknown = JSON.parse(storage.getItem(`${CUSTOM_COLOR_CACHE_KEY}:${mode}`) ?? "null");
    return cached && typeof cached === "object" && "color" in cached && isCustomColor(cached.color)
      ? cached as { color: string; tokens?: unknown } : null;
  } catch {
    return null;
  }
}

export function cachedCustomColor(storage: Pick<Storage, "getItem">, mode: ResolvedTheme): string | null {
  return readCache(storage, mode)?.color ?? null;
}

export function cachedCustomPalette(storage: Pick<Storage, "getItem">, color: string | null | undefined, mode: ResolvedTheme): PaletteTokens | null {
  const cached = readCache(storage, mode);
  if (!cached || cached.color !== color || !cached.tokens || typeof cached.tokens !== "object") return null;
  const tokens = Object.entries(cached.tokens);
  return tokens.length > 0 && tokens.length <= 64 && tokens.every(([name, value]) =>
    /^[a-z][a-z0-9-]{0,40}$/u.test(name) && typeof value === "string"
    && (/^#[0-9a-f]{6}$/iu.test(value) || /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.\d{1,3}\)$/u.test(value))) ? tokens : null;
}

export function cacheCustomColor(storage: Pick<Storage, "setItem">, color: string | null | undefined, mode: ResolvedTheme, tokens: PaletteTokens = []): void {
  try {
    storage.setItem(`${CUSTOM_COLOR_CACHE_KEY}:${mode}`, JSON.stringify(isCustomColor(color)
      ? { color, tokens: Object.fromEntries(tokens) } : null));
  } catch {
    return;
  }
}

export function applyCustomPalette(tokens: PaletteTokens | null): void {
  const existing = document.getElementById(CUSTOM_THEME_STYLE_ID);
  if (!tokens) { existing?.remove(); return; }
  const style = existing ?? document.createElement("style");
  style.id = CUSTOM_THEME_STYLE_ID;
  style.textContent = `:root[data-theme][data-color-theme="custom"]{${tokens.map(([name, value]) => `--${name}:${value};`).join("")}}`;
  if (!existing) document.head.append(style);
}

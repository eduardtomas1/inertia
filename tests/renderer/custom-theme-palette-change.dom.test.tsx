import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "../../src/renderer/src/hooks/useTheme";
import { cacheCustomColor } from "../../src/renderer/src/utils/customTheme";
import { buildCustomPaletteTokens } from "../../src/shared/theme/color-theme-spec";

const accent = (color: string) => Object.fromEntries(buildCustomPaletteTokens(color, "light")).accent;
const currentAccent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent");
const settings = (lightCustomColor: string) => ({ theme: "light" as const, colorTheme: "inertia" as const, lightCustomColor, darkCustomColor: null as string | null });

function observeTheme(): { seen: string[]; disconnect: () => void } {
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    seen.push(`${document.documentElement.dataset.colorTheme}:${currentAccent() || "none"}`);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-theme", "style"] });
  return { seen, disconnect: () => observer.disconnect() };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.colorTheme;
  document.getElementById("inertia-custom-color-theme")?.remove();
  window.localStorage.clear();
});

describe("custom palette changes on the active appearance", () => {
  it("keeps the current custom palette while the palette module loads", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(window.matchMedia("(prefers-color-scheme: dark)"));
    cacheCustomColor(window.localStorage, "#0d9488", "light", buildCustomPaletteTokens("#0d9488", "light"));
    const { rerender, unmount } = renderHook((props) => useTheme(props), { initialProps: settings("#0d9488") });
    expect(document.documentElement.dataset.colorTheme).toBe("custom");
    expect(currentAccent()).toBe(accent("#0d9488"));
    const observer = observeTheme();
    act(() => { rerender(settings("#f97316")); });
    expect(document.documentElement.dataset.colorTheme).toBe("custom");
    expect(currentAccent()).toBe(accent("#0d9488"));
    await act(async () => { await new Promise((resolveTimer) => setTimeout(resolveTimer, 50)); });
    observer.disconnect();
    expect(document.documentElement.dataset.colorTheme).toBe("custom");
    expect(currentAccent()).toBe(accent("#f97316"));
    expect(observer.seen.length).toBeGreaterThan(0);
    expect(observer.seen.filter((entry) => !entry.startsWith("custom:"))).toEqual([]);
    unmount();
  });

  it("applies a new custom palette synchronously once the palette module has loaded", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(window.matchMedia("(prefers-color-scheme: dark)"));
    const { rerender, unmount } = renderHook((props) => useTheme(props), { initialProps: settings("#0d9488") });
    await act(async () => { await new Promise((resolveTimer) => setTimeout(resolveTimer, 50)); });
    expect(currentAccent()).toBe(accent("#0d9488"));
    const observer = observeTheme();
    act(() => { rerender(settings("#3a86ff")); });
    expect(document.documentElement.dataset.colorTheme).toBe("custom");
    expect(currentAccent()).toBe(accent("#3a86ff"));
    await act(async () => { await new Promise((resolveTimer) => setTimeout(resolveTimer, 50)); });
    observer.disconnect();
    expect(observer.seen.filter((entry) => !entry.startsWith("custom:"))).toEqual([]);
    unmount();
  });
});

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "../../src/renderer/src/hooks/useTheme";
import { cacheCustomColor } from "../../src/renderer/src/utils/customTheme";
import { buildCustomPaletteTokens } from "../../src/shared/theme/color-theme-spec";

const bootstrap = readFileSync(resolve("src/renderer/public/theme-bootstrap.js"), "utf8");
afterEach(() => { vi.restoreAllMocks(); document.documentElement.removeAttribute("style"); document.getElementById("inertia-custom-color-theme")?.remove(); window.localStorage.clear(); });

describe("custom theme rendering", () => {
  it("updates the active palette on system changes and removes overrides when returning to a preset", async () => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const { rerender, unmount } = renderHook((settings) => useTheme(settings), {
      initialProps: { theme: "system" as const, colorTheme: "inertia" as const, lightCustomColor: "#0d9488" as string | null, darkCustomColor: "#f97316" },
    });
    await waitFor(() => expect(document.documentElement.dataset.colorTheme).toBe("custom"));
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent"))
      .toBe(Object.fromEntries(buildCustomPaletteTokens("#0d9488", "light")).accent);
    act(() => { Object.defineProperty(media, "matches", { configurable: true, value: true }); media.dispatchEvent(new Event("change")); });
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent"))
      .toBe(Object.fromEntries(buildCustomPaletteTokens("#f97316", "dark")).accent);
    rerender({ theme: "system", colorTheme: "inertia", lightCustomColor: null, darkCustomColor: "#f97316" });
    act(() => { Object.defineProperty(media, "matches", { configurable: true, value: false }); media.dispatchEvent(new Event("change")); });
    expect(document.documentElement.dataset.colorTheme).toBe("inertia");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent")).toBe("");
    unmount();
  });

  it("paints the cached custom palette before React starts", () => {
    window.localStorage.setItem("inertia:theme-preference:v1", "dark");
    cacheCustomColor(window.localStorage, "#f97316", "dark", buildCustomPaletteTokens("#f97316", "dark"));
    runInNewContext(bootstrap, { window, document, HTMLLinkElement });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.colorTheme).toBe("custom");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent"))
      .toBe(Object.fromEntries(buildCustomPaletteTokens("#f97316", "dark")).accent);
  });
});

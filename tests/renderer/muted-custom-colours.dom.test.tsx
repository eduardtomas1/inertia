import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceSettings } from "../../src/renderer/src/components/settings/sections/AppearanceSettings";
import { SETTINGS_SECTION_ROWS } from "../../src/renderer/src/components/settingsRows";
import { useTheme } from "../../src/renderer/src/hooks/useTheme";
import { cachedAppSettings } from "../../src/renderer/src/utils/cachedSettings";
import { cacheCustomColor, cachedCustomPalette } from "../../src/renderer/src/utils/customTheme";
import { defaultSettings } from "../../src/shared/contracts";
import { buildCustomPaletteTokens } from "../../src/shared/theme/color-theme-spec";

const accent = (color: string, muted: boolean) => Object.fromEntries(buildCustomPaletteTokens(color, "light", muted)).accent;
const currentAccent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent");
const settle = () => act(async () => { await new Promise((resolveTimer) => setTimeout(resolveTimer, 50)); });

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.colorTheme;
  document.getElementById("inertia-custom-color-theme")?.remove();
  window.localStorage.clear();
});

describe("Muted colours row", () => {
  it("is listed with the theme rows and unavailable until a custom colour is chosen", () => {
    expect(SETTINGS_SECTION_ROWS.find(({ id }) => id === "appearance")!.rows)
      .toContainEqual(expect.objectContaining({ id: "muted-custom-colours", title: "Muted colours", group: "Theme" }));
    const onUpdate = vi.fn(async () => undefined);
    render(<AppearanceSettings settings={defaultSettings} disabled={false} onUpdate={onUpdate} />);
    const control = screen.getByRole("switch", { name: "Muted colours" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeChecked();
    control.focus();
    expect(control).toHaveFocus();
    fireEvent.click(control);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("saves the muted treatment for the custom colours", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const { container } = render(<AppearanceSettings settings={{ ...defaultSettings, lightCustomColor: "#0d9488" }} disabled={false} onUpdate={onUpdate} />);
    const control = screen.getByRole("switch", { name: "Muted colours" });
    expect(control).not.toHaveAttribute("aria-disabled");
    await act(async () => { fireEvent.click(control); });
    expect(onUpdate).toHaveBeenCalledWith({ mutedCustomColors: true });
    const row = container.querySelector<HTMLElement>('[data-setting-id="muted-custom-colours"]')!;
    expect(within(row).getByText("Softens custom colours for a quieter workbench.")).toBeVisible();
    expect(within(row).getByRole("status")).toHaveTextContent("Saved");
  });
});

describe("muted custom palettes", () => {
  it("applies and switches the muted treatment on the active appearance", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(window.matchMedia("(prefers-color-scheme: dark)"));
    const props = (mutedCustomColors: boolean) => ({
      theme: "light" as const, colorTheme: "inertia" as const, lightCustomColor: "#f97316", darkCustomColor: null, mutedCustomColors,
    });
    const { rerender, unmount } = renderHook((settings) => useTheme(settings), { initialProps: props(true) });
    await settle();
    expect(document.documentElement.dataset.colorTheme).toBe("custom");
    expect(currentAccent()).toBe(accent("#f97316", true));
    act(() => { rerender(props(false)); });
    expect(currentAccent()).toBe(accent("#f97316", false));
    expect(cachedCustomPalette(window.localStorage, "#f97316", "light", false)).toEqual(buildCustomPaletteTokens("#f97316", "light"));
    act(() => { rerender(props(true)); });
    expect(currentAccent()).toBe(accent("#f97316", true));
    expect(cachedAppSettings().mutedCustomColors).toBe(true);
    unmount();
  });

  it("restores the cached muted choice before the runtime snapshot arrives", () => {
    cacheCustomColor(window.localStorage, "#0d9488", "dark", buildCustomPaletteTokens("#0d9488", "dark", true), true);
    expect(cachedAppSettings()).toMatchObject({ darkCustomColor: "#0d9488", mutedCustomColors: true });
    expect(cachedCustomPalette(window.localStorage, "#0d9488", "dark", true)).toEqual(buildCustomPaletteTokens("#0d9488", "dark", true));
    expect(cachedCustomPalette(window.localStorage, "#0d9488", "dark", false)).toBeNull();
  });
});

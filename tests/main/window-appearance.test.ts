import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  WINDOW_TITLE_BAR_SYMBOL,
  applyWindowTheme,
  parseWindowThemePreference,
  readWindowThemePreference,
  resolveWindowBackground,
  windowChromeOptions,
  writeWindowThemePreference,
} from "../../src/main/window-appearance";
import { MAC_TRAFFIC_LIGHT_POSITION, WINDOW_HEADER_HEIGHT } from "../../src/shared/window-chrome";

describe("window appearance", () => {
  it("accepts only supported cached theme preferences", () => {
    expect(parseWindowThemePreference({ theme: "light" })).toBe("light");
    expect(parseWindowThemePreference({ theme: "dark" })).toBe("dark");
    expect(parseWindowThemePreference({ theme: "system" })).toBe("system");
    expect(parseWindowThemePreference({ theme: "green" })).toBe("system");
    expect(parseWindowThemePreference(null)).toBe("system");
  });

  it("matches the native first-paint background to the resolved theme", () => {
    expect(resolveWindowBackground("light", true)).toBe("#fafafd");
    expect(resolveWindowBackground("dark", false)).toBe("#18181b");
    expect(resolveWindowBackground("system", false)).toBe("#fafafd");
    expect(resolveWindowBackground("system", true)).toBe("#18181b");
  });

  it("persists a small validated cache and safely falls back from invalid files", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-window-appearance-"));
    const path = join(directory, "appearance.json");
    try {
      expect(readWindowThemePreference(path)).toBe("system");
      writeWindowThemePreference(path, "dark");
      expect(readWindowThemePreference(path)).toBe("dark");
      writeFileSync(path, "{\"theme\":\"unknown\"}", "utf8");
      expect(readWindowThemePreference(path)).toBe("system");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hides the native title bar on macOS with traffic lights centred on the 48px header", () => {
    expect(windowChromeOptions("darwin", "light")).toEqual({
      backgroundColor: "#fafafd",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 17 },
    });
    expect(WINDOW_HEADER_HEIGHT).toBe(48);
    expect(MAC_TRAFFIC_LIGHT_POSITION.y + 7).toBe(WINDOW_HEADER_HEIGHT / 2);
  });

  it("draws a transparent Windows title bar overlay sized to the header with themed symbols", () => {
    expect(windowChromeOptions("win32", "dark")).toEqual({
      backgroundColor: "#18181b",
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: "#ededf7", height: 48 },
    });
    expect(windowChromeOptions("linux", "light")).toEqual({ backgroundColor: "#fafafd" });
  });

  it("repaints the background and Windows overlay symbols when the theme changes", () => {
    const calls: unknown[] = [];
    const window = {
      setBackgroundColor: (color: string) => calls.push(["background", color]),
      setTitleBarOverlay: (options: unknown) => calls.push(["overlay", options]),
    };
    applyWindowTheme(window, "win32", "light");
    expect(calls).toEqual([
      ["background", "#fafafd"],
      ["overlay", { color: "#00000000", symbolColor: "#212126", height: 48 }],
    ]);
    calls.length = 0;
    applyWindowTheme(window, "darwin", "dark");
    applyWindowTheme(window, "linux", "dark");
    expect(calls).toEqual([["background", "#18181b"], ["background", "#18181b"]]);
  });

  it("paints the overlay symbols in the text colour of each theme", () => {
    const css = readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8");
    const text = (block: string) => new RegExp(`${block.replace(/[[\]]/gu, "\\$&")} \\{[\\s\\S]*?\\n  --text: (?<value>#[0-9a-f]{6});`, "u").exec(css)?.groups?.value;
    expect(WINDOW_TITLE_BAR_SYMBOL.light).toBe(text(":root"));
    expect(WINDOW_TITLE_BAR_SYMBOL.dark).toBe(text(':root[data-theme="dark"]'));
  });
});

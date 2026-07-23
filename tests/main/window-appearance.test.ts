import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseWindowThemePreference,
  readWindowThemePreference,
  resolveWindowBackground,
  writeWindowThemePreference,
} from "../../src/main/window-appearance";

describe("window appearance", () => {
  it("accepts only supported cached theme preferences", () => {
    expect(parseWindowThemePreference({ theme: "light" })).toBe("light");
    expect(parseWindowThemePreference({ theme: "dark" })).toBe("dark");
    expect(parseWindowThemePreference({ theme: "system" })).toBe("system");
    expect(parseWindowThemePreference({ theme: "green" })).toBe("system");
    expect(parseWindowThemePreference(null)).toBe("system");
  });

  it("matches the native first-paint background to the resolved theme", () => {
    expect(resolveWindowBackground("light", true)).toBe("#f1f1f3");
    expect(resolveWindowBackground("dark", false)).toBe("#101013");
    expect(resolveWindowBackground("system", false)).toBe("#f1f1f3");
    expect(resolveWindowBackground("system", true)).toBe("#101013");
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
});

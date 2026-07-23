import { describe, expect, it } from "vitest";

import { nextQuickTheme, resolveThemePreference } from "../../src/renderer/src/utils/theme";

describe("theme preferences", () => {
  it("resolves System from the operating-system preference", () => {
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
  });

  it("makes the quick toggle visibly change even when the saved preference is System", () => {
    expect(nextQuickTheme("system", true)).toBe("light");
    expect(nextQuickTheme("system", false)).toBe("dark");
    expect(nextQuickTheme("light", false)).toBe("dark");
    expect(nextQuickTheme("dark", true)).toBe("light");
  });
});

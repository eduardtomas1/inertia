import { describe, expect, it } from "vitest";

import { clipCodeUnits, clipTrailingCodeUnits } from "../../src/shared/code-units";

describe("clipCodeUnits", () => {
  it("keeps short text and clips long text without splitting a surrogate pair", () => {
    expect(clipCodeUnits("abc", 3)).toBe("abc");
    expect(clipCodeUnits("abcdef", 3)).toBe("abc");
    expect(clipCodeUnits("ab😀cd", 3)).toBe("ab");
    expect(clipCodeUnits("ab😀cd", 4)).toBe("ab😀");
    expect(clipCodeUnits("abc", 0)).toBe("");
    expect(clipCodeUnits("abc", -1)).toBe("");
  });

  it("keeps an astral character whole or drops it whole at the start boundary", () => {
    expect(clipCodeUnits("\u{1D400}\u{1D401}", 1)).toBe("");
    expect(clipCodeUnits("\u{1D400}\u{1D401}", 3)).toBe("\u{1D400}");
    expect(clipCodeUnits("🚀🚀", 2)).toBe("🚀");
  });
});

describe("clipTrailingCodeUnits", () => {
  it("keeps the end of long text without starting on a lone low surrogate", () => {
    expect(clipTrailingCodeUnits("abc", 3)).toBe("abc");
    expect(clipTrailingCodeUnits("abcdef", 3)).toBe("def");
    expect(clipTrailingCodeUnits("ab😀cd", 3)).toBe("cd");
    expect(clipTrailingCodeUnits("ab😀cd", 4)).toBe("😀cd");
    expect(clipTrailingCodeUnits("\u{1D400}\u{1D401}", 1)).toBe("");
    expect(clipTrailingCodeUnits("abc", 0)).toBe("");
    expect(clipTrailingCodeUnits("abc", -1)).toBe("");
  });
});

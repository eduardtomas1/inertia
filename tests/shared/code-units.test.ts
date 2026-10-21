import { describe, expect, it } from "vitest";

import { clipCodeUnits } from "../../src/shared/code-units";

describe("clipCodeUnits", () => {
  it("keeps short text and clips long text without splitting a surrogate pair", () => {
    expect(clipCodeUnits("abc", 3)).toBe("abc");
    expect(clipCodeUnits("abcdef", 3)).toBe("abc");
    expect(clipCodeUnits("ab😀cd", 3)).toBe("ab");
    expect(clipCodeUnits("ab😀cd", 4)).toBe("ab😀");
    expect(clipCodeUnits("abc", 0)).toBe("");
    expect(clipCodeUnits("abc", -1)).toBe("");
  });
});

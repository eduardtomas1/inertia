import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_KEYBINDINGS,
  parseAppKeybindings,
} from "../src/shared/keybindings";

describe("app keybindings", () => {
  it("accepts a complete set of unique supported keys", () => {
    expect(parseAppKeybindings({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "g",
      "toggle-terminal": "h",
    })).toEqual({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "g",
      "toggle-terminal": "h",
    });
  });

  it.each([
    null,
    { ...DEFAULT_APP_KEYBINDINGS, search: "n" },
    { ...DEFAULT_APP_KEYBINDINGS, search: "x" },
    { ...DEFAULT_APP_KEYBINDINGS, extra: "u" },
  ])("fails closed to defaults for malformed bindings", (value) => {
    expect(parseAppKeybindings(value)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });
});

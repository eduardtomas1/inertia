import { describe, expect, it } from "vitest";

import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
  parseAppKeybindings,
} from "../src/shared/keybindings";

describe("app keybindings", () => {
  it("opens the surface chooser with G by default and keeps the defaults unique", () => {
    expect(DEFAULT_APP_KEYBINDINGS["open-surface"]).toBe("g");
    const keys = Object.values(DEFAULT_APP_KEYBINDINGS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => APP_SHORTCUT_KEYS.includes(key))).toBe(true);
  });

  it("accepts a complete set of unique supported keys", () => {
    const bindings = {
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "g",
      "toggle-terminal": "h",
      "open-surface": "b",
    };
    expect(parseAppKeybindings(bindings)).toEqual(bindings);
  });

  it("keeps choices saved before the surface shortcut and adds it on its default key", () => {
    expect(parseAppKeybindings({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
    })).toEqual({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
      "open-surface": "g",
    });
    expect(parseAppKeybindings({
      search: "k",
      "new-chat": "n",
      "toggle-sidebar": "b",
      "toggle-terminal": "j",
    })).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  it("moves the surface shortcut to the first free key when an older choice took G", () => {
    expect(parseAppKeybindings({
      search: "g",
      "new-chat": "n",
      "toggle-sidebar": "b",
      "toggle-terminal": "j",
    })).toEqual({
      search: "g",
      "new-chat": "n",
      "toggle-sidebar": "b",
      "toggle-terminal": "j",
      "open-surface": "h",
    });
    expect(parseAppKeybindings({
      search: "b",
      "new-chat": "g",
      "toggle-sidebar": "h",
      "toggle-terminal": "j",
    })["open-surface"]).toBe("k");
  });

  it.each([
    null,
    [],
    "k",
    {},
    { search: "k" },
    { "new-chat": "n", "toggle-sidebar": "b", "toggle-terminal": "j", "open-surface": "g" },
    { ...DEFAULT_APP_KEYBINDINGS, search: "n" },
    { ...DEFAULT_APP_KEYBINDINGS, "open-surface": "k" },
    { ...DEFAULT_APP_KEYBINDINGS, search: "x" },
    { ...DEFAULT_APP_KEYBINDINGS, "open-surface": "x" },
    { ...DEFAULT_APP_KEYBINDINGS, extra: "u" },
    { search: "g", "new-chat": "n", "toggle-sidebar": "b", "toggle-terminal": "g" },
  ])("fails closed to defaults for malformed bindings", (value) => {
    expect(parseAppKeybindings(value)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });
});

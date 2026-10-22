import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_KEYBINDINGS,
  parseAppKeybindings,
} from "../src/shared/keybindings";
import { appKeybindings } from "../src/shared/contracts/app-keybindings-schema";

describe("app keybindings", () => {
  it("accepts a complete set of unique supported keys", () => {
    const custom = {
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "g",
      "toggle-terminal": "h",
      tasks: "k",
    };
    expect(parseAppKeybindings(custom)).toEqual(custom);
    expect(appKeybindings(custom)).toBe(true);
  });

  it("opens tasks with T by default", () => {
    expect(DEFAULT_APP_KEYBINDINGS.tasks).toBe("t");
    expect(appKeybindings(DEFAULT_APP_KEYBINDINGS)).toBe(true);
  });

  it("keeps a record stored before tasks existed and fills tasks with its default", () => {
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
      tasks: "t",
    });
  });

  it.each([
    null,
    { ...DEFAULT_APP_KEYBINDINGS, search: "n" },
    { ...DEFAULT_APP_KEYBINDINGS, search: "x" },
    { ...DEFAULT_APP_KEYBINDINGS, extra: "u" },
    { ...DEFAULT_APP_KEYBINDINGS, tasks: "k" },
    { search: "t", "new-chat": "n", "toggle-sidebar": "b", "toggle-terminal": "j" },
    { search: "k", "new-chat": "n", "toggle-sidebar": "b" },
  ])("fails closed to defaults for malformed bindings", (value) => {
    expect(parseAppKeybindings(value)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  it("requires every action in runtime settings", () => {
    const { tasks: _tasks, ...legacy } = DEFAULT_APP_KEYBINDINGS;
    expect(appKeybindings(legacy)).toBe(false);
    expect(appKeybindings({ ...DEFAULT_APP_KEYBINDINGS, tasks: "n" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
  parseAppKeybindings,
} from "../src/shared/keybindings";
import { appKeybindings } from "../src/shared/contracts/app-keybindings-schema";

describe("app keybindings", () => {
  it("opens the surface chooser with G by default and keeps the defaults unique", () => {
    expect(DEFAULT_APP_KEYBINDINGS["open-surface"]).toBe("g");
    const keys = Object.values(DEFAULT_APP_KEYBINDINGS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => APP_SHORTCUT_KEYS.includes(key))).toBe(true);
  });

  it("accepts a complete set of unique supported keys", () => {
    const custom = {
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "g",
      "toggle-terminal": "h",
      tasks: "k",
      "open-surface": "b",
    };
    expect(parseAppKeybindings(custom)).toEqual(custom);
    expect(appKeybindings(custom)).toBe(true);
  });

  it("opens tasks with T by default", () => {
    expect(DEFAULT_APP_KEYBINDINGS.tasks).toBe("t");
    expect(appKeybindings(DEFAULT_APP_KEYBINDINGS)).toBe(true);
  });

  it("keeps choices saved before tasks and the surface shortcut and adds both on their default keys", () => {
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
      tasks: "t",
      "open-surface": "g",
    });
    expect(parseAppKeybindings({
      search: "k",
      "new-chat": "n",
      "toggle-sidebar": "b",
      "toggle-terminal": "j",
    })).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  it("keeps a record saved with tasks and adds the surface shortcut", () => {
    expect(parseAppKeybindings({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
      tasks: "k",
    })).toEqual({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
      tasks: "k",
      "open-surface": "g",
    });
  });

  it("keeps a record saved with the surface shortcut and adds tasks", () => {
    expect(parseAppKeybindings({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
      "open-surface": "k",
    })).toEqual({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
      tasks: "t",
      "open-surface": "k",
    });
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
      tasks: "t",
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
    { ...DEFAULT_APP_KEYBINDINGS, tasks: "k" },
    { search: "t", "new-chat": "n", "toggle-sidebar": "b", "toggle-terminal": "j" },
    { search: "k", "new-chat": "n", "toggle-sidebar": "b" },
    { search: "g", "new-chat": "n", "toggle-sidebar": "b", "toggle-terminal": "g" },
  ])("fails closed to defaults for malformed bindings", (value) => {
    expect(parseAppKeybindings(value)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  it("requires every action in runtime settings", () => {
    const { tasks: _tasks, ...withoutTasks } = DEFAULT_APP_KEYBINDINGS;
    expect(appKeybindings(withoutTasks)).toBe(false);
    const { "open-surface": _openSurface, ...withoutSurface } = DEFAULT_APP_KEYBINDINGS;
    expect(appKeybindings(withoutSurface)).toBe(false);
    expect(appKeybindings({ ...DEFAULT_APP_KEYBINDINGS, tasks: "n" })).toBe(false);
  });
});

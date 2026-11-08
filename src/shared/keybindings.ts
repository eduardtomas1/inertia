export const APP_SHORTCUT_KEYS = ["b", "g", "h", "j", "k", "n", "t", "u", "y"] as const;

export type AppShortcutKey = typeof APP_SHORTCUT_KEYS[number];
export type AppShortcutAction =
  | "search"
  | "new-chat"
  | "toggle-sidebar"
  | "toggle-terminal"
  | "tasks"
  | "open-surface";
export type AppKeybindings = Record<AppShortcutAction, AppShortcutKey>;

export const DEFAULT_APP_KEYBINDINGS: AppKeybindings = {
  search: "k",
  "new-chat": "n",
  "toggle-sidebar": "b",
  "toggle-terminal": "j",
  tasks: "t",
  "open-surface": "g",
};

/** Every stored record has carried these actions since app shortcuts shipped. */
const ORIGINAL_APP_SHORTCUT_ACTIONS: readonly AppShortcutAction[] = [
  "search",
  "new-chat",
  "toggle-sidebar",
  "toggle-terminal",
];

/** Keys that became bindable together with a later action. */
const KEYS_ADDED_WITH_ACTION: readonly (readonly [AppShortcutAction, readonly AppShortcutKey[]])[] = [
  ["tasks", ["t"]],
];

function isAppShortcutKey(value: unknown): value is AppShortcutKey {
  return APP_SHORTCUT_KEYS.includes(value as AppShortcutKey);
}

/**
 * Reads a stored binding record. A record saved before a newer action existed
 * keeps the user's choices and gains that action on its default key, or on the
 * first free key when the default is already taken. Anything else that is not
 * a complete set of unique supported keys fails closed to the defaults.
 */
export function parseAppKeybindings(value: unknown): AppKeybindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_APP_KEYBINDINGS };
  }
  const record = value as Record<string, unknown>;
  const actions = Object.keys(DEFAULT_APP_KEYBINDINGS) as AppShortcutAction[];
  const stored = Object.keys(record);
  const storedKeys = stored.map((action) => record[action]);
  if (
    stored.some((action) => !actions.includes(action as AppShortcutAction))
    || ORIGINAL_APP_SHORTCUT_ACTIONS.some((action) => !stored.includes(action))
    || !storedKeys.every(isAppShortcutKey)
    || new Set(storedKeys).size !== storedKeys.length
    || KEYS_ADDED_WITH_ACTION.some(([action, keys]) =>
      !stored.includes(action) && storedKeys.some((key) => keys.includes(key as AppShortcutKey)))
  ) return { ...DEFAULT_APP_KEYBINDINGS };
  const taken = new Set<AppShortcutKey>(storedKeys);
  const bindings = {} as AppKeybindings;
  for (const action of actions) {
    const storedKey = record[action];
    if (stored.includes(action) && isAppShortcutKey(storedKey)) {
      bindings[action] = storedKey;
      continue;
    }
    const fallback = taken.has(DEFAULT_APP_KEYBINDINGS[action])
      ? APP_SHORTCUT_KEYS.find((key) => !taken.has(key))
      : DEFAULT_APP_KEYBINDINGS[action];
    if (!fallback) return { ...DEFAULT_APP_KEYBINDINGS };
    taken.add(fallback);
    bindings[action] = fallback;
  }
  return bindings;
}

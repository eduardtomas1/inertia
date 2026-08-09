export const APP_SHORTCUT_KEYS = ["b", "g", "h", "j", "k", "n", "u", "y"] as const;

export type AppShortcutKey = typeof APP_SHORTCUT_KEYS[number];
export type AppShortcutAction =
  | "search"
  | "new-chat"
  | "toggle-sidebar"
  | "toggle-terminal";
export type AppKeybindings = Record<AppShortcutAction, AppShortcutKey>;

export const DEFAULT_APP_KEYBINDINGS: AppKeybindings = {
  search: "k",
  "new-chat": "n",
  "toggle-sidebar": "b",
  "toggle-terminal": "j",
};

export function parseAppKeybindings(value: unknown): AppKeybindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_APP_KEYBINDINGS };
  }
  const record = value as Record<string, unknown>;
  const actions = Object.keys(DEFAULT_APP_KEYBINDINGS) as AppShortcutAction[];
  const keys = actions.map((action) => record[action]);
  if (
    Object.keys(record).length !== actions.length
    || keys.some((key) => !APP_SHORTCUT_KEYS.includes(key as AppShortcutKey))
    || new Set(keys).size !== actions.length
  ) return { ...DEFAULT_APP_KEYBINDINGS };
  return Object.fromEntries(actions.map((action) => [action, record[action]])) as AppKeybindings;
}

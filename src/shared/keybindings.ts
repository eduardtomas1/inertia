export const APP_SHORTCUT_KEYS = ["b", "g", "h", "j", "k", "n", "t", "u", "y"] as const;

export type AppShortcutKey = typeof APP_SHORTCUT_KEYS[number];
export type AppShortcutAction =
  | "search"
  | "new-chat"
  | "toggle-sidebar"
  | "toggle-terminal"
  | "tasks";
export type AppKeybindings = Record<AppShortcutAction, AppShortcutKey>;

export const DEFAULT_APP_KEYBINDINGS: AppKeybindings = {
  search: "k",
  "new-chat": "n",
  "toggle-sidebar": "b",
  "toggle-terminal": "j",
  tasks: "t",
};

const ADDED_APP_SHORTCUT_ACTIONS: readonly AppShortcutAction[] = ["tasks"];

export function parseAppKeybindings(value: unknown): AppKeybindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_APP_KEYBINDINGS };
  }
  const stored = value as Record<string, unknown>;
  const record: Record<string, unknown> = { ...stored };
  for (const action of ADDED_APP_SHORTCUT_ACTIONS) {
    if (!Object.hasOwn(stored, action)) record[action] = DEFAULT_APP_KEYBINDINGS[action];
  }
  const actions = Object.keys(DEFAULT_APP_KEYBINDINGS) as AppShortcutAction[];
  const keys = actions.map((action) => record[action]);
  if (
    Object.keys(record).length !== actions.length
    || keys.some((key) => !APP_SHORTCUT_KEYS.includes(key as AppShortcutKey))
    || new Set(keys).size !== actions.length
  ) return { ...DEFAULT_APP_KEYBINDINGS };
  return Object.fromEntries(actions.map((action) => [action, record[action]])) as AppKeybindings;
}

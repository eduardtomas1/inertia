import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
} from "../keybindings";

type UnknownRecord = Record<string, unknown>;

export function appKeybindings(value: unknown): boolean {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return false;
  const actions = Object.keys(DEFAULT_APP_KEYBINDINGS);
  if (Object.keys(value).length !== actions.length) return false;
  const record = value as UnknownRecord;
  const bindings = actions.map((action) => record[action]);
  return bindings.every((key) => (
    typeof key === "string"
    && APP_SHORTCUT_KEYS.includes(key as typeof APP_SHORTCUT_KEYS[number])
  )) && new Set(bindings).size === actions.length;
}

import type { Input, KeyboardInputEvent } from "electron";

import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
  type AppShortcutKey,
} from "../shared/keybindings.js";

const CLOSE_PANEL_KEY = "w";

/**
 * The keys a focused page hands back to the app: the keys the app shortcuts
 * are currently bound to, as the renderer last reported them, plus the fixed
 * close-panel key. Every other chord stays with the page.
 */
let boundShortcutKeys: ReadonlySet<string> = new Set(Object.values(DEFAULT_APP_KEYBINDINGS));

/** Validates a renderer's bound-key report: unique bindable keys only. */
export function parsePreviewAppShortcutKeys(value: unknown): readonly AppShortcutKey[] | null {
  if (!Array.isArray(value) || value.length > APP_SHORTCUT_KEYS.length) return null;
  if (!value.every((key) => APP_SHORTCUT_KEYS.includes(key as AppShortcutKey))) return null;
  return new Set(value).size === value.length ? value as AppShortcutKey[] : null;
}

export function setPreviewAppShortcutKeys(keys: readonly AppShortcutKey[]): void {
  boundShortcutKeys = new Set(keys);
}

function primaryModifier(
  input: Pick<Input, "control" | "meta">,
  platform: NodeJS.Platform | string,
): boolean {
  return platform === "darwin"
    ? input.meta && !input.control
    : input.control && !input.meta;
}

export function previewAppShortcutKey(
  input: Pick<Input, "alt" | "control" | "key" | "meta" | "shift" | "type">,
  platform: NodeJS.Platform | string,
  boundKeys: ReadonlySet<string> = boundShortcutKeys,
): string | null {
  const key = input.key.toLowerCase();
  return input.type === "keyDown"
      && primaryModifier(input, platform)
      && !input.alt
      && !input.shift
      && (key === CLOSE_PANEL_KEY || boundKeys.has(key))
    ? key
    : null;
}

export function previewReloadShortcut(
  input: Pick<Input, "alt" | "control" | "key" | "meta" | "shift" | "type">,
  platform: NodeJS.Platform | string,
): boolean {
  return input.type === "keyDown"
    && primaryModifier(input, platform)
    && !input.alt
    && input.key.toLowerCase() === "r";
}

export function forwardedKeyboardInput(input: Input): KeyboardInputEvent {
  const modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = [];
  if (input.control) modifiers.push("control");
  if (input.meta) modifiers.push("meta");
  return {
    type: input.type === "keyUp" ? "keyUp" : "keyDown",
    keyCode: input.key,
    modifiers,
  };
}

export function closesSecondaryWindow(
  input: Pick<Input, "alt" | "control" | "key" | "meta" | "shift" | "type">,
  platform: NodeJS.Platform | string,
): boolean {
  if (input.type !== "keyDown" || input.alt || input.shift) return false;
  if (input.key === "Escape") return !input.meta && !input.control;
  return primaryModifier(input, platform) && input.key.toLowerCase() === CLOSE_PANEL_KEY;
}

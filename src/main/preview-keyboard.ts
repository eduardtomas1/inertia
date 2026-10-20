import type { Input, KeyboardInputEvent } from "electron";

import { APP_SHORTCUT_KEYS } from "../shared/keybindings.js";

/**
 * Every key an app shortcut can be bound to, plus the fixed close-panel key.
 * A focused page forwards the whole pool, so a rebound shortcut keeps working
 * while the Browser has focus.
 */
const FORWARDED_SHORTCUT_KEYS: ReadonlySet<string> = new Set([...APP_SHORTCUT_KEYS, "w"]);

export function previewAppShortcutKey(
  input: Pick<Input, "alt" | "control" | "key" | "meta" | "shift" | "type">,
  platform: NodeJS.Platform | string,
): string | null {
  const key = input.key.toLowerCase();
  const modified = key === "w"
    ? platform === "darwin"
      ? input.meta && !input.control
      : input.control && !input.meta
    : input.meta || input.control;
  return input.type === "keyDown"
      && modified
      && !input.alt
      && !input.shift
      && FORWARDED_SHORTCUT_KEYS.has(key)
    ? key
    : null;
}

export function previewReloadShortcut(
  input: Pick<Input, "alt" | "control" | "key" | "meta" | "shift" | "type">,
  platform: NodeJS.Platform | string,
): boolean {
  const primary = platform === "darwin"
    ? input.meta && !input.control
    : input.control && !input.meta;
  return input.type === "keyDown"
    && primary
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
  const primary = platform === "darwin"
    ? input.meta && !input.control
    : input.control && !input.meta;
  return primary && input.key.toLowerCase() === "w";
}

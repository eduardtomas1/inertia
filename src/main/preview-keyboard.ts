import type { Input, KeyboardInputEvent } from "electron";

const APP_SHORTCUT_KEYS = new Set(["b", "j", "k", "n"]);

export function previewAppShortcutKey(input: Pick<
  Input,
  "alt" | "control" | "key" | "meta" | "shift" | "type"
>): string | null {
  const key = input.key.toLowerCase();
  return input.type === "keyDown"
      && (input.meta || input.control)
      && !input.alt
      && !input.shift
      && APP_SHORTCUT_KEYS.has(key)
    ? key
    : null;
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

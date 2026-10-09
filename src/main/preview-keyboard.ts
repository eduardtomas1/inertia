import type { Input, KeyboardInputEvent } from "electron";

const APP_SHORTCUT_KEYS = new Set(["b", "j", "k", "n", "w"]);

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

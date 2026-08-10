import { MAX_CHAT_MESSAGE_CHARS } from "../../../shared/diff-review";
import type { PromptPreset } from "../../../shared/prompt-presets";

export interface PromptPresetInsertion {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function insertPromptPreset(
  current: string,
  presetBody: string,
  selectionStart: number,
  selectionEnd: number,
): PromptPresetInsertion | null {
  const start = Math.max(0, Math.min(selectionStart, current.length));
  const end = Math.max(start, Math.min(selectionEnd, current.length));
  const before = current.slice(0, start);
  const after = current.slice(end);
  const prefix = before.length > 0 && !before.endsWith("\n") ? "\n\n" : "";
  const suffix = after.length > 0 && !after.startsWith("\n") ? "\n\n" : "";
  const value = `${before}${prefix}${presetBody}${suffix}${after}`;
  if (value.length > MAX_CHAT_MESSAGE_CHARS) return null;
  const caret = before.length + prefix.length + presetBody.length;
  return { value, selectionStart: caret, selectionEnd: caret };
}

export function reorderedPromptPresetIds(
  presets: readonly PromptPreset[],
  presetId: string,
  direction: "up" | "down",
): string[] | null {
  const ids = presets.map(({ id }) => id);
  const current = ids.indexOf(presetId);
  const target = direction === "up" ? current - 1 : current + 1;
  if (current < 0 || target < 0 || target >= ids.length) return null;
  [ids[current], ids[target]] = [ids[target]!, ids[current]!];
  return ids;
}

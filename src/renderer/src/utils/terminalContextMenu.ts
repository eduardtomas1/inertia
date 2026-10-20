import type { MouseEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import { contextMenuHandlers, copyFromMenu } from "./contextMenu";

const V_KEY_CODE = 86;

function isPasteLetter(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  if (key === "v") return true;
  return !/^[a-z]$/u.test(key) && event.keyCode === V_KEY_CODE;
}

export function terminalPasteKeyHandler(
  pastesWithControl: boolean,
): (event: KeyboardEvent) => boolean {
  return (event) => !(pastesWithControl
    && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    && isPasteLetter(event));
}

const F_KEY_CODE = 70;

/** ⌘F on macOS and Ctrl+F elsewhere, only while the terminal has focus. */
export function isTerminalFindShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (event.type !== "keydown" || event.altKey || event.shiftKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  const key = event.key.toLowerCase();
  return key === "f" || (!/^[a-z]$/u.test(key) && event.keyCode === F_KEY_CODE);
}

/**
 * `addSelectionToPrompt` is offered only for chat terminals; the menu reports
 * whether a selection exists, never the selected text itself.
 */
export function terminalContextMenu(
  terminal: () => Terminal | null,
  clearable: boolean,
  addSelectionToPrompt?: (selection: string) => void,
): (event: MouseEvent<HTMLElement>) => void {
  const handlers = contextMenuHandlers<HTMLElement>(
    () => {
      const current = terminal();
      if (!current) return null;
      return {
        kind: "terminal",
        hasSelection: current.hasSelection(),
        clearable,
        ...(addSelectionToPrompt ? { promptable: true } : {}),
      };
    },
    (action) => {
      const current = terminal();
      if (!current) return;
      if (action === "terminal-copy") void copyFromMenu(current.getSelection());
      else if (action === "terminal-select-all") current.selectAll();
      else if (action === "terminal-clear" && clearable) current.clear();
      else if (action === "terminal-add-to-prompt" && addSelectionToPrompt && current.hasSelection()) {
        addSelectionToPrompt(current.getSelection());
      }
    },
  );
  return (event) => {
    terminal()?.focus();
    handlers.onContextMenu(event);
  };
}

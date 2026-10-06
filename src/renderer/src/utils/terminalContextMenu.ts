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

export function terminalContextMenu(
  terminal: () => Terminal | null,
  clearable: boolean,
): (event: MouseEvent<HTMLElement>) => void {
  const handlers = contextMenuHandlers<HTMLElement>(
    () => {
      const current = terminal();
      return current ? { kind: "terminal", hasSelection: current.hasSelection(), clearable } : null;
    },
    (action) => {
      const current = terminal();
      if (!current) return;
      if (action === "terminal-copy") void copyFromMenu(current.getSelection());
      else if (action === "terminal-select-all") current.selectAll();
      else if (action === "terminal-clear" && clearable) current.clear();
    },
  );
  return (event) => {
    terminal()?.focus();
    handlers.onContextMenu(event);
  };
}

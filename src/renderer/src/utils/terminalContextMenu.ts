import type { MouseEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import { writeClipboardText } from "./clipboard";
import { contextMenuHandlers } from "./contextMenu";

export function terminalPasteKeyHandler(
  platform: string | undefined,
): (event: KeyboardEvent) => boolean {
  const pastesWithControl = platform !== "darwin";
  return (event) => !(pastesWithControl
    && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    && event.code === "KeyV");
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
      if (action === "terminal-copy") void writeClipboardText(current.getSelection());
      else if (action === "terminal-select-all") current.selectAll();
      else if (action === "terminal-clear" && clearable) current.clear();
    },
  );
  return (event) => {
    terminal()?.focus();
    handlers.onContextMenu(event);
  };
}

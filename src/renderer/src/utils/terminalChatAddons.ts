import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPathResolution } from "@shared/contracts/terminal-links";
import { isTerminalFindShortcut, terminalPasteKeyHandler } from "./terminalContextMenu";
import {
  createTerminalPathLinkProvider,
  createTerminalPathResolver,
  openTerminalWebLink,
} from "./terminalLinks";
import type { WorkspaceFileLocation } from "./workspaceFileReference";

export type TerminalFileOpener = (
  path: string,
  location?: WorkspaceFileLocation,
  literalPath?: boolean,
) => void;

export interface TerminalChatAddonOptions {
  platform: string | undefined;
  onFind: () => void;
  onSelectionChange: (hasSelection: boolean) => void;
  /** Asks the local runtime to resolve a path token inside the chat's workspace. */
  resolvePath: (text: string) => Promise<TerminalPathResolution | null>;
  /** The current Files opener, read at click time; file links are off without one. */
  fileOpener: () => TerminalFileOpener | undefined;
}

export interface TerminalChatAddons {
  search: SearchAddon;
  dispose(): void;
}

export function openTerminalPathResolution(
  open: TerminalFileOpener,
  resolution: TerminalPathResolution,
): void {
  if (resolution.line === null) {
    open(resolution.projectPath, undefined, true);
    return;
  }
  open(resolution.projectPath, {
    startLine: resolution.line,
    ...(resolution.column === null ? {} : { startColumn: resolution.column }),
    endLine: resolution.line,
  }, true);
}

/**
 * Connects a workspace terminal to its chat: paste and find keys, web links
 * through the main-process URL policy (never window.open), runtime-resolved
 * file links, search, and selection tracking. Load before `terminal.open`.
 */
export function attachTerminalChatAddons(
  terminal: Terminal,
  options: TerminalChatAddonOptions,
): TerminalChatAddons {
  const pasteKeys = terminalPasteKeyHandler(options.platform === "win32");
  terminal.attachCustomKeyEventHandler((event) => {
    if (isTerminalFindShortcut(event, options.platform === "darwin")) {
      event.preventDefault();
      event.stopPropagation();
      options.onFind();
      return false;
    }
    return pasteKeys(event);
  });
  terminal.loadAddon(new WebLinksAddon(openTerminalWebLink));
  const search = new SearchAddon();
  terminal.loadAddon(search);
  const resolver = createTerminalPathResolver(options.resolvePath);
  const pathLinks = terminal.registerLinkProvider(createTerminalPathLinkProvider(
    terminal,
    resolver,
    (resolution) => {
      const open = options.fileOpener();
      if (open) openTerminalPathResolution(open, resolution);
    },
    () => options.fileOpener() !== undefined,
  ));
  const selection = terminal.onSelectionChange(() => {
    options.onSelectionChange(terminal.hasSelection());
  });
  return {
    search,
    dispose() {
      selection.dispose();
      pathLinks.dispose();
      resolver.dispose();
    },
  };
}

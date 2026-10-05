import {
  clipboard,
  Menu,
  shell,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron";

import { safeHttpUrl } from "../shared/preview-url.js";
import { openDesktopLink } from "./external-link-open.js";

const MAX_SPELLING_SUGGESTIONS = 5;

function safeLink(value: string): string | null {
  if (!value) return null;
  try {
    safeHttpUrl(value);
    return value;
  } catch {
    return null;
  }
}

function spellingItems(
  window: BrowserWindow,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  if (!params.isEditable || !params.misspelledWord) return [];
  const suggestions = params.dictionarySuggestions.slice(0, MAX_SPELLING_SUGGESTIONS);
  return suggestions.length === 0
    ? [{ label: "No suggestions", enabled: false }]
    : suggestions.map((suggestion) => ({
        label: suggestion,
        click: () => {
          if (!window.webContents.isDestroyed()) window.webContents.replaceMisspelling(suggestion);
        },
      }));
}

function linkItems(link: string | null): MenuItemConstructorOptions[] {
  if (!link) return [];
  return [
    {
      label: "Copy Link Address",
      click: () => {
        void clipboard.writeText(link).catch((error: unknown) => {
          console.error("Failed to copy a link from the context menu", error);
        });
      },
    },
    {
      label: "Open Link",
      click: () => {
        void openDesktopLink(link, shell).catch((error: unknown) => {
          console.error("Failed to open a link from the context menu", error);
        });
      },
    },
  ];
}

function imageItems(
  window: BrowserWindow,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  if (params.mediaType !== "image" || !params.hasImageContents) return [];
  const { x, y } = params;
  return [{
    label: "Copy Image",
    click: () => {
      if (!window.webContents.isDestroyed()) window.webContents.copyImageAt(x, y);
    },
  }];
}

function editItems(params: ContextMenuParams): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  if (params.isEditable) {
    return [
      { role: "undo", enabled: flags.canUndo },
      { role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { role: "pasteAndMatchStyle", enabled: flags.canPaste },
      { role: "delete", enabled: flags.canDelete },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    ];
  }
  return params.selectionText ? [{ role: "copy", enabled: flags.canCopy }] : [];
}

export function registerEditContextMenu(
  window: BrowserWindow,
  isTrustedRenderer: (url: string) => boolean,
): void {
  window.webContents.on("context-menu", (_event, params) => {
    if (
      window.isDestroyed()
      || params.frame !== window.webContents.mainFrame
      || !isTrustedRenderer(params.pageURL)
    ) return;
    const groups = [
      spellingItems(window, params),
      linkItems(safeLink(params.linkURL)),
      imageItems(window, params),
      editItems(params),
    ].filter((group) => group.length > 0);
    if (groups.length === 0) return;
    const items = groups.flatMap((group, index): MenuItemConstructorOptions[] => (
      index === 0 ? group : [{ type: "separator" }, ...group]
    ));
    Menu.buildFromTemplate(items).popup({ window, x: params.x, y: params.y });
  });
}

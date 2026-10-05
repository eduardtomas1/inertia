import {
  clipboard,
  Menu,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebContentsView,
} from "electron";

import { safeHttpUrl } from "../shared/preview-url.js";

export type PreviewNavigationAction = "back" | "forward" | "reload";

export interface PreviewNavigation {
  navigate(action: PreviewNavigationAction): void;
  agentBusy(): boolean;
}

export interface PreviewContextMenuOptions extends PreviewNavigation {
  captureLocked: WeakSet<WebContents>;
  ownerWindow(): BaseWindow | null | undefined;
  lastInputFromUser(): boolean;
}

function copyableLink(value: string): string | null {
  if (!value) return null;
  try {
    safeHttpUrl(value);
    return value;
  } catch {
    return null;
  }
}

function run(contents: WebContents, action: (contents: WebContents) => void): () => void {
  return () => {
    if (!contents.isDestroyed()) action(contents);
  };
}

export function previewContextMenuTemplate(
  contents: WebContents,
  params: ContextMenuParams,
  navigation: PreviewNavigation,
): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  const link = copyableLink(params.linkURL);
  const edit: MenuItemConstructorOptions[] = params.isEditable
    ? [
        { label: "Undo", enabled: flags.canUndo, click: run(contents, (target) => target.undo()) },
        { label: "Redo", enabled: flags.canRedo, click: run(contents, (target) => target.redo()) },
        { type: "separator" },
        { label: "Cut", enabled: flags.canCut, click: run(contents, (target) => target.cut()) },
        { label: "Copy", enabled: flags.canCopy, click: run(contents, (target) => target.copy()) },
        { label: "Paste", enabled: flags.canPaste, click: run(contents, (target) => target.paste()) },
        { label: "Select all", enabled: flags.canSelectAll, click: run(contents, (target) => target.selectAll()) },
      ]
    : params.selectionText
      ? [{ label: "Copy", enabled: flags.canCopy, click: run(contents, (target) => target.copy()) }]
      : [];
  const linkItems: MenuItemConstructorOptions[] = link
    ? [{
        label: "Copy link address",
        click: () => {
          void clipboard.writeText(link).catch(() => undefined);
        },
      }]
    : [];
  const history = contents.navigationHistory;
  const idle = !navigation.agentBusy();
  const navigate = (action: PreviewNavigationAction) => () => navigation.navigate(action);
  const navigationItems: MenuItemConstructorOptions[] = [
    { label: "Back", enabled: idle && history.canGoBack(), click: navigate("back") },
    { label: "Forward", enabled: idle && history.canGoForward(), click: navigate("forward") },
    { label: "Reload", enabled: idle, click: navigate("reload") },
  ];
  return [edit, linkItems, navigationItems]
    .filter((group) => group.length > 0)
    .flatMap((group, index): MenuItemConstructorOptions[] => (
      index === 0 ? group : [{ type: "separator" }, ...group]
    ));
}

export function registerPreviewContextMenu(
  view: WebContentsView,
  options: PreviewContextMenuOptions,
): void {
  const contents = view.webContents;
  contents.on("context-menu", (_event, params) => {
    if (contents.isDestroyed() || options.captureLocked.has(contents) || !options.lastInputFromUser()) return;
    const window = options.ownerWindow();
    if (!window || window.isDestroyed()) return;
    const bounds = view.getBounds();
    Menu.buildFromTemplate(previewContextMenuTemplate(contents, params, options)).popup({
      window,
      x: Math.round(bounds.x + params.x),
      y: Math.round(bounds.y + params.y),
      frame: params.frame ?? undefined,
    });
  });
}

import {
  clipboard,
  Menu,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebContentsView,
} from "electron";

export interface PreviewContextMenuOptions {
  captureLocked: WeakSet<WebContents>;
  ownerWindow(): BaseWindow | null | undefined;
  lastInputFromUser(): boolean;
}

const MAX_LINK_LENGTH = 4_096;

function copyableLink(value: string): string | null {
  if (!value || value.length > MAX_LINK_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
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
        { label: "Select All", enabled: flags.canSelectAll, click: run(contents, (target) => target.selectAll()) },
      ]
    : params.selectionText
      ? [{ label: "Copy", enabled: flags.canCopy, click: run(contents, (target) => target.copy()) }]
      : [];
  const linkItems: MenuItemConstructorOptions[] = link
    ? [{
        label: "Copy Link Address",
        click: () => {
          void clipboard.writeText(link).catch(() => undefined);
        },
      }]
    : [];
  const history = contents.navigationHistory;
  const navigation: MenuItemConstructorOptions[] = [
    { label: "Back", enabled: history.canGoBack(), click: run(contents, (target) => target.navigationHistory.goBack()) },
    { label: "Forward", enabled: history.canGoForward(), click: run(contents, (target) => target.navigationHistory.goForward()) },
    { label: "Reload", click: run(contents, (target) => target.reload()) },
  ];
  return [edit, linkItems, navigation]
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
    Menu.buildFromTemplate(previewContextMenuTemplate(contents, params)).popup({
      window,
      x: Math.round(bounds.x + params.x),
      y: Math.round(bounds.y + params.y),
      frame: params.frame ?? undefined,
    });
  });
}

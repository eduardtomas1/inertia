import {
  ipcMain,
  Menu,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";

import {
  parseContextMenuRequest,
  type ContextMenuAction,
  type ContextMenuRequest,
} from "../shared/context-menu.js";
import type { DesktopWindowContext } from "../shared/desktop.js";
import {
  editorLabel,
  isEditorId,
  type DetectedEditor,
  type PreferredEditor,
} from "../shared/editors.js";

export interface ContextMenuEditorState {
  preferredEditor: PreferredEditor;
  detectedEditors: readonly DetectedEditor[];
}

type ContextMenuEntry =
  | { label: string; action: ContextMenuAction; enabled?: boolean; accelerator?: string }
  | { label: string; submenu: readonly { label: string; action: ContextMenuAction }[] }
  | { role: "copy" | "paste"; label: string; accelerator?: string }
  | { separator: true };

export interface ContextMenuIpcOptions {
  channel: string;
  assertTrusted: (
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments: number,
  ) => DesktopWindowContext;
  windowFor: (
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments: number,
  ) => BrowserWindow;
  isPackaged: () => boolean;
  platform?: NodeJS.Platform;
  editorMenu?: () => Promise<ContextMenuEditorState> | ContextMenuEditorState;
}

const SEPARATOR = { separator: true } as const;
const SELECTION_COPY = { role: "copy", label: "Copy", accelerator: "CmdOrCtrl+C" } as const;

function terminalShortcut(platform: NodeJS.Platform, key: "C" | "V"): { accelerator?: string } {
  if (platform === "darwin") return { accelerator: `Cmd+${key}` };
  return platform === "win32" && key === "V" ? { accelerator: "Ctrl+V" } : {};
}

function revealLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Reveal in File Explorer";
  return "Reveal in file manager";
}

function editorEntries(editors?: ContextMenuEditorState): ContextMenuEntry[] {
  if (!editors) return [];
  if (isEditorId(editors.preferredEditor)) {
    return [{
      label: `Open in ${editorLabel(editors.preferredEditor)}`,
      action: `open-in-editor:${editors.preferredEditor}`,
    }];
  }
  if (editors.detectedEditors.length === 1) {
    const only = editors.detectedEditors[0]!;
    return [{ label: `Open in ${only.label}`, action: `open-in-editor:${only.id}` }];
  }
  if (editors.detectedEditors.length > 1) {
    return [{
      label: "Open in editor",
      submenu: editors.detectedEditors.map((editor) => ({
        label: editor.label,
        action: `open-in-editor:${editor.id}` as const,
      })),
    }];
  }
  return [];
}

function pathEntries(
  platform: NodeJS.Platform,
  openable: boolean,
  editors?: ContextMenuEditorState,
): ContextMenuEntry[] {
  return [
    ...(openable ? [{ label: "Open", action: "open" } as const] : []),
    ...editorEntries(editors),
    { label: revealLabel(platform), action: "reveal" },
    SEPARATOR,
    { label: "Copy path", action: "copy-path" },
    { label: "Copy relative path", action: "copy-relative-path" },
  ];
}

export function contextMenuEntries(
  request: ContextMenuRequest,
  platform: NodeJS.Platform,
  context: Pick<DesktopWindowContext, "role">,
  editors?: ContextMenuEditorState,
): ContextMenuEntry[] {
  switch (request.kind) {
    case "message":
      return [
        ...(request.hasSelection ? [SELECTION_COPY, SEPARATOR] : []),
        { label: "Copy message", action: "copy-message" },
        ...(request.role === "assistant"
          ? [{ label: "Copy as Markdown", action: "copy-markdown" } as const]
          : []),
        ...(context.role === "main"
          ? [SEPARATOR, { label: "Create task from message", action: "create-task" } as const]
          : []),
      ];
    case "code":
      return [
        ...(request.hasSelection ? [SELECTION_COPY, SEPARATOR] : []),
        { label: "Copy code", action: "copy-code" },
      ];
    case "project-link":
      return pathEntries(platform, true, editors);
    case "diff-file":
      return [
        ...pathEntries(platform, true, editors),
        ...(request.stageable || request.unstageable
          ? [
              SEPARATOR,
              ...(request.stageable ? [{ label: "Stage", action: "git-stage" } as const] : []),
              ...(request.unstageable ? [{ label: "Unstage", action: "git-unstage" } as const] : []),
            ]
          : []),
      ];
    case "file":
      return pathEntries(platform, !request.directory, editors);
    case "editor-pick":
      return [
        ...(editors?.detectedEditors ?? []).map((editor) => ({
          label: `Open in ${editor.label}`,
          action: `open-in-editor:${editor.id}` as const,
        })),
        ...(editors && editors.detectedEditors.length > 0 ? [SEPARATOR] : []),
        { label: "Open", action: "open" },
      ];
    case "terminal":
      return [
        { label: "Copy", action: "terminal-copy", enabled: request.hasSelection, ...terminalShortcut(platform, "C") },
        { role: "paste", label: "Paste", ...terminalShortcut(platform, "V") },
        { label: "Select all", action: "terminal-select-all" },
        ...(request.promptable
          ? [SEPARATOR, { label: "Add selection to prompt", action: "terminal-add-to-prompt", enabled: request.hasSelection } as const]
          : []),
        ...(request.clearable
          ? [SEPARATOR, { label: "Clear", action: "terminal-clear" } as const]
          : []),
      ];
  }
}

function ownedByDetachedChat(
  context: DesktopWindowContext,
  request: ContextMenuRequest,
): boolean {
  if (context.role === "main") return true;
  return "conversationId" in request && request.conversationId === context.conversationId;
}

function showMenu(
  window: BrowserWindow,
  request: ContextMenuRequest,
  context: DesktopWindowContext,
  options: ContextMenuIpcOptions,
  editors?: ContextMenuEditorState,
): Promise<ContextMenuAction | null> {
  return new Promise((resolve) => {
    let settled = false;
    const complete = (action: ContextMenuAction | null): void => {
      if (settled) return;
      settled = true;
      resolve(action);
    };
    const zoom = window.webContents.getZoomFactor();
    const x = Math.round(request.anchor.x * zoom);
    const y = Math.round(request.anchor.y * zoom);
    const template: MenuItemConstructorOptions[] = contextMenuEntries(
      request,
      options.platform ?? process.platform,
      context,
      editors,
    ).map((entry) => {
      if ("separator" in entry) return { type: "separator" };
      if ("submenu" in entry) {
        return {
          label: entry.label,
          submenu: entry.submenu.map((child) => ({
            label: child.label,
            click: () => complete(child.action),
          })),
        };
      }
      const shortcut = entry.accelerator
        ? { accelerator: entry.accelerator, registerAccelerator: false }
        : {};
      if ("role" in entry) return { role: entry.role, label: entry.label, ...shortcut };
      return {
        label: entry.label,
        enabled: entry.enabled ?? true,
        ...shortcut,
        click: () => complete(entry.action),
      };
    });
    if (!options.isPackaged()) {
      template.push({ type: "separator" }, {
        label: "Inspect element",
        click: () => {
          if (!window.isDestroyed()) window.webContents.inspectElement(x, y);
        },
      });
    }
    Menu.buildFromTemplate(template).popup({
      window,
      x,
      y,
      callback: () => setImmediate(() => complete(null)),
    });
  });
}

function needsEditorMenu(request: ContextMenuRequest): boolean {
  return request.kind === "file"
    || request.kind === "diff-file"
    || request.kind === "project-link"
    || request.kind === "editor-pick";
}

export function registerContextMenuIpc(options: ContextMenuIpcOptions): void {
  ipcMain.handle(options.channel, async (event, ...args) => {
    const context = options.assertTrusted(event, args.length, 1);
    const request = parseContextMenuRequest(args[0]);
    if (!request) throw new Error("Invalid context menu request");
    if (!ownedByDetachedChat(context, request)) {
      throw new Error("Detached chats can show menus only for their owned conversation");
    }
    const window = options.windowFor(event, args.length, 1);
    const editors = needsEditorMenu(request) && options.editorMenu
      ? await options.editorMenu()
      : undefined;
    return await showMenu(window, request, context, options, editors);
  });
}

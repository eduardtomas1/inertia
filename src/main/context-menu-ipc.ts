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

type ContextMenuEntry =
  | { label: string; action: ContextMenuAction; enabled?: boolean }
  | { role: "copy" | "paste"; label: string }
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
}

const SEPARATOR = { separator: true } as const;

function revealLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Reveal in File Explorer";
  return "Reveal in file manager";
}

function pathEntries(platform: NodeJS.Platform, openable: boolean): ContextMenuEntry[] {
  return [
    ...(openable ? [{ label: "Open", action: "open" } as const] : []),
    { label: revealLabel(platform), action: "reveal" },
    SEPARATOR,
    { label: "Copy path", action: "copy-path" },
    { label: "Copy relative path", action: "copy-relative-path" },
  ];
}

export function contextMenuEntries(
  request: ContextMenuRequest,
  platform: NodeJS.Platform,
): ContextMenuEntry[] {
  switch (request.kind) {
    case "message":
      return [
        ...(request.hasSelection ? [{ role: "copy", label: "Copy" } as const, SEPARATOR] : []),
        { label: "Copy message", action: "copy-message" },
        ...(request.role === "assistant"
          ? [{ label: "Copy as Markdown", action: "copy-markdown" } as const]
          : []),
      ];
    case "code":
      return [
        ...(request.hasSelection ? [{ role: "copy", label: "Copy" } as const, SEPARATOR] : []),
        { label: "Copy code", action: "copy-code" },
      ];
    case "project-link":
    case "diff-file":
      return pathEntries(platform, true);
    case "file":
      return pathEntries(platform, !request.directory);
    case "terminal":
      return [
        { label: "Copy", action: "terminal-copy", enabled: request.hasSelection },
        { role: "paste", label: "Paste" },
        { label: "Select all", action: "terminal-select-all" },
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
  options: ContextMenuIpcOptions,
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
    ).map((entry) => {
      if ("separator" in entry) return { type: "separator" };
      if ("role" in entry) return { role: entry.role, label: entry.label };
      return {
        label: entry.label,
        enabled: entry.enabled ?? true,
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

export function registerContextMenuIpc(options: ContextMenuIpcOptions): void {
  ipcMain.handle(options.channel, async (event, ...args) => {
    const context = options.assertTrusted(event, args.length, 1);
    const request = parseContextMenuRequest(args[0]);
    if (!request) throw new Error("Invalid context menu request");
    if (!ownedByDetachedChat(context, request)) {
      throw new Error("Detached chats can show menus only for their owned conversation");
    }
    const window = options.windowFor(event, args.length, 1);
    return await showMenu(window, request, options);
  });
}

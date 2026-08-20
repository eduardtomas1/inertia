import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BrowserWindow,
  ipcMain,
  screen,
} from "electron";

import { DetachedChatMain } from "./detached-chat-main.js";
import { hardenDesktopSession } from "./preview-broker.js";

export interface DetachedChatBootstrapOptions {
  mainWindow(): BrowserWindow | null;
  rendererUrl: string;
  userDataDirectory: string;
  iconPath: string;
  backgroundColor: string;
  onDock(conversationId: string): void | Promise<void>;
}

export function createDetachedChatMain(
  options: DetachedChatBootstrapOptions,
): DetachedChatMain {
  return new DetachedChatMain({
    ipcMain,
    mainWindow: options.mainWindow,
    createBrowserWindow: (windowOptions) => new BrowserWindow(windowOptions),
    getDisplays: () => screen.getAllDisplays(),
    hardenSession: hardenDesktopSession,
    rendererUrl: options.rendererUrl,
    preloadPath: fileURLToPath(
      new URL("../preload/detached-chat.cjs", import.meta.url),
    ),
    statePath: join(
      options.userDataDirectory,
      "detached-chat-window-state.json",
    ),
    iconPath: options.iconPath,
    backgroundColor: options.backgroundColor,
    onDock: options.onDock,
  });
}

export type { DetachedChatMain };

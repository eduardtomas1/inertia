import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BrowserWindow,
  ipcMain,
  screen,
} from "electron";

import { DetachedChatMain } from "./detached-chat-main.js";
import type { DetachedChatDraftStoreDiagnostic } from "./detached-chat-draft-store.js";
import { hardenDesktopSession } from "./preview-broker.js";
import { registerEditContextMenu } from "./edit-context-menu.js";
import type { ResolvedWindowTheme } from "./window-appearance.js";

export interface DetachedChatBootstrapOptions {
  mainWindow(): BrowserWindow | null;
  rendererUrl: string;
  userDataDirectory: string;
  iconPath: string;
  theme: ResolvedWindowTheme;
  onDraftStoreDiagnostic?: (
    diagnostic: DetachedChatDraftStoreDiagnostic,
  ) => void;
  productName?: string;
  applicationScheme?: string;
  sessionPartitionPrefix?: string;
  registerRendererProtocol(
    session: Electron.Session,
    conversationId: string,
  ): void;
  registerHealthRenderer(contents: Electron.WebContents): () => void;
  onDock(conversationId: string): void | Promise<void>;
}

export function createDetachedChatMain(
  options: DetachedChatBootstrapOptions,
): DetachedChatMain {
  return new DetachedChatMain({
    ipcMain,
    mainWindow: options.mainWindow,
    createBrowserWindow: (windowOptions) => {
      const window = new BrowserWindow(windowOptions);
      registerEditContextMenu(window, (url) => url === options.rendererUrl);
      return window;
    },
    getDisplays: () => screen.getAllDisplays(),
    hardenSession: hardenDesktopSession,
    registerRendererProtocol: options.registerRendererProtocol,
    registerHealthRenderer: options.registerHealthRenderer,
    rendererUrl: options.rendererUrl,
    productName: options.productName ?? "Inertia",
    applicationScheme: options.applicationScheme ?? "inertia",
    sessionPartitionPrefix: options.sessionPartitionPrefix ?? "inertia",
    preloadPath: fileURLToPath(
      new URL("../preload/detached-chat.cjs", import.meta.url),
    ),
    statePath: join(
      options.userDataDirectory,
      "detached-chat-window-state.json",
    ),
    draftStatePath: join(
      options.userDataDirectory,
      "detached-chat-pending-drafts.json",
    ),
    iconPath: options.iconPath,
    theme: options.theme,
    onDraftStoreDiagnostic: options.onDraftStoreDiagnostic,
    onDock: options.onDock,
  });
}

export type { DetachedChatMain };

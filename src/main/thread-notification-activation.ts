import type { BrowserWindow } from "electron";

export interface ThreadNotificationWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: {
    send(channel: string, conversationId: string): void;
  };
}

export interface ThreadNotificationActivationDependencies {
  channel: string;
  currentWindow: () => ThreadNotificationWindow | null;
  createWindow: () => Promise<void>;
}

export function waitForThreadNotificationWindowLoad(
  window: BrowserWindow,
): Promise<void> {
  if (!window.webContents.isLoadingMainFrame()) return Promise.resolve();
  return new Promise<void>((resolveLoad, rejectLoad) => {
    const loaded = (): void => {
      cleanup();
      resolveLoad();
    };
    const failed = (): void => {
      cleanup();
      rejectLoad(new Error("The Inertia window could not finish loading."));
    };
    const cleanup = (): void => {
      window.webContents.removeListener("did-finish-load", loaded);
      window.webContents.removeListener("did-fail-load", failed);
      window.removeListener("closed", failed);
    };
    window.webContents.once("did-finish-load", loaded);
    window.webContents.once("did-fail-load", failed);
    window.once("closed", failed);
  });
}

export async function activateThreadNotification(
  conversationId: string,
  dependencies: ThreadNotificationActivationDependencies,
): Promise<void> {
  await dependencies.createWindow();
  const window = dependencies.currentWindow();
  if (!window || window.isDestroyed()) {
    throw new Error("The Inertia window could not be opened.");
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send(dependencies.channel, conversationId);
}

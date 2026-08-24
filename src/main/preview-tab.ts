import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { WebContentsView, type WebContents } from "electron";

import {
  forwardedKeyboardInput,
  previewAppShortcutKey,
} from "./preview-keyboard.js";
import { hardenDesktopSession } from "./preview-session.js";

export interface PreviewTab {
  id: string;
  view: WebContentsView;
  pageNumber: number;
  documentSequence: number;
  unregisterHealth(): void;
}

interface PreviewTabOptions {
  partition: string;
  pageNumber: number;
  captureLocked: WeakSet<WebContents>;
  registerHealthRenderer?(contents: WebContents): () => void;
  targetContents(): WebContents | null | undefined;
  guardNavigation(event: { preventDefault(): void }, url: string): void;
  publish(): void;
  navigated(tab: PreviewTab, url: string, sameDocument: boolean): void;
  consoleError(tab: PreviewTab, message: unknown): void;
}

export function createPreviewTab(options: PreviewTabOptions): PreviewTab {
  const view = new WebContentsView({
    webPreferences: {
      partition: options.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      disableDialogs: true,
      navigateOnDragDrop: false,
      preload: fileURLToPath(new URL(
        "../preload/preview-agent-privacy.cjs",
        import.meta.url,
      )),
    },
  });
  const tab: PreviewTab = {
    id: randomUUID(),
    pageNumber: options.pageNumber,
    documentSequence: 0,
    view,
    unregisterHealth: options.registerHealthRenderer?.(view.webContents)
      ?? (() => undefined),
  };
  const contents = tab.view.webContents;
  tab.view.setBackgroundColor("#17171b");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => options.guardNavigation(event, url));
  contents.on("will-redirect", (event, url) => options.guardNavigation(event, url));
  const ownedKeyUps = new Set<string>();
  contents.on("before-input-event", (event, input) => {
    if (options.captureLocked.has(contents)) {
      event.preventDefault();
      return;
    }
    const shortcutKey = previewAppShortcutKey(input);
    const key = input.key.toLowerCase();
    const ownsKeyUp = input.type === "keyUp" && ownedKeyUps.delete(key);
    if (!shortcutKey && !ownsKeyUp) {
      if (input.type === "keyDown") ownedKeyUps.delete(key);
      return;
    }
    event.preventDefault();
    if (shortcutKey) ownedKeyUps.add(shortcutKey);
    const target = options.targetContents();
    if (!target || target.isDestroyed()) return;
    target.sendInputEvent(forwardedKeyboardInput(input));
  });
  contents.on("before-mouse-event", (event) => {
    if (options.captureLocked.has(contents)) event.preventDefault();
  });
  hardenDesktopSession(contents.session);
  contents.on("did-start-loading", options.publish);
  contents.on("did-stop-loading", options.publish);
  contents.on("did-navigate", (_event, url) => {
    tab.documentSequence += 1;
    options.navigated(tab, url, false);
    options.publish();
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) options.navigated(tab, url, true);
    options.publish();
  });
  contents.on("console-message", (details, level, message) => {
    const currentLevel = details.level
      ?? (["debug", "info", "warning", "error"] as const)[level];
    if (currentLevel !== "error") return;
    details.preventDefault();
    options.consoleError(tab, details.message ?? message);
  });
  contents.on("page-title-updated", options.publish);
  return tab;
}

import type { MainWindowTarget } from "@shared/desktop";

export type { MainWindowNewChatCheckout, MainWindowTarget } from "@shared/desktop";

interface DetachedHandoffBridge {
  openInMainWindow?: (target: MainWindowTarget) => Promise<void>;
  dockDetachedChat?: (draft: string, target?: MainWindowTarget) => Promise<void>;
}

function handoffBridge(): DetachedHandoffBridge {
  return window.inertia as unknown as DetachedHandoffBridge;
}

export async function openInMain(target: MainWindowTarget): Promise<void> {
  const bridge = handoffBridge();
  if (typeof bridge.openInMainWindow !== "function") {
    throw new Error("The main window is unavailable.");
  }
  await bridge.openInMainWindow(target);
}

export async function dockInMainWith(
  draft: string,
  target?: MainWindowTarget,
): Promise<void> {
  const bridge = handoffBridge();
  if (typeof bridge.dockDetachedChat !== "function") {
    throw new Error("The main window is unavailable.");
  }
  await (target === undefined
    ? bridge.dockDetachedChat(draft)
    : bridge.dockDetachedChat(draft, target));
}

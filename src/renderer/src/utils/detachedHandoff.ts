import type { DetachedChatMainTarget } from "@shared/desktop";

interface DetachedHandoffBridge {
  openInMainWindow?: (target: DetachedChatMainTarget) => Promise<void>;
  dockDetachedChat?: (
    draft: string,
    target?: DetachedChatMainTarget,
  ) => Promise<void>;
}

function handoffBridge(): DetachedHandoffBridge {
  return window.inertia as unknown as DetachedHandoffBridge;
}

export async function openInMain(target: DetachedChatMainTarget): Promise<void> {
  const bridge = handoffBridge();
  if (typeof bridge.openInMainWindow !== "function") {
    throw new Error("The main window is unavailable.");
  }
  await bridge.openInMainWindow(target);
}

export async function dockInMainWith(
  draft: string,
  target?: DetachedChatMainTarget,
): Promise<void> {
  const bridge = handoffBridge();
  if (typeof bridge.dockDetachedChat !== "function") {
    throw new Error("The main window is unavailable.");
  }
  await (target === undefined
    ? bridge.dockDetachedChat(draft)
    : bridge.dockDetachedChat(draft, target));
}

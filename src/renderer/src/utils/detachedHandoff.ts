import type { MainWindowTarget } from "@shared/desktop";

export type { MainWindowNewChatCheckout, MainWindowTarget } from "@shared/desktop";

export function openInMain(target: MainWindowTarget): Promise<void> {
  return window.inertia.openInMainWindow(target);
}

export function dockInMainWith(
  draft: string,
  target?: MainWindowTarget,
): Promise<void> {
  return target === undefined
    ? window.inertia.dockDetachedChat(draft)
    : window.inertia.dockDetachedChat(draft, target);
}

export interface NotificationGateWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

export function inertiaWindowInForeground(windows: readonly NotificationGateWindow[]): boolean {
  return windows.some((window) => !window.isDestroyed()
    && window.isFocused()
    && window.isVisible()
    && !window.isMinimized());
}

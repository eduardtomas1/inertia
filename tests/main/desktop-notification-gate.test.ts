import { describe, expect, it } from "vitest";

import {
  inertiaWindowInForeground,
  type NotificationGateWindow,
} from "../../src/main/desktop-notification-gate";

function window(state: Partial<Record<"destroyed" | "focused" | "visible" | "minimized", boolean>> = {}): NotificationGateWindow {
  const { destroyed = false, focused = false, visible = true, minimized = false } = state;
  return {
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isVisible: () => visible,
    isMinimized: () => minimized,
  };
}

describe("desktop notification background gate", () => {
  it("treats a focused, visible main window as foreground", () => {
    expect(inertiaWindowInForeground([window({ focused: true }), window()])).toBe(true);
  });

  it("treats a focused, visible detached chat window as foreground while the main window is blurred", () => {
    expect(inertiaWindowInForeground([window(), window({ focused: true })])).toBe(true);
  });

  it("treats Inertia as background when every window is blurred", () => {
    expect(inertiaWindowInForeground([window(), window(), window({ visible: false })])).toBe(false);
    expect(inertiaWindowInForeground([])).toBe(false);
  });

  it("ignores focused windows that are minimized, hidden or destroyed", () => {
    expect(inertiaWindowInForeground([window({ focused: true, minimized: true })])).toBe(false);
    expect(inertiaWindowInForeground([window({ focused: true, visible: false })])).toBe(false);
    expect(inertiaWindowInForeground([window({ focused: true, destroyed: true })])).toBe(false);
  });

  it("does not query a destroyed window", () => {
    const destroyed: NotificationGateWindow = {
      isDestroyed: () => true,
      isFocused: () => { throw new Error("Object has been destroyed"); },
      isVisible: () => { throw new Error("Object has been destroyed"); },
      isMinimized: () => { throw new Error("Object has been destroyed"); },
    };
    expect(inertiaWindowInForeground([destroyed, window()])).toBe(false);
  });
});

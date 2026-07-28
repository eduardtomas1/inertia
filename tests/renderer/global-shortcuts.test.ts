import { describe, expect, it, vi } from "vitest";

import {
  installGlobalShortcuts,
  type GlobalShortcutActions,
} from "../../src/renderer/src/utils/globalShortcuts";

class ShortcutEvent extends Event {
  readonly key: string;
  readonly metaKey = true;
  readonly ctrlKey = false;

  constructor(key: string) {
    super("keydown", { cancelable: true });
    this.key = key;
  }
}

function actions(createConversation: () => void): GlobalShortcutActions {
  return {
    createConversation,
    mobileNavigation: false,
    setActiveTool: vi.fn(),
    setPaletteOpen: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    setSidebarOpen: vi.fn(),
  };
}

describe("global shortcuts", () => {
  it("uses current actions without re-binding the listener after state changes", () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const first = vi.fn();
    const latest = vi.fn();
    const current = { current: actions(first) };
    const dispose = installGlobalShortcuts(
      target as unknown as Parameters<typeof installGlobalShortcuts>[0],
      current,
    );

    target.dispatchEvent(new ShortcutEvent("n"));
    current.current = actions(latest);
    target.dispatchEvent(new ShortcutEvent("n"));

    expect(add).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledTimes(1);

    dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("owns handled chords instead of forwarding them into focused widgets", () => {
    const target = new EventTarget();
    const current = { current: actions(vi.fn()) };
    const dispose = installGlobalShortcuts(
      target as unknown as Parameters<typeof installGlobalShortcuts>[0],
      current,
    );
    const event = new ShortcutEvent("k");

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.cancelBubble).toBe(true);
    expect(current.current.setPaletteOpen).toHaveBeenCalledWith(true);
    dispose();
  });
});

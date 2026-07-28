import { describe, expect, it, vi } from "vitest";

import {
  installGlobalShortcuts,
  type GlobalShortcutActions,
} from "../../src/renderer/src/utils/globalShortcuts";

class ShortcutEvent extends Event {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;

  constructor(
    type: "keydown" | "keyup",
    key: string,
    modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
  ) {
    super(type, { cancelable: true });
    this.key = key;
    this.metaKey = modifiers.metaKey ?? false;
    this.ctrlKey = modifiers.ctrlKey ?? false;
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

    target.dispatchEvent(new ShortcutEvent("keydown", "n", { metaKey: true }));
    current.current = actions(latest);
    target.dispatchEvent(new ShortcutEvent("keydown", "n", { metaKey: true }));

    expect(add).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledTimes(1);

    dispose();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("owns both halves of handled chords without repeating the action", () => {
    const target = new EventTarget();
    const current = { current: actions(vi.fn()) };
    const dispose = installGlobalShortcuts(
      target as unknown as Parameters<typeof installGlobalShortcuts>[0],
      current,
    );
    const keyDown = new ShortcutEvent("keydown", "k", { ctrlKey: true });
    const modifierUp = new ShortcutEvent("keyup", "Control");
    const keyUp = new ShortcutEvent("keyup", "k");

    target.dispatchEvent(keyDown);
    target.dispatchEvent(modifierUp);
    target.dispatchEvent(keyUp);

    expect(keyDown.defaultPrevented).toBe(true);
    expect(keyDown.cancelBubble).toBe(true);
    expect(modifierUp.defaultPrevented).toBe(false);
    expect(modifierUp.cancelBubble).toBe(false);
    expect(keyUp.defaultPrevented).toBe(true);
    expect(keyUp.cancelBubble).toBe(true);
    expect(current.current.setPaletteOpen).toHaveBeenCalledWith(true);
    expect(current.current.setPaletteOpen).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("leaves unrelated key releases available to focused widgets", () => {
    const target = new EventTarget();
    const current = { current: actions(vi.fn()) };
    const dispose = installGlobalShortcuts(
      target as unknown as Parameters<typeof installGlobalShortcuts>[0],
      current,
    );
    const keyUp = new ShortcutEvent("keyup", "k");

    target.dispatchEvent(keyUp);

    expect(keyUp.defaultPrevented).toBe(false);
    expect(keyUp.cancelBubble).toBe(false);
    expect(current.current.setPaletteOpen).not.toHaveBeenCalled();
    dispose();
  });
});

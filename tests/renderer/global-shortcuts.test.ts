import { describe, expect, it, vi } from "vitest";

import {
  installGlobalShortcuts,
  type GlobalShortcutActions,
} from "../../src/renderer/src/utils/globalShortcuts";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";

class ShortcutEvent extends Event {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;

  constructor(
    type: "keydown" | "keyup",
    key: string,
    modifiers: {
      metaKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
    } = {},
  ) {
    super(type, { cancelable: true });
    this.key = key;
    this.metaKey = modifiers.metaKey ?? false;
    this.ctrlKey = modifiers.ctrlKey ?? false;
    this.altKey = modifiers.altKey ?? false;
    this.shiftKey = modifiers.shiftKey ?? false;
  }
}

function actions(createConversation: () => void): GlobalShortcutActions {
  return {
    keybindings: DEFAULT_APP_KEYBINDINGS,
    createConversation,
    mobileNavigation: false,
    suspended: false,
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

  it("uses customized unique keys and stops owning the replaced defaults", () => {
    const target = new EventTarget();
    const current = { current: {
      ...actions(vi.fn()),
      keybindings: {
        search: "u",
        "new-chat": "y",
        "toggle-sidebar": "g",
        "toggle-terminal": "h",
      } as const,
    } };
    const dispose = installGlobalShortcuts(
      target as unknown as Parameters<typeof installGlobalShortcuts>[0],
      current,
    );
    const replacedDefault = new ShortcutEvent("keydown", "k", { metaKey: true });
    target.dispatchEvent(replacedDefault);
    target.dispatchEvent(new ShortcutEvent("keydown", "u", { metaKey: true }));

    expect(replacedDefault.defaultPrevented).toBe(false);
    expect(current.current.setPaletteOpen).toHaveBeenCalledWith(true);
    dispose();
  });

  it("does not consume primary-modifier chords with extra modifiers", () => {
    const target = new EventTarget();
    const current = { current: actions(vi.fn()) };
    const dispose = installGlobalShortcuts(
      target as unknown as Parameters<typeof installGlobalShortcuts>[0],
      current,
    );
    const shifted = new ShortcutEvent("keydown", "k", {
      metaKey: true,
      shiftKey: true,
    });
    target.dispatchEvent(shifted);

    expect(shifted.defaultPrevented).toBe(false);
    expect(current.current.setPaletteOpen).not.toHaveBeenCalled();
    dispose();
  });
});

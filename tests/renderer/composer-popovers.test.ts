import { describe, expect, it } from "vitest";

import {
  chooseHorizontalSubmenuSide,
  dismissibleMenuTransition,
  type DismissibleMenuAction,
} from "../../src/renderer/src/utils/dismissibleMenu";

type Menu = "provider" | "reasoning" | "mode" | "access" | "action";

function transition(current: Menu | null, action: DismissibleMenuAction<Menu>): Menu | null {
  return dismissibleMenuTransition(current, action);
}

describe("Composer popover state", () => {
  it("dismisses an open menu on an outside pointer without requiring a selection", () => {
    expect(transition("provider", { type: "outside-pointer" })).toBeNull();
  });

  it("dismisses on Escape and selection", () => {
    expect(transition("reasoning", { type: "escape" })).toBeNull();
    expect(transition("access", { type: "selection" })).toBeNull();
  });

  it("keeps the menu open for inside pointer interactions", () => {
    expect(transition("provider", { type: "inside-pointer" })).toBe("provider");
  });

  it("switches directly between menus and toggles the active trigger", () => {
    expect(transition("provider", { type: "toggle", menu: "mode" })).toBe("mode");
    expect(transition("mode", { type: "toggle", menu: "mode" })).toBeNull();
  });

  it("prefers a right submenu, falls back left, and requests drill-down when neither side fits", () => {
    expect(chooseHorizontalSubmenuSide({ left: 350, right: 574 }, 1_180, 288)).toBe("right");
    expect(chooseHorizontalSubmenuSide({ left: 350, right: 930 }, 1_180, 288)).toBe("left");
    expect(chooseHorizontalSubmenuSide({ left: 250, right: 930 }, 1_180, 288)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  chooseHorizontalSubmenuSide,
  dismissibleMenuTransition,
  type DismissibleMenuAction,
} from "../../src/renderer/src/utils/dismissibleMenu";
import {
  calculateComposerPopoverPlacement,
  calculateComposerSubmenuSide,
} from "../../src/renderer/src/utils/composerPopoverPlacement";

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

  it("keeps nested submenus inside the active pane instead of the global viewport", () => {
    expect(calculateComposerSubmenuSide({
      popover: { left: 350, right: 574 },
      boundary: { left: 0, right: 600 },
      requiredSpace: 288,
    })).toBe("left");
    expect(calculateComposerSubmenuSide({
      popover: { left: 610, right: 834 },
      boundary: { left: 600, right: 1_180 },
      requiredSpace: 288,
    })).toBe("right");
    expect(calculateComposerSubmenuSide({
      popover: { left: 170, right: 394 },
      boundary: { left: 150, right: 430 },
      requiredSpace: 288,
    })).toBeNull();
  });

  it("flips and clamps top-level menus at all four split-pane edges", () => {
    const boundary = { top: 0, right: 500, bottom: 600, left: 0 };
    const popover = { width: 330, height: 200 };
    const placements = [
      calculateComposerPopoverPlacement({
        trigger: { top: 520, right: 52, bottom: 552, left: 20 },
        boundary,
        popover,
      }),
      calculateComposerPopoverPlacement({
        trigger: { top: 520, right: 492, bottom: 552, left: 460 },
        boundary,
        popover,
      }),
      calculateComposerPopoverPlacement({
        trigger: { top: 520, right: 540, bottom: 552, left: 508 },
        boundary: { ...boundary, right: 1_000, left: 500 },
        popover,
      }),
      calculateComposerPopoverPlacement({
        trigger: { top: 520, right: 980, bottom: 552, left: 948 },
        boundary: { ...boundary, right: 1_000, left: 500 },
        popover,
      }),
    ];

    expect(placements.map(({ horizontal }) => horizontal)).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
    for (const [index, placement] of placements.entries()) {
      const activeBoundary = index < 2
        ? boundary
        : { ...boundary, right: 1_000, left: 500 };
      expect(placement.left).toBeGreaterThanOrEqual(activeBoundary.left + 8);
      expect(placement.left + popover.width)
        .toBeLessThanOrEqual(activeBoundary.right - 8);
      expect(placement.vertical).toBe("above");
    }
  });

  it("flips below when needed and constrains tall menus to internal scrolling", () => {
    const boundary = { top: 0, right: 500, bottom: 400, left: 0 };
    const below = calculateComposerPopoverPlacement({
      trigger: { top: 40, right: 72, bottom: 72, left: 40 },
      boundary,
      popover: { width: 260, height: 200 },
    });
    expect(below).toMatchObject({ vertical: "below", top: 80 });

    const constrained = calculateComposerPopoverPlacement({
      trigger: { top: 300, right: 472, bottom: 332, left: 440 },
      boundary,
      popover: { width: 260, height: 500 },
    });
    expect(constrained).toMatchObject({
      vertical: "above",
      top: 8,
      maxHeight: 284,
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  OUTSIDE_POINTER_FOCUS_TARGET_SELECTOR,
  outsidePointerShouldRestoreFocus,
} from "../../src/renderer/src/utils/dismissibleMenu";

function pointerTarget(matches: boolean): EventTarget {
  return {
    closest: vi.fn(() => matches ? {} : null),
  } as unknown as EventTarget;
}

describe("accessibility focus policy", () => {
  it("restores disclosure focus for blank targets but preserves real pointer destinations", () => {
    expect(outsidePointerShouldRestoreFocus(null)).toBe(true);
    expect(outsidePointerShouldRestoreFocus(pointerTarget(false))).toBe(true);
    expect(outsidePointerShouldRestoreFocus(pointerTarget(true))).toBe(false);
    expect(OUTSIDE_POINTER_FOCUS_TARGET_SELECTOR).toContain(
      '[tabindex]:not([tabindex="-1"])',
    );
    expect(OUTSIDE_POINTER_FOCUS_TARGET_SELECTOR.split(", ")).not.toContain(
      "[tabindex]",
    );
  });
});

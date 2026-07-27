import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  OUTSIDE_POINTER_FOCUS_TARGET_SELECTOR,
  outsidePointerShouldRestoreFocus,
} from "../../src/renderer/src/utils/dismissibleMenu";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const modelChooserSource = readFileSync(
  new URL("../../src/renderer/src/components/ModelChooser.tsx", import.meta.url),
  "utf8",
);
const usageSource = readFileSync(
  new URL("../../src/renderer/src/components/UsageIndicator.tsx", import.meta.url),
  "utf8",
);

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

  it("shares the same outside-pointer focus policy across menus, model chooser, and usage", () => {
    expect(modelChooserSource).toContain(
      "close(outsidePointerShouldRestoreFocus(event.target))",
    );
    expect(usageSource).toContain(
      "closePopover(outsidePointerShouldRestoreFocus(target))",
    );
  });

  it("focuses and restores the route-change confirmation without trapping ordinary composer controls", () => {
    expect(composerSource).toContain(
      "window.requestAnimationFrame(() => routeCancelRef.current?.focus())",
    );
    expect(composerSource).toContain('role="alertdialog"');
    expect(composerSource).toContain('aria-modal="false"');
    expect(composerSource).toContain(
      "aria-busy={creatingRouteConversation}",
    );
    expect(composerSource).toContain('event.key !== "Escape"');
    expect(composerSource).toContain(
      'querySelector<HTMLButtonElement>(".selected-model-chip")',
    );
  });

  it("keeps active-descendant ownership on the focused model search only", () => {
    expect(modelChooserSource.match(/aria-activedescendant=/gu)).toHaveLength(1);
    expect(modelChooserSource).toMatch(
      /<input[\s\S]*?aria-controls=\{resultsId\}[\s\S]*?aria-activedescendant=\{activeDescendant\}/u,
    );
    expect(modelChooserSource).toContain('className="model-chooser-listbox"');
    expect(modelChooserSource).toContain(
      'aria-label="Model favorite actions"',
    );
  });
});

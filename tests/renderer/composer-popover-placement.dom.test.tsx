import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useComposerMenus,
} from "../../src/renderer/src/components/composer/useComposerMenus";
import {
  positionComposerPopover,
} from "../../src/renderer/src/utils/composerPopoverPlacement";

const styles = readFileSync(
  resolve("src/renderer/src/styles.css"),
  "utf8",
).replace(/\r\n?/gu, "\n");
const visibilityRulesStart = styles.indexOf(".composer .popover-anchor\n  >");
const visibilityRulesEnd = styles.indexOf(
  "\n\n.action-popover",
  visibilityRulesStart,
);
const visibilityRules = styles.slice(
  visibilityRulesStart,
  visibilityRulesEnd,
);

function rect({
  top,
  right,
  bottom,
  left,
}: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("composer popover DOM placement", () => {
  it("keeps only outer composer surfaces hidden until placement completes", () => {
    expect(visibilityRulesStart).toBeGreaterThanOrEqual(0);
    expect(visibilityRulesEnd).toBeGreaterThan(visibilityRulesStart);
    const style = document.createElement("style");
    style.textContent = visibilityRules;
    document.head.append(style);
    document.body.innerHTML = `
      <div class="composer">
        <div class="popover-anchor">
          <div class="composer-popover prompt-stash-popover"></div>
          <div class="composer-more-layer">
            <div class="composer-popover composer-more-popover"></div>
            <div class="composer-popover composer-more-submenu"></div>
          </div>
        </div>
      </div>
    `;
    const topLevel = document.querySelector<HTMLElement>(
      ".prompt-stash-popover",
    )!;
    const layer = document.querySelector<HTMLElement>(
      ".composer-more-layer",
    )!;
    const moreRoot = document.querySelector<HTMLElement>(
      ".composer-more-popover",
    )!;
    const submenu = document.querySelector<HTMLElement>(
      ".composer-more-submenu",
    )!;

    expect(getComputedStyle(topLevel).visibility).toBe("hidden");
    expect(getComputedStyle(layer).visibility).toBe("hidden");
    topLevel.dataset.composerPopoverPositioned = "true";
    layer.dataset.composerPopoverPositioned = "true";
    expect(getComputedStyle(topLevel).visibility).toBe("visible");
    expect(getComputedStyle(layer).visibility).toBe("visible");
    expect(getComputedStyle(moreRoot).visibility).toBe("visible");
    expect(getComputedStyle(submenu).visibility).toBe("visible");
  });

  it("moves and narrows a scratch menu that would otherwise cross its pane", () => {
    document.body.innerHTML = `
      <section class="conversation-split-pane">
        <div class="chat-workspace">
          <button type="button">Scratch prompts</button>
          <div class="composer-popover prompt-stash-popover"></div>
        </div>
      </section>
    `;
    const pane = document.querySelector<HTMLElement>(
      ".conversation-split-pane",
    )!;
    const workspace = document.querySelector<HTMLElement>(".chat-workspace")!;
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    const popover = document.querySelector<HTMLElement>(".composer-popover")!;
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1_180);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(640);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect({
      top: 67,
      right: 555.7,
      bottom: 631,
      left: 292,
    }));
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(rect({
      top: 99,
      right: 555.7,
      bottom: 631,
      left: 292,
    }));
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect({
      top: 513,
      right: 494,
      bottom: 545,
      left: 462,
    }));
    vi.spyOn(popover, "getBoundingClientRect").mockImplementation(() => {
      const width = Number.parseFloat(popover.style.maxWidth) || 280;
      const [shiftX = 0, shiftY = 0] = popover.style.translate
        .match(/-?\d+(?:\.\d+)?/gu)
        ?.map(Number) ?? [];
      return rect({
        top: 391.7 + shiftY,
        right: 462.2 + shiftX + width,
        bottom: 506.3 + shiftY,
        left: 462.2 + shiftX,
      });
    });
    Object.defineProperties(popover, {
      clientHeight: { configurable: true, value: 114.6 },
      scrollHeight: { configurable: true, value: 114.6 },
    });

    const placement = positionComposerPopover(trigger, popover);
    const positioned = popover.getBoundingClientRect();
    expect(placement).toMatchObject({
      vertical: "above",
      horizontal: "clamped",
    });
    expect(positioned.left).toBeGreaterThanOrEqual(300);
    expect(positioned.right).toBeLessThanOrEqual(547.7);
    expect(positioned.top).toBeGreaterThanOrEqual(107);
    expect(popover.style.overflowY).toBe("auto");
    expect(popover.dataset.composerPopoverPositioned).toBe("true");
  });

  it("keeps an explicitly opened section through incidental pointer leave", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useComposerMenus());
    const layer = document.createElement("div");
    const popover = document.createElement("div");
    layer.dataset.composerSubmenuSide = "right";
    layer.append(popover);
    result.current.morePopoverRef.current = popover;

    act(() => result.current.openMoreSection("speed"));
    expect(result.current.moreSection).toBe("speed");

    act(() => {
      result.current.closeMorePreview();
      vi.advanceTimersByTime(180);
    });
    expect(result.current.moreSection).toBe("speed");

    act(() => result.current.previewMoreSection("reasoning"));
    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(result.current.moreSection).toBe("reasoning");

    act(() => {
      result.current.closeMorePreview();
      vi.advanceTimersByTime(180);
    });
    expect(result.current.moreSection).toBeNull();
  });
});

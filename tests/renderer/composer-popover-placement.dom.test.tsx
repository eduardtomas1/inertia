import { afterEach, describe, expect, it, vi } from "vitest";

import {
  positionComposerPopover,
} from "../../src/renderer/src/utils/composerPopoverPlacement";

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
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("composer popover DOM placement", () => {
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
});

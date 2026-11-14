import { act } from "@testing-library/react";
import { vi } from "vitest";

import type { ComposerFoldKey } from "../../src/renderer/src/components/composer/useComposerChipFolding";

export const SIMULATED_CHIP_WIDTHS: Readonly<Record<ComposerFoldKey, number>> = {
  branch: 90,
  mode: 80,
  access: 120,
  speed: 100,
  reasoning: 110,
};
export const SIMULATED_MODEL_WIDTH = 150;
export const SIMULATED_MORE_WIDTH = 28;
export const SIMULATED_STATUS_WIDTH = 120;
export const SIMULATED_POPOVER_OVERFLOW = 99;

function folded(element: Element): boolean {
  if (element.closest('[data-folded="true"], [hidden]')) return true;
  const overflow = element.closest(".composer-more-control");
  return overflow !== null && overflow.getAttribute("data-overflow") !== "true";
}

function rect(left: number, width: number, height = 30): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function childWidth(child: Element): number {
  if (folded(child)) return 0;
  if (child.classList.contains("model-chooser-anchor")) return SIMULATED_MODEL_WIDTH;
  if (child.classList.contains("composer-more-control")) return SIMULATED_MORE_WIDTH;
  const chips = [child, ...child.querySelectorAll("[data-composer-fold]")]
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element.dataset.composerFold !== undefined);
  return chips.reduce((sum, chip) => sum + (folded(chip) ? 0 : SIMULATED_CHIP_WIDTHS[chip.dataset.composerFold as ComposerFoldKey] ?? 0), 0);
}

function optionsContent(options: Element): number {
  let width = 0;
  for (const chip of options.querySelectorAll<HTMLElement>("[data-composer-fold]")) {
    if (!folded(chip)) width += SIMULATED_CHIP_WIDTHS[chip.dataset.composerFold as ComposerFoldKey] ?? 0;
  }
  if (options.querySelector(".model-chooser-anchor")) width += SIMULATED_MODEL_WIDTH;
  const overflow = options.querySelector(".composer-more-control");
  if (overflow && !folded(overflow)) width += SIMULATED_MORE_WIDTH;
  return width;
}

export interface SimulatedComposerLayout {
  setAvailableWidth: (width: number) => void;
  restore: () => void;
}

export function simulateComposerLayout(initialWidth: number): SimulatedComposerLayout {
  let available = initialWidth;
  const resizeCallbacks = new Set<ResizeObserverCallback>();
  class SimulatedResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeCallbacks.add(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      resizeCallbacks.delete(this.callback);
    }
  }
  vi.stubGlobal("ResizeObserver", SimulatedResizeObserver);
  const originalRects = Element.prototype.getClientRects;
  const room = (rail: Element | null): number =>
    available - (rail?.querySelector(":scope > .provider-status") ? SIMULATED_STATUS_WIDTH : 0);
  const box = (element: Element): DOMRect | null => {
    const rail = element.closest(".composer-primary-rail");
    if (!rail) return null;
    if (element === rail) return rect(0, available + 200);
    const options = rail.querySelector(":scope > .composer-options");
    if (!options) return null;
    if (element === options) return rect(0, Math.min(optionsContent(options), room(rail)));
    if (element.parentElement === options) {
      let left = 0;
      for (const child of options.children) {
        const width = childWidth(child);
        if (child === element) return rect(left, width);
        left += width;
      }
    }
    if (element.parentElement === rail && element.classList.contains("provider-status")) {
      return rect(room(rail), SIMULATED_STATUS_WIDTH);
    }
    if (element.parentElement === rail) return rect(available, 28);
    const key = (element as HTMLElement).dataset.composerFold as ComposerFoldKey | undefined;
    if (key) return rect(0, SIMULATED_CHIP_WIDTHS[key] ?? 0);
    if (element.classList.contains("composer-more-control")) return rect(0, SIMULATED_MORE_WIDTH);
    if (element.classList.contains("model-chooser-anchor")) return rect(0, SIMULATED_MODEL_WIDTH);
    return null;
  };
  const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return box(this) ?? rect(0, 0, 0);
  });
  const clientRects = vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const measured = box(this);
    if (!measured) {
      return this.closest(".composer-primary-rail") && folded(this)
        ? [] as unknown as DOMRectList
        : originalRects.call(this);
    }
    return (folded(this) ? [] : [measured]) as unknown as DOMRectList;
  });
  const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains("composer-options")) return 0;
    return optionsContent(this) + (this.querySelector(".composer-popover") ? SIMULATED_POPOVER_OVERFLOW : 0);
  });
  const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("composer-options")
      ? Math.min(optionsContent(this), room(this.closest(".composer-primary-rail")))
      : 0;
  });
  return {
    setAvailableWidth: (width) => {
      available = width;
      act(() => {
        for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      });
    },
    restore: () => {
      bounds.mockRestore();
      clientRects.mockRestore();
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

import { TOOLTIP_DELAY_MS } from "../../src/renderer/src/components/Tooltip";

export function hoverTooltipText(element: HTMLElement): string | null {
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(element, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const text = document.querySelector('[role="tooltip"]')?.textContent ?? null;
    fireEvent.pointerLeave(element, { pointerType: "mouse" });
    return text;
  } finally {
    vi.useRealTimers();
  }
}

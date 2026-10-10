import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS } from "../../src/renderer/src/components/Tooltip";
import { TooltipText } from "../../src/renderer/src/components/TooltipText";

function tooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tooltip"]');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_WARM_MS + 1);
  });
  vi.useRealTimers();
});

describe("tooltip text", () => {
  it("shows the shared tooltip on hover instead of a native title", () => {
    render(<TooltipText className="stamp" tooltip="Saturday, October 10, 2026 at 09:12">9:12</TooltipText>);
    const text = screen.getByText("9:12");
    expect(text).toHaveClass("stamp");
    expect(text).not.toHaveAttribute("title");
    fireEvent.pointerEnter(text, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()).toHaveTextContent("Saturday, October 10, 2026 at 09:12");
    fireEvent.pointerLeave(text, { pointerType: "mouse" });
    expect(tooltip()).toBeNull();
  });

  it("stays closed for touch and closes on press", () => {
    render(<TooltipText tooltip="Detail">Label</TooltipText>);
    const text = screen.getByText("Label");
    fireEvent.pointerEnter(text, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()).toBeNull();
    fireEvent.pointerEnter(text, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()).not.toBeNull();
    fireEvent.pointerDown(text, { pointerType: "mouse" });
    expect(tooltip()).toBeNull();
  });
});

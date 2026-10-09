import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS } from "../../src/renderer/src/components/Tooltip";
import { TooltipButton } from "../../src/renderer/src/components/TooltipButton";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_WARM_MS + 1);
  });
  vi.useRealTimers();
});

describe("text button tooltip", () => {
  it("keeps the visible name, drops the native title and shows the hint after the delay", () => {
    const onPointerEnter = vi.fn();
    render(<TooltipButton tooltip="Copy code" onPointerEnter={onPointerEnter}>Copy</TooltipButton>);
    const button = screen.getByRole("button", { name: "Copy" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("title");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(onPointerEnter).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("Copy code");
    fireEvent.pointerDown(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("hands its button to a caller ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<TooltipButton ref={ref} tooltip="Close" aria-label="Close preview">x</TooltipButton>);
    expect(ref.current).toBe(screen.getByRole("button", { name: "Close preview" }));
  });
});

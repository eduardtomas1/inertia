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

  it("describes a hint that differs from the visible name to assistive technology", () => {
    render(
      <div>
        <TooltipButton tooltip="Copy code">Copy</TooltipButton>
        <TooltipButton tooltip="Stop the active run before restoring a checkpoint" disabled>Revert</TooltipButton>
        <TooltipButton tooltip="Copy scrubbed diagnostics" aria-label="Copy diagnostics">C</TooltipButton>
        <TooltipButton tooltip="Close" aria-label="Close">x</TooltipButton>
      </div>,
    );
    const copy = screen.getByRole("button", { name: "Copy" });
    const revert = screen.getByRole("button", { name: "Revert" });
    const diagnostics = screen.getByRole("button", { name: "Copy diagnostics" });
    expect(copy).toHaveAccessibleDescription("Copy code");
    expect(revert).toBeDisabled();
    expect(revert).toHaveAccessibleDescription("Stop the active run before restoring a checkpoint");
    expect(diagnostics).toHaveAccessibleDescription("Copy scrubbed diagnostics");
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveAttribute("aria-describedby");
  });

  it("opens the hint over a disabled button", () => {
    render(<TooltipButton tooltip="The stored patch is unavailable" disabled>src/a.ts</TooltipButton>);
    const button = screen.getByRole("button", { name: "src/a.ts" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("The stored patch is unavailable");
  });
});

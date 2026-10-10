import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS } from "../../src/renderer/src/components/Tooltip";
import { TooltipButton } from "../../src/renderer/src/components/TooltipButton";
import { readSourceText } from "../helpers/source-text";

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

  it("describes its shortcut and leaves a caller's own description alone", () => {
    render(
      <div>
        <TooltipButton tooltip="Open preview" shortcut="⌘P" aria-label="Open preview">P</TooltipButton>
        <span id="title-hint">Rename with F2</span>
        <TooltipButton tooltip="Chat actions" aria-describedby="title-hint"><span>Draft</span></TooltipButton>
      </div>,
    );
    expect(screen.getByRole("button", { name: "Open preview" })).toHaveAccessibleDescription("⌘P");
    const title = screen.getByRole("button", { name: "Draft" });
    expect(title).toHaveAccessibleDescription("Rename with F2");
    expect(title.nextElementSibling).toBeNull();
  });

  it("still describes its hint when a caller passes an undefined description id", () => {
    render(
      <TooltipButton tooltip="Push the current branch to origin" aria-label="Push" aria-describedby={undefined}>
        <span>Push</span>
      </TooltipButton>,
    );
    expect(screen.getByRole("button", { name: "Push" })).toHaveAccessibleDescription("Push the current branch to origin");
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

  it("opens above when its trigger sits on a row that a native view covers below", () => {
    const rect = (top: number, height: number, width: number) => ({
      top, bottom: top + height, left: 100, right: 100 + width, width, height, x: 100, y: top, toJSON: () => ({}),
    });
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip" ? rect(0, 26, 90) : rect(60, 28, 28);
    });
    try {
      render(
        <div>
          <TooltipButton tooltip="Reload preview" aria-label="Reload preview">R</TooltipButton>
          <header data-tooltip-placement="above">
            <TooltipButton tooltip="Go back" aria-label="Go back">B</TooltipButton>
          </header>
        </div>,
      );
      const open = (name: string): HTMLElement => {
        const button = screen.getByRole("button", { name });
        fireEvent.pointerEnter(button, { pointerType: "mouse" });
        act(() => {
          vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
        });
        const tooltip = screen.getByRole("tooltip", { hidden: true });
        fireEvent.pointerLeave(button, { pointerType: "mouse" });
        act(() => {
          vi.advanceTimersByTime(TOOLTIP_WARM_MS + 1);
        });
        return tooltip;
      };
      expect(open("Reload preview").style.top).toBe("92px");
      expect(open("Go back").style.top).toBe("30px");
    } finally {
      spy.mockRestore();
    }
  });

  it("wraps a long hint onto more lines and places the taller box on whole pixels inside the window", () => {
    const css = readSourceText("src/renderer/src/styles.css");
    const start = css.indexOf("\n.tooltip {\n");
    const block = css.slice(start, css.indexOf("\n}", start + 1));
    expect(block).toContain("white-space: normal;");
    expect(block).toContain("overflow-wrap: anywhere;");
    expect(block).toContain("max-width: min(280px, calc(100vw - 16px));");
    expect(block).not.toContain("ellipsis");
    expect(block).not.toContain("nowrap");

    const root = document.documentElement;
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 760 });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 600 });
    const rect = (left: number, top: number, width: number, height: number) => ({
      top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}),
    });
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip" ? rect(0, 0, 279.5, 51.4) : rect(700.3, 560.2, 28, 28);
    });
    try {
      render(
        <TooltipButton tooltip="Stop the active run before restoring a checkpoint from this turn" aria-label="Restore">R</TooltipButton>,
      );
      fireEvent.pointerEnter(screen.getByRole("button", { name: "Restore" }), { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      const tooltip = screen.getByRole("tooltip", { hidden: true });
      const left = Number.parseFloat(tooltip.style.left);
      const top = Number.parseFloat(tooltip.style.top);
      expect(Number.isInteger(left)).toBe(true);
      expect(Number.isInteger(top)).toBe(true);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + 279.5).toBeLessThanOrEqual(752);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(top + 51.4).toBeLessThanOrEqual(560.2 - 4);
    } finally {
      spy.mockRestore();
      delete (root as { clientWidth?: number }).clientWidth;
      delete (root as { clientHeight?: number }).clientHeight;
    }
  });
});

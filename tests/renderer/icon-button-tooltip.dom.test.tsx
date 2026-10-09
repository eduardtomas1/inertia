import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS } from "../../src/renderer/src/components/Tooltip";
import { IconButton, TooltipButton } from "../../src/renderer/src/components/ui";

function tooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tooltip"]');
}

function hover(element: HTMLElement): void {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
}

function leave(element: HTMLElement): void {
  fireEvent.pointerLeave(element, { pointerType: "mouse" });
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

describe("icon button tooltip", () => {
  it("keeps the accessible name and drops the native title", () => {
    render(<IconButton label="Refresh changes" onClick={() => undefined}>R</IconButton>);
    const button = screen.getByRole("button", { name: "Refresh changes" });
    expect(button).toHaveAttribute("aria-label", "Refresh changes");
    expect(button).not.toHaveAttribute("title");
  });

  it("opens after 500ms of hover and shows the shortcut as faint text", () => {
    render(<IconButton label="New chat" shortcut="⌘N">N</IconButton>);
    const button = screen.getByRole("button", { name: "New chat" });
    hover(button);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    });
    expect(tooltip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tooltip()).toHaveTextContent("New chat⌘N");
    expect(tooltip()?.querySelector("kbd")).toHaveTextContent("⌘N");
    expect(tooltip()?.parentElement).toBe(document.body);
    leave(button);
    expect(tooltip()).toBeNull();
  });

  it("opens the next trigger immediately while moving between buttons", () => {
    render(
      <div>
        <IconButton label="Copy">C</IconButton>
        <IconButton label="Paste">P</IconButton>
      </div>,
    );
    const copy = screen.getByRole("button", { name: "Copy" });
    const paste = screen.getByRole("button", { name: "Paste" });
    hover(copy);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()).toHaveTextContent("Copy");
    leave(copy);
    hover(paste);
    expect(tooltip()).toHaveTextContent("Paste");
    leave(paste);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_WARM_MS + 1);
    });
    hover(copy);
    expect(tooltip()).toBeNull();
  });

  it("closes on scroll, on pointer down anywhere and on Escape", () => {
    render(<IconButton label="Settings">S</IconButton>);
    const button = screen.getByRole("button", { name: "Settings" });
    const open = () => {
      leave(button);
      hover(button);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      expect(tooltip()).not.toBeNull();
    };
    open();
    fireEvent.scroll(document);
    expect(tooltip()).toBeNull();
    open();
    fireEvent.pointerDown(document.body);
    expect(tooltip()).toBeNull();
    open();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(tooltip()).toBeNull();
  });

  it("never opens before the delay when the pointer leaves first and still calls the caller's handlers", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    render(<IconButton label="Close" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>X</IconButton>);
    const button = screen.getByRole("button", { name: "Close" });
    hover(button);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS / 2);
    });
    leave(button);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()).toBeNull();
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });

  it("lets Escape close an open tooltip without closing the surrounding dialog, then reach the dialog", () => {
    const dialogEscape = vi.fn();
    render(
      <div role="dialog" aria-label="Settings dialog" onKeyDown={(event) => { if (event.key === "Escape") dialogEscape(); }}>
        <IconButton label="Refresh">R</IconButton>
      </div>,
    );
    const button = screen.getByRole("button", { name: "Refresh" });
    hover(button);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()).not.toBeNull();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(tooltip()).toBeNull();
    expect(dialogEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(dialogEscape).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a popover", (children: React.ReactNode) => <div popover="auto" data-testid="layer">{children}</div>],
    ["a dialog", (children: React.ReactNode) => <dialog open data-testid="layer">{children}</dialog>],
  ] as const)("renders the tooltip inside %s so the top layer does not hide it", (_name, wrap) => {
    render(wrap(<IconButton label="Pin project">P</IconButton>));
    hover(screen.getByRole("button", { name: "Pin project" }));
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()?.parentElement).toBe(screen.getByTestId("layer"));
  });

  it("lets a labelled button keep its own accessible name beside a shorter tooltip", () => {
    render(<TooltipButton tooltip="Snooze thread" aria-label="Snooze Draft the notes" className="row-action">Z</TooltipButton>);
    const button = screen.getByRole("button", { name: "Snooze Draft the notes" });
    expect(button).toHaveClass("row-action");
    expect(button).not.toHaveClass("icon-button");
    expect(button).not.toHaveAttribute("title");
    hover(button);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(tooltip()).toHaveTextContent(/^Snooze thread$/u);
    leave(button);
  });
});

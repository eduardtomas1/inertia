import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS } from "../../src/renderer/src/components/Tooltip";
import { IconButton } from "../../src/renderer/src/components/ui";

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
});

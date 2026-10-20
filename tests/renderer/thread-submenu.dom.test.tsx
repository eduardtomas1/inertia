import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadSubmenu } from "../../src/renderer/src/components/sidebar/ThreadSubmenu";

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <div role="menu" aria-label="Thread actions">
      <ThreadSubmenu label="Copy" icon={null} open={open} onOpenChange={setOpen}>
        <button type="button" role="menuitem" tabIndex={-1}>Path</button>
        <button type="button" role="menuitem" tabIndex={-1}>Thread ID</button>
      </ThreadSubmenu>
    </div>
  );
}

describe("thread submenu", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("opens beside its row even when its menu becomes the containing block for fixed elements", () => {
    const frame = { left: 131, top: 232 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("thread-submenu")) {
        const left = Number.parseFloat(this.style.left || "0") + frame.left;
        const top = Number.parseFloat(this.style.top || "0") + frame.top;
        return new DOMRect(left, top, 180, 64);
      }
      if (this.getAttribute("role") === "menuitem" && this.textContent === "Copy") return new DOMRect(133, 415, 219, 27);
      return new DOMRect(0, 0, 0, 0);
    });
    render(<Host />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }), { detail: 1 });
    const submenu = screen.getByRole("menu", { name: "Copy" });
    const placed = submenu.getBoundingClientRect();
    expect(placed.left).toBe(356);
    expect(placed.top).toBe(415);

    frame.left = 0;
    frame.top = 0;
    act(() => { window.dispatchEvent(new Event("animationend")); });
    const settled = submenu.getBoundingClientRect();
    expect(settled.left).toBe(356);
    expect(settled.top).toBe(415);
  });

  it("stays open when the pointer that opened it on hover then clicks the item", () => {
    render(<Host />);
    const trigger = screen.getByRole("menuitem", { name: "Copy" });
    fireEvent.pointerEnter(trigger.parentElement!);
    expect(screen.getByRole("menu", { name: "Copy" })).toBeInTheDocument();
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByRole("menu", { name: "Copy" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("opens on a click without hover and moves keyboard activation into the submenu", async () => {
    render(<Host />);
    const trigger = screen.getByRole("menuitem", { name: "Copy" });
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByRole("menu", { name: "Copy" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Copy" }), { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "Copy" })).toBeNull();
    fireEvent.click(trigger, { detail: 0 });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(screen.getByRole("menuitem", { name: "Path" })).toHaveFocus();
  });
});

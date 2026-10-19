import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

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

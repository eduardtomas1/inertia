import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DialogShell } from "../../src/renderer/src/components/DialogShell";

function renderDialog(body: React.ReactNode) {
  render(
    <DialogShell titleId="t" title="Usage limits" closeLabel="Close usage limits" onClose={vi.fn()} tabIndex={-1}>
      <button type="button">First action</button>
      {body}
    </DialogShell>,
  );
  return { dialog: screen.getByRole("dialog", { name: "Usage limits" }), close: screen.getByRole("button", { name: "Close usage limits" }) };
}

describe("modal focus trap", () => {
  it("wraps from a trailing disclosure summary back to the first control", () => {
    const { close } = renderDialog(<details><summary>Usage sources</summary></details>);
    const summary = screen.getByText("Usage sources");
    summary.focus();
    fireEvent.keyDown(summary, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(summary).toHaveFocus();
  });

  it("skips controls inside collapsed inert or visibility-hidden regions", () => {
    const { close } = renderDialog(<>
      <button type="button">Last reachable</button>
      <div inert><button type="button">Collapsed account</button></div>
      <div style={{ visibility: "hidden" }}><button type="button">Hidden account</button></div>
    </>);
    const last = screen.getByRole("button", { name: "Last reachable" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("keeps Shift+Tab inside the dialog when the dialog itself holds focus", () => {
    const { dialog } = renderDialog(<button type="button">Last action</button>);
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close usage limits" })).toHaveFocus();
  });
});

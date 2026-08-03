import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useDismissibleMenu } from "../../src/renderer/src/hooks/useDismissibleMenu";

function Harness(): React.JSX.Element {
  const [disabled, setDisabled] = useState(false);
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = useDismissibleMenu<"mode">();

  return (
    <>
      <button
        ref={(node) => setMenuTrigger("mode", node)}
        type="button"
        disabled={disabled}
        onClick={() => toggleMenu("mode")}
      >
        Choose work mode
      </button>
      {menu === "mode" && (
        <div
          ref={(node) => setMenuPopover("mode", node)}
          role="menu"
          aria-label="Work mode"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked="false"
            onClick={() => {
              setDisabled(true);
              window.requestAnimationFrame(() => {
                dismissMenu("selection");
                window.requestAnimationFrame(() => setDisabled(false));
              });
            }}
          >
            Plan
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked="false"
            onClick={() => {
              setDisabled(true);
              dismissMenu("selection");
            }}
          >
            Keep new focus
          </button>
        </div>
      )}
      <button type="button" onClick={() => setDisabled(false)}>
        Other control
      </button>
    </>
  );
}

describe("useDismissibleMenu focus restoration", () => {
  it("waits until an asynchronously updated trigger is enabled", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Choose work mode" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Plan" }));

    await waitFor(() => expect(trigger).toBeDisabled());
    await waitFor(() => expect(trigger).toBeEnabled());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Work mode" }))
      .not.toBeInTheDocument();
  });

  it("does not steal focus after the user chooses another control", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Choose work mode" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", {
      name: "Keep new focus",
    }));
    await waitFor(() => expect(trigger).toBeDisabled());

    const otherControl = screen.getByRole("button", { name: "Other control" });
    fireEvent.pointerDown(otherControl);
    otherControl.focus();
    fireEvent.click(otherControl);

    await waitFor(() => expect(trigger).toBeEnabled());
    await waitFor(() => expect(otherControl).toHaveFocus());
    expect(trigger).not.toHaveFocus();
  });
});

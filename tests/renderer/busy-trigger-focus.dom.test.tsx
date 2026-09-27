import { act, render, screen } from "@testing-library/react";
import { createRef, useImperativeHandle, useRef } from "react";
import { describe, expect, it } from "vitest";

import { useBusyTriggerFocus } from "../../src/renderer/src/hooks/useBusyTriggerFocus";

type Hold = (trigger: HTMLElement) => void;

const holdRef = createRef<Hold>();

function hold(trigger: HTMLElement): void {
  holdRef.current?.(trigger);
}

function Harness({ busy }: { busy: boolean }): React.JSX.Element {
  const holderRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const holdFocus = useBusyTriggerFocus(busy, holderRef, triggerRef);
  useImperativeHandle(holdRef, () => holdFocus);
  return (
    <>
      <button ref={triggerRef} type="button">Refresh</button>
      <button ref={holderRef} type="button">Close</button>
    </>
  );
}

describe("useBusyTriggerFocus", () => {
  it("holds focus for the whole busy period it was requested for, then returns it", () => {
    const view = render(<Harness busy={false} />);
    const trigger = screen.getByRole("button", { name: "Refresh" });
    const holder = screen.getByRole("button", { name: "Close" });
    trigger.focus();

    act(() => hold(trigger));
    expect(holder).toHaveFocus();

    view.rerender(<Harness busy />);
    expect(holder).toHaveFocus();

    view.rerender(<Harness busy={false} />);
    expect(trigger).toHaveFocus();
  });

  it("ignores the end of an earlier busy period that commits after the hand-off", () => {
    const view = render(<Harness busy />);
    const trigger = screen.getByRole("button", { name: "Refresh" });
    const holder = screen.getByRole("button", { name: "Close" });
    trigger.focus();

    act(() => {
      view.rerender(<Harness busy={false} />);
      hold(trigger);
    });
    expect(holder).toHaveFocus();

    view.rerender(<Harness busy />);
    expect(holder).toHaveFocus();
    view.rerender(<Harness busy={false} />);
    expect(trigger).toHaveFocus();
  });

  it("does not take focus back after the user moved it elsewhere", () => {
    const view = render(<Harness busy={false} />);
    const trigger = screen.getByRole("button", { name: "Refresh" });
    const holder = screen.getByRole("button", { name: "Close" });
    trigger.focus();

    act(() => hold(trigger));
    view.rerender(<Harness busy />);
    holder.blur();
    view.rerender(<Harness busy={false} />);

    expect(trigger).not.toHaveFocus();
  });
});

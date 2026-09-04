// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DialogPresence } from "../../src/renderer/src/components/DialogPresence";

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal("matchMedia", () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DialogPresence", () => {
  it("keeps a closing surface inert for its short exit animation", async () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const view = render(
      <DialogPresence open><div role="dialog">Visible</div></DialogPresence>,
    );

    view.rerender(
      <DialogPresence open={false}><div role="dialog">Closing</div></DialogPresence>,
    );

    const presence = view.container.querySelector(".dialog-presence");
    expect(presence).toHaveClass("is-closing");
    expect(presence).toHaveAttribute("aria-hidden", "true");
    expect(presence).toHaveAttribute("inert");
    expect(screen.getByText("Closing")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTime(90));
    expect(view.container).toBeEmptyDOMElement();
  });

  it("skips exit retention when reduced motion is requested", async () => {
    stubReducedMotion(true);
    const view = render(
      <DialogPresence open><div role="dialog">Visible</div></DialogPresence>,
    );

    await act(async () => view.rerender(
      <DialogPresence open={false}><div role="dialog">Closing</div></DialogPresence>,
    ));

    expect(view.container).toBeEmptyDOMElement();
  });

  it("cancels a pending exit when the dialog reopens", async () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const view = render(
      <DialogPresence open><div role="dialog">Visible</div></DialogPresence>,
    );
    view.rerender(
      <DialogPresence open={false}><div role="dialog">Closing</div></DialogPresence>,
    );
    view.rerender(
      <DialogPresence open><div role="dialog">Reopened</div></DialogPresence>,
    );

    await act(async () => vi.advanceTimersByTime(90));

    expect(screen.getByRole("dialog")).toHaveTextContent("Reopened");
    expect(view.container.querySelector(".dialog-presence"))
      .not.toHaveClass("is-closing");
  });
});

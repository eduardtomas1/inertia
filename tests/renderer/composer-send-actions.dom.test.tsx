import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerSendActions } from "../../src/renderer/src/components/composer/ComposerSendActions";
import { ComposerSendActionsFallback } from "../../src/renderer/src/components/composer/ComposerSendActionsFallback";

const idle = {
  followUpState: "hidden" as const,
  feedback: null,
  onSubmit: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
};

afterEach(() => vi.unstubAllGlobals());

describe("composer morphing send actions", () => {
  it.each([
    ["Send message", "hidden", "send-ready"],
    ["Stop agent", "hidden", "stop-ready"],
    ["Send follow-up", "ready", "stop-ready"],
  ] as const)(
    "preserves focus on %s when the deferred action replaces its fallback",
    (label, followUpState, primaryAction) => {
      const props = { ...idle, followUpState, primaryAction };
      const view = render(
        <div className="composer-actions">
          <ComposerSendActionsFallback {...props} />
        </div>,
      );
      screen.getByRole("button", { name: label }).focus();

      view.rerender(
        <div className="composer-actions">
          <ComposerSendActions {...props} />
        </div>,
      );

      expect(screen.getByRole("button", { name: label })).toHaveFocus();
    },
  );

  it("keeps one primary control mounted across intent, send, and Stop states", () => {
    const view = render(
      <ComposerSendActions {...idle} primaryAction="send-ready" />,
    );
    const primary = screen.getByRole("button", { name: "Send message" });
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "send");

    fireEvent.pointerEnter(primary);
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "send-intent");

    view.rerender(
      <ComposerSendActions {...idle} primaryAction="submitting" />,
    );
    expect(screen.getByRole("button", { name: "Sending message" }))
      .toBe(primary);
    expect(primary).toHaveAttribute("aria-busy", "true");
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "sending");

    view.rerender(
      <ComposerSendActions
        {...idle}
        primaryAction="submitting"
        feedback={{ disposition: "new-turn", turnId: "turn-accepted", visible: true }}
      />,
    );
    expect(screen.getByRole("button", { name: "Message accepted" }))
      .toBe(primary);
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "accepted");

    view.rerender(
      <ComposerSendActions
        {...idle}
        primaryAction="submitting"
        feedback={{ disposition: "new-turn", turnId: "turn-accepted", visible: false }}
      />,
    );
    expect(screen.getByRole("button", { name: "Message accepted" }))
      .toBe(primary);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    view.rerender(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        feedback={{ disposition: "new-turn", turnId: "turn-accepted", visible: false }}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop agent" })).toBe(primary);
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "stop");
  });

  it("shows accepted follow-up feedback beside an immediately available Stop", () => {
    const feedback = {
      disposition: "follow-up" as const,
      turnId: "turn-running",
      visible: true,
    };
    const view = render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        feedback={feedback}
      />,
    );

    const accepted = screen.getByRole("status");
    expect(accepted).toHaveTextContent("Follow-up accepted.");
    expect(accepted.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "accepted");
    expect(screen.getByRole("button", { name: "Stop agent" })).toBeEnabled();

    view.rerender(
      <ComposerSendActions
        {...idle}
        followUpState="ready"
        primaryAction="stop-ready"
        feedback={feedback}
      />,
    );
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps Stop authoritative while showing a separate new-turn acceptance", () => {
    render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        feedback={{ disposition: "new-turn", turnId: "turn-running", visible: true }}
      />,
    );

    expect(screen.getByRole("button", { name: "Stop agent" })).toBeEnabled();
    expect(screen.getByRole("status"))
      .toHaveTextContent("Message accepted.");
  });

  it("jumps to the target path when the user prefers reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } satisfies MediaQueryList)));
    const view = render(
      <ComposerSendActions {...idle} primaryAction="send-ready" />,
    );
    const primary = screen.getByRole("button", { name: "Send message" });
    const path = primary.querySelector("path");
    const sendPath = path?.getAttribute("d");
    expect(path).not.toBeNull();

    view.rerender(
      <ComposerSendActions
        {...idle}
        primaryAction="submitting"
        feedback={{ disposition: "new-turn", turnId: "turn-reduced", visible: true }}
      />,
    );

    expect(screen.getByRole("button", { name: "Message accepted" }))
      .toBe(primary);
    expect(primary.querySelector("path")).toBe(path);
    expect(path?.getAttribute("d")).not.toBe(sendPath);
  });
});

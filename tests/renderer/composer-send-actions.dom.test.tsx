import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerSendActions } from "../../src/renderer/src/components/composer/ComposerSendActions";
import { ComposerSendActionsFallback } from "../../src/renderer/src/components/composer/ComposerSendActionsFallback";

const idle = {
  conversationId: "composer-actions",
  canSendQueuedNow: true,
  running: false,
  latestTurnId: null,
  latestTurnStatus: null,
  onSendQueued: vi.fn(async () => undefined),
  onSubmit: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("composer morphing send actions", () => {
  it.each([
    ["Send message", "send-ready"],
    ["Stop agent", "stop-ready"],
  ] as const)(
    "preserves focus on %s when the deferred action replaces its fallback",
    (label, primaryAction) => {
      const props = { ...idle, primaryAction };
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
        primaryAction="stop-ready"
      />,
    );
    expect(screen.getByRole("button", { name: "Stop agent" })).toBe(primary);
    expect(primary.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "stop");
  });

  it("shows the head of the queue with immediate-send and remove actions", async () => {
    const onSendQueued = vi.fn(async () => undefined);
    window.localStorage.setItem(
      "inertia:queued-prompts:composer-actions",
      JSON.stringify([
        { id: "queued-1", content: "Run the release checks", createdAt: "2026-08-21T10:00:00.000Z" },
        { id: "queued-2", content: "Update the changelog", createdAt: "2026-08-21T10:01:00.000Z" },
      ]),
    );
    render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
        onSendQueued={onSendQueued}
      />,
    );

    expect(screen.getByText("Run the release checks")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send queued message now" }));
    expect(onSendQueued).toHaveBeenCalledWith("Run the release checks");
    expect(await screen.findByText("Update the changelog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
    await waitFor(() => expect(screen.queryByRole("list", {
      name: "Queued messages",
    })).not.toBeInTheDocument());
    expect(window.localStorage.getItem(
      "inertia:queued-prompts:composer-actions",
    )).toBeNull();
  });

  it("keeps Stop authoritative without a separate new-turn acceptance", () => {
    render(
      <ComposerSendActions
        {...idle}
        primaryAction="stop-ready"
      />,
    );

    expect(screen.getByRole("button", { name: "Stop agent" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
      />,
    );

    expect(screen.getByRole("button", { name: "Sending message" }))
      .toBe(primary);
    expect(primary.querySelector("path")).toBe(path);
    expect(path?.getAttribute("d")).not.toBe(sendPath);
  });
});

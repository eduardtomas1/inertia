import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFreshRequest } from "../../src/renderer/src/components/response-timeline/useFreshRequest";
import {
  claimFreshRequest,
  COMPOSER_SENT_MS,
  FRESH_REQUEST_WINDOW_MS,
  isFreshRequest,
  markComposerSent,
  noteRequestSent,
  resetSentRequests,
} from "../../src/renderer/src/utils/requestLiftOff";

function Bubble({ content }: { content: string }): React.JSX.Element {
  const fresh = useFreshRequest(content);
  return <article data-testid="bubble" data-fresh={fresh || undefined}>{content}</article>;
}

afterEach(() => {
  cleanup();
  resetSentRequests();
  vi.useRealTimers();
});

describe("send lift-off", () => {
  it("marks only a request sent from this window within the freshness window, once", () => {
    noteRequestSent("  Ship it  ", 1_000);
    expect(isFreshRequest("Ship it", 1_000 + FRESH_REQUEST_WINDOW_MS - 1)).toBe(true);
    expect(isFreshRequest("Ship it", 1_000 + FRESH_REQUEST_WINDOW_MS)).toBe(false);
    expect(isFreshRequest("Something else", 1_001)).toBe(false);
    expect(claimFreshRequest("Ship it", 1_002)).toBe(true);
    expect(claimFreshRequest("Ship it", 1_003)).toBe(false);
  });

  it("animates the first mount of a just-sent bubble and never a remount or history", () => {
    render(<Bubble content="Old history request" />);
    expect(document.querySelector('[data-fresh]')).toBeNull();
    cleanup();

    noteRequestSent("Fix the login bug");
    const first = render(<Bubble content="Fix the login bug" />);
    expect(first.getByTestId("bubble")).toHaveAttribute("data-fresh");
    first.unmount();

    const remount = render(<Bubble content="Fix the login bug" />);
    expect(remount.getByTestId("bubble")).not.toHaveAttribute("data-fresh");
  });

  it("lets the composer exhale once per send and settle back", () => {
    vi.useFakeTimers();
    const region = document.createElement("div");
    const composer = document.createElement("section");
    composer.className = "composer";
    region.append(composer);
    document.body.append(region);
    try {
      markComposerSent(region);
      expect(composer).toHaveAttribute("data-just-sent");
      vi.advanceTimersByTime(COMPOSER_SENT_MS - 10);
      markComposerSent(region);
      vi.advanceTimersByTime(COMPOSER_SENT_MS - 10);
      expect(composer).toHaveAttribute("data-just-sent");
      vi.advanceTimersByTime(10);
      expect(composer).not.toHaveAttribute("data-just-sent");
      expect(() => markComposerSent(null)).not.toThrow();
    } finally {
      region.remove();
    }
  });
});

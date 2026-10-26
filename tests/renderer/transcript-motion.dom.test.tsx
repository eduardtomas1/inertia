import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  jumpToLatestBehavior,
  TimelineJumpToLatest,
} from "../../src/renderer/src/components/TimelineJumpToLatest";
import {
  lockAnimationPhase,
  usePhaseLockedAnimations,
} from "../../src/renderer/src/hooks/usePhaseLockedAnimations";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fakeAnimation(overrides: Partial<{ playState: string; startTime: number | null; animationName: string }>) {
  return { playState: "running", startTime: 412, animationName: "agent-pixel-shimmer", ...overrides };
}

describe("phase-locked loaders", () => {
  it("restarts only running CSS animations from the shared timeline origin", () => {
    const element = document.createElement("span");
    const running = fakeAnimation({});
    const paused = fakeAnimation({ playState: "paused", startTime: null });
    const transition = { playState: "running", startTime: 90 };
    Object.defineProperty(element, "getAnimations", {
      value: () => [running, paused, transition],
    });
    lockAnimationPhase(element);
    expect(running.startTime).toBe(0);
    expect(paused.startTime).toBeNull();
    expect(transition.startTime).toBe(90);
  });

  it("is a no-op where the Web Animations API is missing", () => {
    expect(() => lockAnimationPhase(document.createElement("span"))).not.toThrow();
    expect(() => lockAnimationPhase(null)).not.toThrow();
  });

  it("locks on mount and again when its key changes", () => {
    const animation = fakeAnimation({});
    const getAnimations = vi.fn(() => [animation]);
    const original = Element.prototype.getAnimations;
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: getAnimations });
    function Loader({ phase }: { phase: string }): React.JSX.Element {
      const ref = usePhaseLockedAnimations<HTMLSpanElement>(phase);
      return <span ref={ref} />;
    }
    try {
      const view = render(<Loader phase="working" />);
      expect(animation.startTime).toBe(0);
      const calls = getAnimations.mock.calls.length;
      animation.startTime = 77;
      view.rerender(<Loader phase="thinking" />);
      expect(getAnimations.mock.calls.length).toBeGreaterThan(calls);
      expect(animation.startTime).toBe(0);
    } finally {
      Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: original });
    }
  });
});

describe("jump to latest", () => {
  it("glides under three viewports and jumps further away or under reduced motion", () => {
    const at = (scrollTop: number) => ({ scrollHeight: 5_000, clientHeight: 1_000, scrollTop });
    expect(jumpToLatestBehavior(at(2_100), false)).toBe("smooth");
    expect(jumpToLatestBehavior(at(1_000), false)).toBe("auto");
    expect(jumpToLatestBehavior(at(3_900), true)).toBe("auto");
    expect(jumpToLatestBehavior(null, false)).toBe("auto");
  });

  it("floats in, fades out without keeping a focusable button, and hands focus to the transcript", () => {
    vi.useFakeTimers();
    const scroller = document.createElement("div");
    scroller.tabIndex = 0;
    document.body.append(scroller);
    const scrollElementRef = createRef<HTMLElement>() as { current: HTMLElement | null };
    scrollElementRef.current = scroller;
    const onJump = vi.fn();
    try {
      const view = render(<TimelineJumpToLatest visible scrollElementRef={scrollElementRef} onJump={onJump} />);
      const button = screen.getByRole("button", { name: "Jump to latest" });
      expect(button.closest(".timeline-follow-controls")).not.toBeNull();
      button.focus();
      fireEvent.click(button);
      expect(onJump).toHaveBeenCalledWith("auto");

      view.rerender(<TimelineJumpToLatest visible={false} scrollElementRef={scrollElementRef} onJump={onJump} />);
      expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
      expect(document.querySelector(".timeline-follow-controls")).toBeNull();
      expect(document.querySelector('.timeline-jump[data-state="leaving"]')).not.toBeNull();
      expect(document.activeElement).toBe(scroller);

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(document.querySelector(".timeline-jump")).toBeNull();
    } finally {
      scroller.remove();
    }
  });
});

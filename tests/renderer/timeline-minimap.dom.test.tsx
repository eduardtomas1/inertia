import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TimelineMinimap,
  type TimelineMarker,
} from "../../src/renderer/src/components/response-timeline/viewport";

const markers: TimelineMarker[] = [
  {
    timelineIndex: 0,
    id: "turn-1",
    label: "Inspect the lifecycle boundary",
    number: 1,
  },
  {
    timelineIndex: 4,
    id: "turn-2",
    label: "Verify the focused regression",
    number: 2,
  },
];

describe("TimelineMinimap", () => {
  afterEach(() => vi.restoreAllMocks());

  it("owns one custom preview across pointer and keyboard focus", () => {
    const onNavigate = vi.fn();
    render(
      <TimelineMinimap
        activeIndex={0}
        left={24}
        markers={markers}
        onNavigate={onNavigate}
      />,
    );

    const first = screen.getByRole("button", {
      name: "Go to turn 1: Inspect the lifecycle boundary",
    });
    const second = screen.getByRole("button", {
      name: "Go to turn 2: Verify the focused regression",
    });
    expect(first).not.toHaveAttribute("title");
    expect(second).not.toHaveAttribute("title");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.pointerEnter(first);
    expect(first).toHaveAttribute("data-emphasized", "true");
    expect(document.querySelectorAll(".timeline-minimap-preview")).toHaveLength(1);
    expect(document.querySelector(".timeline-minimap-preview")).toHaveTextContent(
      "Turn 1 · Inspect the lifecycle boundary",
    );
    expect(first).not.toHaveAttribute("aria-describedby");
    expect(document.querySelector(".timeline-minimap-preview"))
      .toHaveAttribute("aria-hidden", "true");

    fireEvent.pointerLeave(first);
    fireEvent.focus(first);
    expect(first).toHaveAttribute("data-emphasized", "true");
    expect(document.querySelectorAll(".timeline-minimap-preview")).toHaveLength(1);
    expect(document.querySelector(".timeline-minimap-preview")).toHaveTextContent(
      "Turn 1 · Inspect the lifecycle boundary",
    );

    fireEvent.pointerEnter(second);
    expect(first).not.toHaveAttribute("data-emphasized");
    expect(second).toHaveAttribute("data-emphasized", "true");
    expect(document.querySelectorAll(".timeline-minimap-preview")).toHaveLength(1);
    expect(document.querySelector(".timeline-minimap-preview")).toHaveTextContent(
      "Turn 2 · Verify the focused regression",
    );

    fireEvent.pointerLeave(second);
    expect(first).toHaveAttribute("data-emphasized", "true");
    expect(second).not.toHaveAttribute("data-emphasized");
    expect(document.querySelectorAll(".timeline-minimap-preview")).toHaveLength(1);
    expect(document.querySelector(".timeline-minimap-preview")).toHaveTextContent(
      "Turn 1 · Inspect the lifecycle boundary",
    );

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("data-emphasized", "true");
    expect(document.querySelectorAll(".timeline-minimap-preview")).toHaveLength(1);

    fireEvent.blur(second);
    expect(document.querySelector(".timeline-minimap-preview")).toBeNull();
    expect(second).not.toHaveAttribute("aria-describedby");

    fireEvent.click(first);
    expect(onNavigate).toHaveBeenCalledWith(0, "turn");
  });

  it("scrolls a newly active marker into a clipped rail without stealing focus", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const view = render(
      <TimelineMinimap
        activeIndex={0}
        left={24}
        markers={markers}
        onNavigate={vi.fn()}
      />,
    );
    const first = screen.getByRole("button", {
      name: "Go to turn 1: Inspect the lifecycle boundary",
    });
    const second = screen.getByRole("button", {
      name: "Go to turn 2: Verify the focused regression",
    });
    first.focus();
    scrollIntoView.mockClear();

    view.rerender(
      <TimelineMinimap
        activeIndex={4}
        left={24}
        markers={markers}
        onNavigate={vi.fn()}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(second);
    expect(first).toHaveFocus();
    expect(second).toHaveAttribute("tabindex", "0");
  });
});

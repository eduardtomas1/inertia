import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Turn 1 · Inspect the lifecycle boundary",
    );
    expect(first).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("tooltip").id,
    );

    fireEvent.pointerLeave(first);
    fireEvent.focus(first);
    expect(first).toHaveAttribute("data-emphasized", "true");
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Turn 1 · Inspect the lifecycle boundary",
    );

    fireEvent.pointerEnter(second);
    expect(first).not.toHaveAttribute("data-emphasized");
    expect(second).toHaveAttribute("data-emphasized", "true");
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Turn 2 · Verify the focused regression",
    );

    fireEvent.pointerLeave(second);
    expect(first).toHaveAttribute("data-emphasized", "true");
    expect(second).not.toHaveAttribute("data-emphasized");
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Turn 1 · Inspect the lifecycle boundary",
    );

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("data-emphasized", "true");
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);

    fireEvent.blur(second);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(second).not.toHaveAttribute("aria-describedby");

    fireEvent.click(first);
    expect(onNavigate).toHaveBeenCalledWith(0, "turn");
  });
});

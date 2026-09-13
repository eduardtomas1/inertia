import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkStatusCue } from "../../src/renderer/src/components/sidebar/WorkStatusCue";

const updatedAt = new Date(2026, 7, 11, 11, 57).toISOString();
const base = { label: "Working", updatedAt, workingSince: null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 11, 12));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded Work status cues", () => {
  it("evicts old thread statuses without replaying arrivals and retains recent observations", () => {
    const old = render(<WorkStatusCue {...base} conversationId="cache-old" status="working" />);
    old.unmount();
    const recent = render(<>{Array.from({ length: 1_024 }, (_, index) => (
      <WorkStatusCue key={index} {...base} conversationId={`cache-recent-${index}`} status="idle" />
    ))}</>);
    recent.unmount();

    const retained = render(<WorkStatusCue {...base} conversationId="cache-recent-1023" status="completed" />);
    expect(retained.container.querySelector('[data-work-status="completed"]'))
      .toHaveAttribute("data-work-arrival");
    retained.unmount();

    const evicted = render(<WorkStatusCue {...base} conversationId="cache-old" status="completed" />);
    expect(evicted.container.querySelector('[data-work-status="completed"]'))
      .not.toHaveAttribute("data-work-arrival");
    evicted.unmount();
  });

  it("does not pop on initial render or remount, and replaces the SVG for consecutive settled states", () => {
    const cue = (status: "approval" | "input") => (
      <WorkStatusCue {...base} conversationId="consecutive-arrival" status={status} />
    );
    const view = render(cue("approval"));
    expect(view.container.querySelector("[data-work-arrival]")).toBeNull();
    const previousSvg = view.container.querySelector("svg");
    view.rerender(cue("input"));
    expect(view.container.querySelector("svg")).not.toBe(previousSvg);
    expect(view.container.querySelector('[data-work-status="input"]')).toHaveAttribute("data-work-arrival");
    view.unmount();

    const remounted = render(cue("input"));
    expect(remounted.container.querySelector("[data-work-arrival]")).toBeNull();
    remounted.unmount();
  });

  it("refreshes elapsed time only while visible and removes its timer on unmount", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<WorkStatusCue {...base} conversationId="visible-clock" status="working" workingSince={updatedAt} />);
    expect(view.container).toHaveTextContent(/Working\s*·\s*3m/u);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(view.container).toHaveTextContent(/Working\s*·\s*4m/u);

    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(view.container).toHaveTextContent(/Working\s*·\s*4m/u);

    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(view.container).toHaveTextContent(/Working\s*·\s*9m/u);
    expect(view.container.querySelector("[aria-live]")).toBeNull();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

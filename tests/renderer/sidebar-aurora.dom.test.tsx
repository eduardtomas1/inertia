import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_AURORA_STEP_MS,
  SidebarAurora,
} from "../../src/renderer/src/components/sidebar/SidebarAurora";

interface FakeLayer {
  currentTime: number;
  playState: AnimationPlayState;
}

let visibility: DocumentVisibilityState;
let focused: boolean;
let layers: FakeLayer[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  visibility = "visible";
  focused = true;
  layers = [
    { currentTime: 0, playState: "paused" },
    { currentTime: 1_000, playState: "paused" },
    { currentTime: 500, playState: "paused" },
  ];
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(HTMLElement.prototype, "getAnimations")
    .mockImplementation(() => layers as unknown as Animation[]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const times = () => layers.map(({ currentTime }) => currentTime);

async function step(count = 1): Promise<void> {
  await act(async () => vi.advanceTimersByTime(SIDEBAR_AURORA_STEP_MS * count));
}

describe("sidebar aurora", () => {
  it("is inert decoration with three light layers", () => {
    const view = render(<SidebarAurora moving />);
    const aurora = view.container.querySelector(".sidebar-aurora")!;
    expect(aurora).toHaveAttribute("aria-hidden", "true");
    expect(aurora.children).toHaveLength(3);
    expect(aurora.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(0);
  });

  it("advances every layer on a coarse timer while the window is focused", async () => {
    render(<SidebarAurora moving />);
    expect(vi.getTimerCount()).toBe(1);
    await step();
    expect(times()).toEqual([125, 1_125, 625]);
    await step(7);
    expect(times()).toEqual([1_000, 2_000, 1_500]);
  });

  it("holds the light still while unfocused or hidden and resumes from the same place", async () => {
    render(<SidebarAurora moving />);
    await step(2);
    focused = false;
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(vi.getTimerCount()).toBe(0);
    await step(40);
    expect(times()).toEqual([250, 1_250, 750]);

    focused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await step();
    expect(times()).toEqual([375, 1_375, 875]);

    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    await step(40);
    expect(times()).toEqual([375, 1_375, 875]);
  });

  it("never starts without motion and stops when motion is withdrawn", async () => {
    const view = render(<SidebarAurora moving={false} />);
    expect(vi.getTimerCount()).toBe(0);
    await step(8);
    expect(times()).toEqual([0, 1_000, 500]);

    view.rerender(<SidebarAurora moving />);
    await step();
    expect(times()).toEqual([125, 1_125, 625]);
    view.rerender(<SidebarAurora moving={false} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts drifting even when the layers appear after mount", async () => {
    const pending: FakeLayer[] = [];
    const ready = layers;
    layers = pending;
    render(<SidebarAurora moving />);
    await step(2);
    layers = ready;
    await step();
    expect(times()).toEqual([0, 1_000, 500]);
    await step();
    expect(times()).toEqual([125, 1_125, 625]);
  });

  it("follows recreated animations instead of reviving cancelled ones", async () => {
    render(<SidebarAurora moving />);
    await step();
    const cancelled = layers[0]!;
    cancelled.playState = "idle";
    const replacement: FakeLayer = { currentTime: 0, playState: "paused" };
    layers = [replacement, layers[1]!, layers[2]!];
    await step();
    expect(cancelled.currentTime).toBe(125);
    await step();
    expect(replacement.currentTime).toBe(125);
    expect(cancelled.currentTime).toBe(125);
  });
});

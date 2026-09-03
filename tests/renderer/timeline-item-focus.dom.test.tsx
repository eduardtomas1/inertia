import { afterEach, describe, expect, it, vi } from "vitest";

import { startTimelineItemFocus } from "../../src/renderer/src/components/response-timeline/timeline-item-focus";

function rectangle(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  const { left, top, width, height } = input;
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function frameHarness(): {
  pending: () => number;
  runNext: () => void;
} {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    pending: () => callbacks.size,
    runNext: () => {
      const entry = callbacks.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!entry) throw new Error("No animation frame is pending.");
      callbacks.delete(entry[0]);
      entry[1](performance.now());
    },
  };
}

function fixture(): {
  root: HTMLElement;
  row: HTMLElement;
  scrollElement: HTMLElement;
} {
  const scrollElement = document.createElement("div");
  const root = document.createElement("div");
  const row = document.createElement("article");
  row.tabIndex = -1;
  row.dataset.turnId = "target-turn";
  scrollElement.append(root);
  document.body.append(scrollElement);
  scrollElement.getBoundingClientRect = () => rectangle({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  });
  row.getBoundingClientRect = () => rectangle({
    left: 20,
    top: 100,
    width: 700,
    height: 200,
  });
  return { root, row, scrollElement };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("timeline item focus settlement", () => {
  it("keeps exact virtual navigation alive until a delayed row mounts", () => {
    vi.useFakeTimers();
    const frames = frameHarness();
    const { root, row, scrollElement } = fixture();
    const scrollToIndex = vi.fn();
    const onSettled = vi.fn();
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");

    startTimelineItemFocus({
      root,
      scrollElement,
      index: 9,
      align: "center",
      virtualized: true,
      resolveTarget: (currentRoot) => {
        const target = currentRoot.querySelector<HTMLElement>(
          '[data-turn-id="target-turn"]',
        );
        return target ? { row: target, destination: target } : null;
      },
      scrollToIndex,
      onSettled,
    });

    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 12; attempt += 1) frames.runNext();
    expect(scrollToIndex).toHaveBeenCalledTimes(4);
    expect(onSettled).not.toHaveBeenCalled();

    root.append(row);
    for (let attempt = 0; attempt < 8; attempt += 1) frames.runNext();

    expect(row).toHaveFocus();
    expect(onSettled).toHaveBeenCalledWith(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a superseded request before it can steal focus", () => {
    vi.useFakeTimers();
    const frames = frameHarness();
    const { root, row, scrollElement } = fixture();
    const firstSettled = vi.fn();
    const secondSettled = vi.fn();
    const common = {
      root,
      scrollElement,
      index: 9,
      align: "center" as const,
      virtualized: true,
      scrollToIndex: vi.fn(),
    };
    const cancelFirst = startTimelineItemFocus({
      ...common,
      resolveTarget: () => null,
      onSettled: firstSettled,
    });
    cancelFirst();
    root.append(row);
    startTimelineItemFocus({
      ...common,
      resolveTarget: () => ({ row, destination: row }),
      onSettled: secondSettled,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) frames.runNext();

    expect(firstSettled).toHaveBeenCalledWith(false);
    expect(firstSettled).toHaveBeenCalledTimes(1);
    expect(secondSettled).toHaveBeenCalledWith(true);
    expect(row).toHaveFocus();
  });

  it("does not settle an overscanned row until exact navigation reveals it", () => {
    vi.useFakeTimers();
    const frames = frameHarness();
    const { root, row, scrollElement } = fixture();
    let rowTop = 700;
    row.getBoundingClientRect = () => rectangle({
      left: 20,
      top: rowTop,
      width: 700,
      height: 200,
    });
    root.append(row);
    const scrollToIndex = vi.fn();
    const onSettled = vi.fn();
    startTimelineItemFocus({
      root,
      scrollElement,
      index: 9,
      align: "center",
      virtualized: true,
      resolveTarget: () => ({ row, destination: row }),
      scrollToIndex,
      onSettled,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) frames.runNext();
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(onSettled).not.toHaveBeenCalled();
    expect(row).not.toHaveFocus();

    rowTop = 100;
    for (let attempt = 0; attempt < 7; attempt += 1) frames.runNext();
    expect(onSettled).not.toHaveBeenCalled();
    frames.runNext();
    expect(row).toHaveFocus();
    expect(onSettled).toHaveBeenCalledWith(true);
  });

  it("reasserts focus when deferred renderer work briefly claims it", () => {
    vi.useFakeTimers();
    const frames = frameHarness();
    const { root, row, scrollElement } = fixture();
    root.append(row);
    const deferredOwner = document.createElement("button");
    document.body.append(deferredOwner);
    const onSettled = vi.fn();

    startTimelineItemFocus({
      root,
      scrollElement,
      index: 9,
      align: "center",
      virtualized: true,
      resolveTarget: () => ({ row, destination: row }),
      scrollToIndex: vi.fn(),
      onSettled,
    });

    frames.runNext();
    frames.runNext();
    expect(row).toHaveFocus();
    expect(onSettled).not.toHaveBeenCalled();

    deferredOwner.focus();
    expect(deferredOwner).toHaveFocus();
    frames.runNext();
    expect(row).toHaveFocus();
    expect(onSettled).not.toHaveBeenCalled();

    for (let attempt = 0; attempt < 7; attempt += 1) frames.runNext();
    expect(row).toHaveFocus();
    expect(onSettled).toHaveBeenCalledWith(true);
  });

  it("yields immediately to direct transcript input", () => {
    vi.useFakeTimers();
    const frames = frameHarness();
    const { root, scrollElement } = fixture();
    const onSettled = vi.fn();
    startTimelineItemFocus({
      root,
      scrollElement,
      index: 9,
      align: "center",
      virtualized: true,
      resolveTarget: () => null,
      scrollToIndex: vi.fn(),
      onSettled,
    });

    document.body.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
    }));

    expect(onSettled).toHaveBeenCalledWith(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when a requested row never mounts", () => {
    vi.useFakeTimers();
    const frames = frameHarness();
    const { root, scrollElement } = fixture();
    const onSettled = vi.fn();
    startTimelineItemFocus({
      root,
      scrollElement,
      index: 9,
      align: "center",
      virtualized: true,
      resolveTarget: () => null,
      scrollToIndex: vi.fn(),
      onSettled,
    });

    for (let attempt = 0; attempt < 1_250; attempt += 1) frames.runNext();
    expect(onSettled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_250);

    expect(onSettled).toHaveBeenCalledWith(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(0);
  });
});

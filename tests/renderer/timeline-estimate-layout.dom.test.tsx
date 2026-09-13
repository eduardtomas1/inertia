import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTimelineEstimateLayout } from "../../src/renderer/src/components/response-timeline/viewport";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let width = 640;
  let measure!: () => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { measure = callback; }
    observe() {} disconnect() {}
  });
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { get: () => width });
  const ref = { current: element };
  const before = vi.fn();
  const hook = renderHook(({ conversationId }) => useTimelineEstimateLayout(ref, conversationId, before), {
    initialProps: { conversationId: "first" },
  });
  return { hook, before, resize: (value: number) => { width = value; act(() => measure()); } };
}

describe("timeline estimate measurement", () => {
  it("does not capture an old anchor for the first measurement", () => {
    const { hook, before } = fixture();
    expect(hook.result.current.availableWidth).toBe(640);
    expect(before).not.toHaveBeenCalled();
  });

  it("retains equal geometry across a conversation switch", () => {
    const { hook, before } = fixture();
    const previous = hook.result.current;
    before.mockClear();
    hook.rerender({ conversationId: "second" });
    expect(before).not.toHaveBeenCalled();
    expect(hook.result.current).toBe(previous);
  });

  it("captures once before a real resize and ignores the unchanged bucket", () => {
    const { hook, before, resize } = fixture();
    before.mockClear();
    resize(800); resize(803);
    expect(before).toHaveBeenCalledOnce();
    expect(hook.result.current.availableWidth).toBe(800);
  });
});
